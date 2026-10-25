"use strict";
/**
 * Two-way bridge between the userbot (MTProto user session) and the Bot API.
 *
 * Verified behaviour (Bot API 10.3, tested live against @hanzgdbot)
 * -----------------------------------------------------------------
 *   Bot API call                     what the userbot receives over MTProto
 *   ------------------------------   -------------------------------------
 *   sendMessage + parse_mode=HTML    text + entities + ReplyInlineMarkup  ✅
 *   sendMessage + inline_keyboard    buttons readable via msg.replyMarkup ✅
 *   sendPhoto / sendDocument         MessageMediaPhoto + caption          ✅
 *   sendRichMessage                  MessageMediaUnsupported              ❌
 *
 * `sendRichMessage` is a *bot-client* feature: the payload arrives at a user
 * session as an unsupported media type, so it can neither be read nor relayed.
 * The bridge therefore uses `sendMessage` with HTML + `reply_markup`, which is
 * the richest form a user session can actually receive and re-send.
 *
 * Flow
 * ----
 *   user ─".start"─> userbot ─"/start" (MTProto)─> @bot
 *                                                    │
 *                                            Bot API reply (sendMessage)
 *                                                    │
 *   user <──text + buttons── userbot bridge ─────────┘
 *
 * The reply is captured over MTProto (not `getUpdates`): `getUpdates` only
 * returns messages *sent to* the bot, so using it would echo our own command
 * and cause a loop.
 */
const fs = require("node:fs");

const { BOT_TOKEN, BRIDGE_BOT_USERNAME } = require("../config");
const { callApi } = require("./bot_api");

/**
 * Bot username the userbot talks to.
 * Resolution order: `USERBOT_BRIDGE_BOT` env → `bot_username` in the session
 * config → the token's own `getMe().username` (resolved lazily in `attach()`).
 */
const DEFAULT_BOT_USERNAME = BRIDGE_BOT_USERNAME || "";

/** How long a forwarded command waits for its reply. */
const PENDING_TTL_MS = Number(process.env.USERBOT_BRIDGE_TTL_MS || 60_000);

/** Minimum gap between two bridged commands from the same user. */
const USER_COOLDOWN_MS = Number(process.env.USERBOT_BRIDGE_COOLDOWN_MS || 1200);

/** Ignore bot replies older than this (prevents stale replays). */
const STALE_REPLY_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// `callApi` is re-exported below for backwards compatibility with the
// companion server and existing callers.

/* ------------------------------------------------------------------ *
 * Bridge                                                              *
 * ------------------------------------------------------------------ */
class BotBridge {
  constructor(client, options = {}) {
    this.client = client;
    this.token = options.token || BOT_TOKEN;
    this.botUsername = String(options.botUsername || DEFAULT_BOT_USERNAME).replace(/^@/, "");
    this.log = options.log !== false;

    /** Commands awaiting a bot reply (FIFO). */
    this.pending = [];
    /** Processed bot message ids (dedupe). */
    this.seen = new Map();
    /** senderId -> last command time. */
    this.cooldown = new Map();

    this.botEntity = null;
    this.botId = null;
    this.attached = false;
    this.stats = { forwarded: 0, delivered: 0, skipped: 0, duplicates: 0, errors: 0 };
  }

  info() {
    return { bot: this.botUsername, attached: this.attached, pending: this.pending.length, ...this.stats };
  }

  /**
   * Resolve the bot username from the token when none is configured, so the
   * bridge cannot silently talk to an unrelated bot (`@hanzgdbot`).
   */
  async resolveUsername() {
    if (this.botUsername) return this.botUsername;
    if (!this.token) throw new Error("BOT_TOKEN tidak tersedia dan USERBOT_BRIDGE_BOT kosong");
    const { verifyToken } = require("./bot_api");
    const result = await verifyToken(this.token);
    if (!result.ok || !result.me || !result.me.username) {
      throw new Error(`tidak dapat menentukan username bot: ${result.reason || "unknown"}`);
    }
    this.botUsername = result.me.username;
    return this.botUsername;
  }

  /** Resolve + cache the bot entity and its numeric id. */
  async entity() {
    if (this.botEntity) return this.botEntity;
    await this.resolveUsername();
    this.botEntity = await this.client.getEntity(this.botUsername);
    this.botId = String(this.botEntity.id);
    return this.botEntity;
  }

  /* ---------------------------------------------------------------- *
   * Listener (bot -> userbot)                                         *
   * ---------------------------------------------------------------- */
  /**
   * Attach a message listener that only reacts to the bridge bot.
   * Safe to call multiple times.
   */
  async attach() {
    if (this.attached) return true;
    await this.entity();
    // Keep the status line informative even when the username came from getMe.
    this.botUsername = this.botUsername || DEFAULT_BOT_USERNAME;

    const { NewMessage } = require("telegram/events");
    this.listener = async (event) => {
      try {
        await this.onMessage(event);
      } catch (err) {
        this.stats.errors += 1;
        if (this.log) console.error(`🛰️  Bridge: ${err.message}`);
      }
    };
    this.client.addEventHandler(this.listener, new NewMessage({}));
    this.attached = true;
    return true;
  }

  /** Detach the listener (shutdown). */
  detach() {
    if (this.listener && typeof this.client.removeEventHandler === "function") {
      try {
        this.client.removeEventHandler(this.listener);
      } catch {
        /* ignore */
      }
    }
    this.listener = null;
    this.attached = false;
  }

  /** Handle one incoming MTProto message; relay only the bridge bot's replies. */
  async onMessage(event) {
    const msg = event && event.message ? event.message : event;
    if (!msg || msg.id == null) return;

    // LOOP GUARD 1: never relay our own outgoing messages.
    if (msg.out === true) {
      this.stats.skipped += 1;
      return;
    }

    // LOOP GUARD 2: only messages authored by the bridge bot.
    const senderId = String(msg.senderId ?? "");
    if (!this.botId || senderId !== this.botId) return;

    // LOOP GUARD 3: never relay a command we just sent (e.g. "/start").
    const body = String(msg.message || "").trim();
    if (body.startsWith("/") && !msg.replyMarkup && !msg.media) {
      this.stats.skipped += 1;
      return;
    }

    // Deduplicate by message id.
    const key = String(msg.id);
    if (this.seen.has(key)) {
      this.stats.duplicates += 1;
      return;
    }
    this.seen.set(key, Date.now());
    if (this.seen.size > 1000) {
      const cutoff = Date.now() - PENDING_TTL_MS;
      for (const [k, at] of this.seen) if (at < cutoff) this.seen.delete(k);
    }

    // Ignore stale replies (e.g. history replay on reconnect).
    const date = msg.date instanceof Date ? msg.date : null;
    if (date && Date.now() - date.getTime() > STALE_REPLY_MS) {
      this.stats.skipped += 1;
      return;
    }

    const entry = this.claim();
    if (!entry) {
      this.stats.skipped += 1;
      return;
    }

    const sent = await this.deliver(entry, msg);
    entry.result = sent;
    entry.delivered = true;
    this.stats.delivered += 1;
    if (this.log) {
      const kind = msg.media ? msg.media.className : "text";
      console.log(`🛰️  Bridge: balasan diteruskan (${kind}) → chat ${entry.chatKey}`);
    }
  }

  /** Claim the oldest pending command (the bot answers in order). */
  claim() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this.pending = this.pending.filter((entry) => entry.createdAt >= cutoff);
    const entry = this.pending.find((item) => !item.delivered);
    if (entry) entry.delivered = true;
    return entry || null;
  }

  /* ---------------------------------------------------------------- *
   * Forwarding (userbot -> bot)                                       *
   * ---------------------------------------------------------------- */
  /**
   * Send a command to the bot and register the pending reply.
   *
   * @param {object} event     userbot event (needs chatId / senderId / id)
   * @param {string} command   e.g. `/start`
   * @param {object} [options]
   * @param {number} [options.waitMs]  wait for the reply before returning
   */
  async forward(event, command, options = {}) {
    if (!this.token) return { ok: false, reason: "no-token" };

    try {
      await this.attach();
    } catch (err) {
      this.stats.errors += 1;
      return { ok: false, reason: `bot-unreachable: ${err.message}` };
    }

    const chatKey = String(
      event?.chatId ?? event?.message?.chatId ?? event?.message?.peerId ?? "unknown",
    );
    const userId = String(event?.senderId ?? event?.message?.senderId ?? chatKey);

    const last = this.cooldown.get(userId) || 0;
    if (Date.now() - last < USER_COOLDOWN_MS) {
      this.stats.skipped += 1;
      return { ok: false, reason: "cooldown" };
    }
    this.cooldown.set(userId, Date.now());

    const entry = {
      chatKey,
      userId,
      command,
      createdAt: Date.now(),
      delivered: false,
      event,
    };

    try {
      await this.client.sendMessage(this.botEntity, {
        message: command,
        linkPreview: false,
      });
      this.pending.push(entry);
      this.stats.forwarded += 1;
    } catch (err) {
      this.stats.errors += 1;
      if (this.log) console.error(`🛰️  Bridge: gagal mengirim "${command}": ${err.message}`);
      return { ok: false, reason: err.message };
    }

    if (options.waitMs) return this.waitFor(entry, options.waitMs);
    return { ok: true, entry };
  }

  waitFor(entry, waitMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + waitMs;
      const tick = () => {
        if (entry.delivered) return resolve({ ok: true, entry });
        if (Date.now() >= deadline) return resolve({ ok: false, reason: "timeout", entry });
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /* ---------------------------------------------------------------- *
   * Delivery (userbot -> user)                                        *
   * ---------------------------------------------------------------- */
  /**
   * Re-deliver the bot's reply to the user who issued the command.
   * Keeps text formatting, inline buttons and media.
   */
  async deliver(entry, msg) {
    const chat = entry.chatKey;
    const replyTo = entry.event?.id ?? entry.event?.message?.id;

    const body = this.render(msg);
    const media = msg.media;

    // Photo / document / video: re-upload with the formatted caption.
    const fileRef = this.mediaFile(media);
    if (fileRef) {
      try {
        const buffer = await this.download(fileRef);
        return await this.client.sendFile(chat, {
          file: buffer,
          caption: body || undefined,
          parseMode: body ? "html" : undefined,
          replyTo,
          forceDocument: media && /Document/.test(media.className),
        });
      } catch (err) {
        // Fall back to text so the reply is never lost.
        if (!body) throw err;
      }
    }

    if (!body) return null;
    return this.client.sendMessage(chat, {
      message: body,
      parseMode: "html",
      replyTo,
      linkPreview: false,
    });
  }

  /** Extract a usable file reference from a GramJS media object. */
  mediaFile(media) {
    if (!media) return null;
    if (media.document) return media.document;
    if (media.photo) return media.photo;
    return null;
  }

  /** Download a GramJS media object (or a Bot API file_id) into a Buffer. */
  async download(ref) {
    if (Buffer.isBuffer(ref)) return ref;
    if (typeof ref === "string") {
      if (ref.startsWith("/") && fs.existsSync(ref)) return fs.readFileSync(ref);
      const { downloadFile } = require("./bot_api");
      return downloadFile(this.token, ref);
    }
    return this.client.downloadMedia(ref, {});
  }

  /**
   * Render text + entities + inline buttons as the HTML subset MTProto accepts.
   *
   * A user account cannot attach an `inline_keyboard`, so buttons are rendered
   * inside the text: URLs become real links, copy buttons become `<code>`
   * (tap-to-select) and callback buttons show their payload.
   */
  render(msg) {
    const text = renderEntities(msg.message || "", msg.entities || []);
    const buttons = renderButtons(msg.replyMarkup);
    return [text, buttons].filter(Boolean).join("\n\n");
  }
}

/* ------------------------------------------------------------------ *
 * Rendering helpers                                                   *
 * ------------------------------------------------------------------ */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Apply MTProto `MessageEntity*` objects to text, producing HTML.
 * Entities are applied from the end so offsets stay valid.
 */
function renderEntities(text, entities) {
  const raw = String(text || "");
  if (!raw) return "";
  if (!entities || !entities.length) return escapeHtml(raw);

  // GramJS entities carry offsets in UTF-16 code units; slice accordingly.
  const sorted = [...entities].sort((a, b) => (b.offset ?? 0) - (a.offset ?? 0));
  let out = raw;
  for (const entity of sorted) {
    const start = entity.offset ?? 0;
    const end = start + (entity.length ?? 0);
    if (end <= start) continue;
    const inner = out.slice(start, end);
    const wrapped = wrapEntity(entity, inner);
    if (wrapped != null) out = out.slice(0, start) + wrapped + out.slice(end);
  }
  return out;
}

function wrapEntity(entity, inner) {
  const type = String(entity.className || entity.type || "");
  if (/Bold/.test(type)) return `<b>${inner}</b>`;
  if (/Italic/.test(type)) return `<i>${inner}</i>`;
  if (/Underline/.test(type)) return `<u>${inner}</u>`;
  if (/Strike/.test(type)) return `<s>${inner}</s>`;
  if (/Spoiler/.test(type)) return `<tg-spoiler>${inner}</tg-spoiler>`;
  if (/Code/.test(type)) return `<code>${inner}</code>`;
  if (/Pre/.test(type)) return `<pre>${inner}</pre>`;
  if (/Blockquote/.test(type)) return `<blockquote>${inner}</blockquote>`;
  if (/TextUrl/.test(type) && entity.url) return `<a href="${escapeAttr(entity.url)}">${inner}</a>`;
  if (/MentionName/.test(type) && entity.userId) {
    return `<a href="tg://user?id=${entity.userId}">${inner}</a>`;
  }
  return null;
}

/**
 * Render a GramJS `ReplyInlineMarkup` as inline text buttons.
 * Supports URL, callback and copy-style buttons.
 */
function renderButtons(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.rows)) return "";
  const lines = [];
  for (const row of replyMarkup.rows) {
    const parts = [];
    for (const button of row.buttons || []) {
      const type = String(button.className || "");
      const label = escapeHtml(button.text || "•");
      if (/Url/.test(type) && button.url) {
        parts.push(`<a href="${escapeAttr(button.url)}">${label}</a>`);
      } else if (/Callback/.test(type) && button.data) {
        const data = Buffer.from(button.data).toString("utf8");
        parts.push(`<u>${label}</u> <code>${escapeHtml(data)}</code>`);
      } else if (/SwitchInline/.test(type)) {
        parts.push(`<u>${label}</u>`);
      } else {
        parts.push(`<u>${label}</u>`);
      }
    }
    if (parts.length) lines.push(parts.join(" · "));
  }
  if (!lines.length) return "";
  return `<blockquote>${lines.join("\n")}</blockquote>`;
}

/* ------------------------------------------------------------------ *
 * Singleton                                                           *
 * ------------------------------------------------------------------ */
let instance = null;

function createBridge(client, options = {}) {
  if (instance && instance.client === client) return instance;
  instance = new BotBridge(client, options);
  return instance;
}

function getBridge() {
  return instance;
}

module.exports = {
  BotBridge,
  createBridge,
  getBridge,
  callApi,
  escapeHtml,
  escapeAttr,
  renderEntities,
  renderButtons,
  wrapEntity,
  DEFAULT_BOT_USERNAME,
  PENDING_TTL_MS,
  USER_COOLDOWN_MS,
};

#!/usr/bin/env node
"use strict";
/**
 * Companion Bot API process: interactive menu + Inline Mode.
 *
 * Why a separate process
 * ----------------------
 * The Bot API delivers updates to exactly one consumer. The userbot itself uses
 * MTProto and never calls `getUpdates`, so this process owns the bot's update
 * stream. It handles:
 *
 *   message           → /start, /menu, /id, /inline, /send, /help
 *   callback_query    → native InlineKeyboardButton navigation (menu pages,
 *                       category jumps, running a command, closing the menu)
 *   inline_query      → @bot <keyword>  (owner only)  ← Inline Mode
 *   chosen_inline_result → audit log (Telegram already delivered the content)
 *
 * Flow (menu)
 * -----------
 *   owner ─".start"─> userbot ─"/start" (MTProto)─> @bot
 *                                                      │ getUpdates
 *                                                      ▼
 *                              sendMessage(parse_mode=HTML, inline_keyboard)
 *                                                      │
 *   owner <──HTML + native buttons── userbot bridge ────┘
 *
 *   owner taps a button ─> callback_query ─> editMessageText (same message)
 *                                        └─> answerCallbackQuery (no spinner)
 *
 * Running a command from a button cannot happen inside the bot (it has no
 * MTProto session), so it is queued in `session/menu_queue.json` and executed
 * by the userbot, which sends the command text into the requesting chat.
 *
 * Run with:  npm run bot
 */
const fs = require("node:fs");
const path = require("node:path");

const {
  BOT_TOKEN,
  BOT_LOCK_FILE,
  INLINE_LOG_FILE,
  INLINE_ENABLED,
  INLINE_MAX_RESULTS,
  INLINE_CACHE_TIME,
  INLINE_ANSWER_TIMEOUT_MS,
  resolveBotToken,
  ownerIds,
} = require("./config");
const { callApi, verifyToken, capabilities } = require("./utils/bot_api");
const inlineBot = require("./utils/inline_bot");
const catalog = require("./utils/inline_catalog");
const menu = require("./utils/menu");
const menuQueue = require("./utils/menu_queue");
const menuInline = require("./utils/menu_inline");
const delivery = require("./utils/menu_delivery");

/**
 * Token is resolved lazily (not at require time) so a token written to
 * `session/config.json` by `.inline` or `.env` is picked up by a long-running
 * process on the next call, and so importing this module never fails without a
 * token (tests, embedded use).
 */
function token() {
  return BOT_TOKEN || resolveBotToken() || "";
}
let TOKEN = token();
const POLL_TIMEOUT = Number(process.env.BOT_POLL_TIMEOUT || 25);
const ALLOWED_UPDATES = INLINE_ENABLED
  ? ["message", "callback_query", "inline_query", "chosen_inline_result"]
  : ["message", "callback_query"];

/* ------------------------------------------------------------------ *
 * Inline audit log                                                    *
 * ------------------------------------------------------------------ */
/**
 * Append one line to `logs/inline.log`.
 * Inline Mode is owner-only, so an audit trail of queries and chosen results
 * makes accidental catalogue exposure easy to spot. Logging never throws.
 */
function logInline(line) {
  console.log(`⚡ ${line}`);
  try {
    fs.mkdirSync(path.dirname(INLINE_LOG_FILE), { recursive: true });
    fs.appendFileSync(
      INLINE_LOG_FILE,
      `${new Date().toISOString()} ${line.replace(/\s+/g, " ").slice(0, 500)}\n`,
      "utf8",
    );
  } catch {
    /* a full/read-only disk must not break Inline Mode */
  }
}

/* ------------------------------------------------------------------ *
 * Single-instance lock                                                *
 * ------------------------------------------------------------------ */
/**
 * Telegram allows exactly one `getUpdates` consumer per token: a second poller
 * causes `409 Conflict` and drops updates. The lock makes `npm run bot` safe to
 * start twice (or alongside a stray previous run).
 */
function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(BOT_LOCK_FILE), { recursive: true });
    const raw = fs.existsSync(BOT_LOCK_FILE) ? fs.readFileSync(BOT_LOCK_FILE, "utf8") : "";
    const pid = Number(String(raw).trim());
    if (pid && pid !== process.pid) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        return { ok: false, reason: `proses lain (pid ${pid}) sudah memegang update stream` };
      }
    }
    fs.writeFileSync(BOT_LOCK_FILE, String(process.pid), "utf8");
    return { ok: true };
  } catch (err) {
    // An unwritable lock directory must not prevent the bot from running.
    return { ok: true, warning: err.message };
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(BOT_LOCK_FILE)) {
      const pid = Number(fs.readFileSync(BOT_LOCK_FILE, "utf8").trim());
      if (!pid || pid === process.pid) fs.rmSync(BOT_LOCK_FILE, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Bot identity                                                        *
 * ------------------------------------------------------------------ */
let me = null;

/**
 * Cached bot identity.
 * `main()` sets it at boot, but the exported handlers must also work when they
 * are called directly (tests, embedded use), so `getMe` is fetched lazily.
 */
async function botIdentity() {
  if (me) return me;
  const result = await verifyToken(token());
  if (!result.ok) throw new Error(`Token Bot API tidak valid: ${result.reason}`);
  me = result.me;
  return me;
}

/** `via @username` marker appended to every menu message. */
const viaMarker = delivery.viaMarker;

function isOwnerId(id) {
  const value = Number(id);
  if (!Number.isInteger(value)) return false;
  return ownerIds().includes(value);
}

/** Owner-only gate for menus and callbacks (fail closed). */
function ownerGate(userId) {
  const owners = ownerIds();
  if (!owners.length) {
    return {
      ok: false,
      reason:
        "Owner belum terdaftar. Jalankan <code>.inline owner &lt;user_id&gt;</code> dari userbot, " +
        "atau set <code>USERBOT_OWNER_ID</code>.",
    };
  }
  if (!isOwnerId(userId)) {
    return { ok: false, reason: "Menu ini hanya untuk owner akun." };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Menu rendering / sending                                            *
 * ------------------------------------------------------------------ */
/**
 * Render one menu page: HTML text + native keyboard + via marker.
 * Both `sendMessage` and `editMessageText` use this so a page edit can never
 * drop the keyboard or change the layout.
 */
function renderMenu(page, username) {
  const payload = delivery.buildPayload(page, username);
  return { text: payload.text, keyboard: payload.reply_markup };
}

/**
 * Send a menu page as a new message.
 * `parse_mode: "HTML"` + `InlineKeyboardMarkup` — the documented Bot API way.
 */
async function sendMenu(chatId, page, username, extra = {}) {
  const { text, keyboard } = renderMenu(page, username);
  return callApi(TOKEN, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/** Edit an arbitrary message into a page (used by `/start` on an old message). */
async function editMenuMessage(chatId, messageId, page, username) {
  return delivery.editMenuAsBot({ chatId, messageId, page, token: TOKEN });
}

/**
 * Edit the message a callback belongs to (never sends a duplicate).
 * Falls back to a fresh message when the original cannot be edited (too old,
 * deleted, or a media message).
 */
async function editMenu(callbackQuery, page, username) {
  const message = callbackQuery.message;
  const { text, keyboard } = renderMenu(page, username);
  if (message) {
    try {
      return await callApi(TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (!/not modified/i.test(err.message)) {
        console.warn(`⚠️  editMessageText gagal (${err.message}); mengirim pesan baru.`);
      } else {
        return message;
      }
    }
  }
  return sendMenu(message ? message.chat.id : callbackQuery.from.id, page, username);
}

/**
 * Edit the message a callback belongs to, keeping it a **Rich Message**.
 *
 * Two shapes are supported (verified live with `messages.getBotCallbackAnswer`):
 *   inline  → `{ inline_message_id }`   (menu sent through `.start` inline mode)
 *   regular → `{ chat_id, message_id }` (menu sent by the bot itself)
 *
 * `editMessageText` accepts either `text` or `rich_message` — never both — so the
 * rich payload is tried first and the HTML payload is the fallback.
 *
 * @returns {Promise<{ok: boolean, format?: string, reason?: string}>}
 */
async function editMessageRich({ callbackQuery, page, feature, username }) {
  const inlineId = callbackQuery.inline_message_id;
  const message = callbackQuery.message;
  if (!inlineId && !message) return { ok: false, reason: "no-target" };

  const target = inlineId
    ? { inline_message_id: inlineId }
    : { chat_id: message.chat.id, message_id: message.message_id };

  const rendered = feature
    ? menu.renderFeature(feature, { botUsername: username })
    : null;
  if (feature && !rendered) return { ok: false, reason: "unknown-feature" };

  const keyboard = rendered ? rendered.keyboard : menu.buildKeyboard(page);
  // Rich HTML keeps `<details>`/`<tg-button-row>`; the plain HTML fallback below
  // uses only tags the `parse_mode: "HTML"` parser accepts.
  const richHtml = rendered
    ? `${rendered.html}${menu.buttonRowsHtml(rendered.keyboard)}`
    : menu.renderRichHtml(page, { botUsername: username });
  const fallbackHtml = rendered
    ? rendered.fallback
    : menu.truncateHtml(menu.renderPageHtml(menu.normalizePage(page)) + delivery.viaMarker(username));

  try {
    await callApi(TOKEN, "editMessageText", {
      ...target,
      rich_message: { html: richHtml },
      ...(inlineId ? {} : { reply_markup: keyboard }),
      link_preview_options: { is_disabled: true },
    });
    return { ok: true, format: "rich" };
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return { ok: true, format: "rich" };
    console.warn(`⚠️  edit rich gagal (${err.message}); memakai HTML.`);
  }

  try {
    await callApi(TOKEN, "editMessageText", {
      ...target,
      text: fallbackHtml,
      parse_mode: "HTML",
      ...(inlineId ? {} : { reply_markup: keyboard }),
      link_preview_options: { is_disabled: true },
    });
    return { ok: true, format: "html" };
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return { ok: true, format: "html" };
    return { ok: false, reason: err.message };
  }
}

/** Acknowledge a callback so Telegram stops the loading spinner. */
async function answerCallback(id, text, alert = false) {
  if (!id) return null;
  try {
    return await callApi(TOKEN, "answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text: String(text).slice(0, 200) } : {}),
      ...(alert ? { show_alert: true } : {}),
    });
  } catch {
    // A stale callback id is harmless; never fail the update for it.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Callback handling                                                   *
 * ------------------------------------------------------------------ */
/**
 * Handle one native `callback_query`.
 *
 *   m:page:<n>      navigate to page n (edit in place)
 *   m:main          back to the overview
 *   m:cat:<key>     jump to a category page
 *   cmd:<command>   run that command through the userbot
 *   m:close         remove the menu message
 *
 * Every branch answers the callback first, so the client never shows a spinner
 * stuck for the 30-second timeout.
 *
 * @returns {Promise<{type: string, action?: string, page?: number}>}
 */
async function handleCallback(callbackQuery) {
  const fromId = callbackQuery.from && callbackQuery.from.id;
  const data = String(callbackQuery.data || "");
  const parsed = menu.parseCallback(data);
  const username = (await botIdentity()).username;

  // Navigation and public features are open to everyone. Only an action that
  // actually runs an owner-only feature is gated, so a stranger can still browse
  // the menu and read what each feature does.
  if (!isOwnerId(fromId)) {
    if (parsed.action === "cmd") {
      const entry = menu.findCommand(parsed.value);
      if (entry && entry.access !== "public") {
        await answerCallback(callbackQuery.id, "Fitur ini khusus owner akun", true);
        return { type: "callback_query", action: "locked", command: entry.base };
      }
    }
    if (parsed.action === "locked") {
      await answerCallback(callbackQuery.id, "Fitur ini khusus owner akun", true);
      return { type: "callback_query", action: "locked" };
    }
  }

  try {
    if (parsed.action === "close") {
      await answerCallback(callbackQuery.id, "Menu ditutup");
      await menuInline.deleteMenuFromCallback(TOKEN, callbackQuery);
      return { type: "callback_query", action: "close" };
    }

    if (parsed.action === "help") {
      await answerCallback(callbackQuery.id);
      const edited = await menuInline.editMenuFromCallback(TOKEN, callbackQuery, 0, {
        botUsername: username,
      });
      if (!edited.ok) await editMenu(callbackQuery, 0, username);
      return { type: "callback_query", action: "help", page: 0 };
    }

    if (parsed.action === "cmd") {
      return await runCommandCallback(callbackQuery, parsed.value, username);
    }

    if (parsed.action === "feat") {
      // One feature: description + format + Jalankan/Kembali buttons.
      const rendered = menu.renderFeature(parsed.value, { botUsername: username });
      if (!rendered) {
        await answerCallback(callbackQuery.id, "Fitur tidak dikenal", true);
        return { type: "callback_query", action: "feat-unknown", feature: parsed.value };
      }
      await answerCallback(callbackQuery.id, rendered.item.base);
      const edited = await editMessageRich({
        callbackQuery,
        feature: parsed.value,
        username,
      });
      if (!edited.ok && callbackQuery.message) {
        await sendMenu(callbackQuery.from.id, rendered.page, username);
      }
      return { type: "callback_query", action: "feat", feature: parsed.value, format: edited.format };
    }

    if (parsed.action === "page" || parsed.action === "cat" || parsed.action === "main") {
      const page = menu.normalizePage(parsed.page);
      await answerCallback(callbackQuery.id, `Halaman ${page === 0 ? "menu" : page}`);
      // Works for both inline messages (`inline_message_id`, no `message`) and
      // regular bot messages; rich edit first, HTML fallback second.
      const edited = await editMessageRich({ callbackQuery, page, username });
      if (!edited.ok && callbackQuery.message) {
        await editMenu(callbackQuery, page, username);
      }
      return { type: "callback_query", action: parsed.action, page, format: edited.format };
    }

    await answerCallback(callbackQuery.id, "Tombol tidak dikenal", true);
    return { type: "callback_query", action: "unknown" };
  } catch (err) {
    console.error(`⚠️  callback ${data}: ${err.message}`);
    await answerCallback(callbackQuery.id, "Gagal memproses tombol", true);
    return { type: "callback_query", action: "error", error: err.message };
  }
}

/**
 * Run a catalogue command picked from a button.
 *
 * The bot cannot execute userbot commands (no MTProto session), so the command
 * is queued for the userbot, which sends it into the same chat. The callback is
 * answered with an instruction so the owner knows what happens next.
 */
async function runCommandCallback(callbackQuery, commandName, username) {
  const entry = menu.findCommand(commandName);
  // A menu opened through Inline Mode has no `message`; the command must run in
  // the chat the owner tapped from, which for inline messages is the DM with the
  // bot (the only chat the bot can address on the owner's behalf here).
  const chatId = callbackQuery.message
    ? callbackQuery.message.chat.id
    : callbackQuery.from.id;

  if (!entry) {
    await answerCallback(callbackQuery.id, `Command ${commandName} tidak dikenal`, true);
    return { type: "callback_query", action: "cmd-unknown", command: commandName };
  }

  // A command with an argument cannot run from a bare button: open its detail
  // page, which carries the paste-ready format and a "Kembali" button.
  if (menu.needsArgument(entry)) {
    const page = menu.SECTIONS.findIndex((section) => section.key === entry.section) + 1;
    await answerCallback(callbackQuery.id, `${entry.base} butuh argumen`);
    const edited = await editMessageRich({
      callbackQuery,
      feature: entry.base,
      username,
    });
    if (!edited.ok && callbackQuery.message) {
      await sendMenu(callbackQuery.message.chat.id, page, username);
    }
    return { type: "callback_query", action: "cmd-format", command: entry.base, format: edited.format };
  }

  try {
    menuQueue.enqueue({
      chatId,
      messageId: callbackQuery.message ? callbackQuery.message.message_id : null,
      action: entry.base,
      requestedBy: callbackQuery.from.id,
    });
  } catch (err) {
    await answerCallback(callbackQuery.id, `Gagal menjalankan: ${err.message}`, true);
    return { type: "callback_query", action: "cmd-error", command: entry.base };
  }

  await answerCallback(callbackQuery.id, `${entry.base} dijalankan…`);
  // Keep the menu usable: show the command's page with a status line on top.
  // Works for both inline messages (inline_message_id) and regular bot messages.
  try {
    const page = menu.SECTIONS.findIndex((section) => section.key === entry.section) + 1;
    const status = `<b>▶️ ${menu.esc(entry.base)}</b> sedang dijalankan…\n\n`;
    const inlineId = callbackQuery.inline_message_id;
    if (inlineId) {
      await callApi(TOKEN, "editMessageText", {
        inline_message_id: inlineId,
        text: menu.truncateHtml(status + menu.renderPageHtml(menu.normalizePage(page))),
        parse_mode: "HTML",
        reply_markup: menu.buildKeyboard(page),
        link_preview_options: { is_disabled: true },
      });
    } else if (callbackQuery.message) {
      const { text, keyboard } = renderMenu(page, username);
      await callApi(TOKEN, "editMessageText", {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: menu.truncateHtml(status + text),
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    }
  } catch {
    /* the status edit is cosmetic; the command was already queued */
  }
  return { type: "callback_query", action: "cmd", command: entry.base };
}

/* ------------------------------------------------------------------ *
 * Message commands                                                    *
 * ------------------------------------------------------------------ */
/** `/inline` — status of the catalogue, owner only. */
async function inlineStatus(chatId, fromId) {
  if (fromId != null && !isOwnerId(fromId)) {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ Perintah ini hanya untuk owner.",
    });
    return "denied";
  }
  const stats = catalog.stats();
  const owners = ownerIds();
  const self = await botIdentity();
  await callApi(TOKEN, "sendMessage", {
    chat_id: chatId,
    text: [
      "<b>🗂️ Inline Mode</b>",
      `• Bot: <code>@${menu.esc(self.username)}</code>`,
      `• Inline: ${self.supports_inline_queries ? "✅ aktif" : "❌ belum aktif (/setinline)"}`,
      `• Katalog: <code>${stats.total}</code> item`,
      `• Media siap: <code>${stats.uploaded}</code> · belum diunggah: <code>${stats.pending}</code>`,
      `• Owner terdaftar: <code>${owners.length ? owners.join(", ") : "belum ada"}</code>`,
      "",
      `Coba: ketik <code>@${menu.esc(self.username)} kata kunci</code> di chat mana pun.`,
      "Kelola katalog dari userbot: <code>.inline</code>",
    ].join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return "inline";
}

/** `/send <id> [chat]` — deliver catalogue content as the bot. */
async function sendItem(chatId, fromId, args) {
  if (!isOwnerId(fromId)) {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "❌ Perintah ini hanya untuk owner.",
    });
    return;
  }
  const [id, target] = String(args || "").trim().split(/\s+/);
  if (!id) {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: "Format: <code>/send &lt;id&gt; [chat_id|@username]</code>",
      parse_mode: "HTML",
    });
    return;
  }
  const item = catalog.get(id);
  if (!item) {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: `❌ Item <code>${menu.esc(id)}</code> tidak ditemukan.`,
      parse_mode: "HTML",
    });
    return;
  }
  try {
    const sent = await inlineBot.sendItemAsBot(TOKEN, item, target || chatId);
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: `✅ Terkirim: <b>${inlineBot.escapeHtml(item.title)}</b> (message_id <code>${sent.message_id}</code>)`,
      parse_mode: "HTML",
    });
  } catch (err) {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: `❌ Gagal mengirim: ${inlineBot.escapeHtml(err.message)}`,
      parse_mode: "HTML",
    });
  }
}

async function handle(update) {
  // Refresh the token so a value written to config after boot is honoured.
  TOKEN = token();

  // ---- Native buttons ----------------------------------------------
  if (update.callback_query) {
    return handleCallback(update.callback_query);
  }

  // ---- Inline Mode: `.start` / `.help` rich messages -----------------
  if (update.inline_query && menuInline.parseRichQuery(update.inline_query.query)) {
    const gate = ownerGate(update.inline_query.from && update.inline_query.from.id);
    if (!gate.ok) {
      await callApi(TOKEN, "answerInlineQuery", {
        inline_query_id: update.inline_query.id,
        results: [],
        cache_time: 0,
        is_personal: true,
      }).catch(() => {});
      return { type: "inline_query", action: "denied" };
    }
    const self = await botIdentity();
    const answered = await menuInline.answerRichQuery(TOKEN, update.inline_query, {
      botUsername: self.username,
      log: (line) => console.warn(`⚠️  ${line}`),
    });
    console.log(`📨 inline ${answered.kind} -> ${answered.mode}`);
    return { type: "inline_query", action: answered.kind, mode: answered.mode };
  }

  // ---- Inline Mode: the `.start` menu itself ------------------------
  if (update.inline_query) {
    const parsed = menuInline.parseMenuQuery(update.inline_query.query);
    if (parsed.isMenu) {
      const gate = ownerGate(update.inline_query.from && update.inline_query.from.id);
      const self = await botIdentity();
      if (!gate.ok) {
        // Menu is owner-only: answer empty so nothing leaks.
        await callApi(TOKEN, "answerInlineQuery", {
          inline_query_id: update.inline_query.id,
          results: [],
          cache_time: 0,
          is_personal: true,
        }).catch(() => {});
        return { type: "inline_query", action: "denied" };
      }
      const answered = await menuInline.answerMenuQuery(TOKEN, update.inline_query, {
        botUsername: self.username,
      });
      console.log(`📨 inline menu -> halaman ${answered.page}`);
      return { type: "inline_query", action: "menu", page: answered.page };
    }
  }

  // ---- Inline Mode: catalogue --------------------------------------
  if (update.inline_query || update.chosen_inline_result) {
    return inlineBot.handleUpdate(TOKEN, update, {
      log: logInline,
      owners: ownerIds(),
      limit: INLINE_MAX_RESULTS,
      cacheTime: INLINE_CACHE_TIME,
      // Telegram drops late answers; fail fast instead of holding the poll loop.
      signal: AbortSignal.timeout(INLINE_ANSWER_TIMEOUT_MS),
    });
  }

  const msg = update.message;
  if (!msg || !msg.text) return null;

  const chatId = msg.chat.id;
  const fromId = msg.from && msg.from.id;
  const text = msg.text.trim();
  const command = text.split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
  const args = text.slice(text.split(/\s+/)[0].length).trim();

  if (command === "/start" || command === "/menu") {
    const self = await botIdentity();
    // The menu itself is public: anyone may browse it and read what each
    // feature does. Only running an owner-only feature is gated, per button.
    const arg = String(args || "").trim().toLowerCase();
    let page = 0;
    if (arg === "all") page = 0;
    else if (arg && /^\d+$/.test(arg)) page = menu.normalizePage(Number(arg));
    await sendMenu(chatId, page, self.username, {
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    });
    console.log(`📨 /start -> chat ${chatId} (halaman ${page})`);
    return "menu";
  }
  if (command === "/id") {
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: `Chat ID: <code>${chatId}</code>\nUser ID: <code>${fromId}</code>`,
      parse_mode: "HTML",
    });
    return "id";
  }
  if (command === "/inline") {
    return inlineStatus(chatId, fromId);
  }
  if (command === "/send") {
    await sendItem(chatId, fromId, args);
    return "send";
  }
  if (command === "/help") {
    const self = await botIdentity();
    await callApi(TOKEN, "sendMessage", {
      chat_id: chatId,
      text: [
        "<b>🤖 Perintah Bot</b>",
        "<b>/start</b> — menu interaktif (tombol native)",
        "<b>/id</b> — chat &amp; user id",
        "<b>/inline</b> — status katalog inline",
        "<b>/send</b> <code>&lt;id&gt; [chat]</code> — kirim konten sebagai bot (owner)",
        "",
        `<b>Inline Mode</b>: ketik <code>@${menu.esc(self.username)} kata kunci</code> di chat mana pun.`,
        "<i>Menu memakai parse_mode HTML + InlineKeyboardMarkup resmi Telegram.</i>",
      ].join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return "help";
  }
  // Unknown command: open the menu so the conversation is never dead.
  const self = await botIdentity();
  if (ownerGate(fromId).ok) {
    await sendMenu(chatId, 0, self.username);
    return "menu";
  }
  return "ignored";
}

/* ------------------------------------------------------------------ *
 * Main loop                                                           *
 * ------------------------------------------------------------------ */
async function main() {
  TOKEN = token();
  if (!TOKEN) {
    console.error("❌ BOT_TOKEN belum diset. Contoh: export BOT_TOKEN='123456:ABC…'");
    process.exit(1);
  }

  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`❌ Tidak dapat memulai: ${lock.reason}.`);
    console.error("   Hentikan proses tersebut atau hapus session/bot_poll.lock bila sudah mati.");
    process.exit(1);
  }
  if (lock.warning) console.warn(`⚠️  Lock: ${lock.warning}`);

  const verified = await verifyToken(TOKEN);
  if (!verified.ok) {
    console.error(`❌ Token Bot API tidak valid: ${verified.reason}`);
    releaseLock();
    process.exit(1);
  }
  me = verified.me;
  const caps = capabilities(me);

  console.log(`🤖 Companion Bot API aktif: @${caps.username} (${caps.id})`);
  console.log(`   Menu        : parse_mode HTML + InlineKeyboardMarkup (${menu.PAGE_COUNT} halaman)`);
  console.log(`   Inline Mode : ${caps.inline ? "✅ aktif" : "❌ belum aktif (BotFather → /setinline)"}`);
  console.log(`   Katalog     : ${catalog.stats().total} item`);
  if (!ownerIds().length) {
    console.log("   ⚠️  owner_id belum diset → menu & Inline Mode akan menolak semua permintaan.");
    console.log("       Jalankan `.inline owner <user_id>` dari userbot sekali.");
  }

  if (INLINE_ENABLED) {
    const ready = await inlineBot.assertInlineReady(TOKEN, me);
    if (!ready.ok) console.log(`   ⚠️  ${ready.reason}`);
  }

  // getUpdates requires no webhook.
  try {
    await callApi(TOKEN, "deleteWebhook", { drop_pending_updates: false });
  } catch (err) {
    console.warn(`⚠️  deleteWebhook: ${err.message}`);
  }

  let offset = 0;
  let running = true;
  let conflicts = 0;

  const shutdown = () => {
    running = false;
    releaseLock();
    console.log("\n👋 Companion bot dihentikan.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", releaseLock);

  while (running) {
    try {
      const updates = await callApi(
        TOKEN,
        "getUpdates",
        { offset, timeout: POLL_TIMEOUT, allowed_updates: ALLOWED_UPDATES },
        { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) },
      );
      conflicts = 0;
      for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await handle(update);
        } catch (err) {
          console.error("⚠️  Gagal memproses update:", err.message);
        }
      }
    } catch (err) {
      if (!running) break;
      if (/409|Conflict|terminated by other getUpdates/i.test(err.message)) {
        conflicts += 1;
        console.error(
          `⚠️  Konflik getUpdates (${conflicts}): proses lain memakai token yang sama. ` +
            "Hentikan instance lain.",
        );
        await new Promise((r) => setTimeout(r, Math.min(30_000, 5000 * conflicts)));
        continue;
      }
      console.error("⚠️  Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    releaseLock();
    console.error("❌", err.message);
    process.exit(1);
  });
}

module.exports = {
  logInline,
  renderMenu,
  sendMenu,
  editMenu,
  answerCallback,
  editMenuMessage,
  handleCallback,
  runCommandCallback,
  handle,
  inlineStatus,
  sendItem,
  isOwnerId,
  ownerGate,
  botIdentity,
  acquireLock,
  releaseLock,
  MENU_PAGES: menu.PAGE_COUNT,
  CATEGORIES: menu.SECTIONS,
  TOTAL: menu.TOTAL_COMMANDS,
};

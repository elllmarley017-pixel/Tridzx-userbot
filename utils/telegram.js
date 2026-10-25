"use strict";
/**
 * Thin compatibility layer over GramJS.
 *
 * The Python handlers were written against Telethon's ergonomics
 * (`event.chat_id`, `event.pattern_match`, `client.on(...)` decorators). This
 * module provides those same affordances so the ported handlers stay a
 * line-for-line match of the originals.
 */
const { TelegramClient, Api } = require("telegram");
const { NewMessage } = require("telegram/events");
const { CustomFile } = require("telegram/client/uploads");

/**
 * Register a command handler in the Telethon style.
 *
 * Mirrors `@client.on(events.NewMessage(pattern=r"...", outgoing=True))`.
 * GramJS handles the `pattern` itself; the callback then receives an event
 * whose `patternMatch` exposes `group(index)` / `group(0)` just like Telethon.
 *
 * Both directions are observed so the bot also answers *other* users who
 * interact with the account. Authorization is then enforced centrally by
 * `utils/permissions.js`:
 *   - `owner`  commands (mass messaging, history export, sticker pack, AI…)
 *     only run for the account owner;
 *   - `public` commands run for anyone, behind a per-user cooldown.
 *
 * @param {TelegramClient} client
 * @param {RegExp} pattern  Anchored (`^`) patterns are recommended.
 * @param {(event: object) => Promise<void>} callback
 * @param {object} [options]
 * @param {boolean} [options.outgoing]   accept the owner's own messages (default true)
 * @param {boolean} [options.incoming]   accept messages from other users (default true)
 * @param {boolean} [options.ownerOnly]  force owner-only, regardless of policy
 * @param {boolean} [options.bypassAuth] skip the permission gate entirely
 */
function command(client, pattern, callback, options = {}) {
  // Both directions by default: `outgoing` is what a userbot reacts to, and
  // `incoming` is required for the bot to serve other users.
  const { outgoing = true, incoming = true, ownerOnly = false, bypassAuth = false } = options;
  const filter = {};
  // We match the pattern ourselves (after trimming) so trailing whitespace and
  // `\r` from mobile clients can't silently break routing. GramJS's built-in
  // `pattern` filter would otherwise drop those messages entirely.
  if (outgoing && incoming) {
    // NewMessage rejects `incoming === outgoing` when both are set, so leave
    // both undefined to observe every direction.
  } else if (incoming) {
    filter.incoming = true;
  } else if (outgoing) {
    filter.outgoing = true;
  }
  filter.func = (event) => {
    if (!pattern) return true;
    const text = eventRawText(event).replace(/\s+$/, "");
    return pattern.test(text) || Boolean(event?.message?.patternMatch);
  };

  const handler = async (event) => {
    const text = eventRawText(event).replace(/\s+$/, "");
    const gramMatch = event?.message?.patternMatch || null;
    event.patternMatch = createPatternMatch(pattern, text, gramMatch);
    // Give handlers a client-aware responder without changing their signatures.
    // `editMarkdown(event, ...)` resolves this via `event.__client`.
    try {
      Object.defineProperty(event, "__client", {
        value: client,
        enumerable: false,
        configurable: true,
      });
    } catch {
      event.__client = client;
    }

    if (!bypassAuth) {
      const verdict = await checkPermission(client, event, { ownerOnly });
      if (!verdict.allowed) {
        await notifyDenied(client, event, verdict);
        return undefined;
      }
      event.__auth = verdict;
    }

    try {
      return await callback(event);
    } catch (err) {
      // A thrown handler error would otherwise be swallowed by GramJS's update
      // loop and the user would just see silence. Surface it instead.
      await reportHandlerError(client, event, err);
    }
  };
  client.addEventHandler(handler, new NewMessage(filter));
  // Expose the raw callback so callers that already hold an event (the menu
  // queue worker sends a message and must run the command deterministically,
  // without waiting for the update poller) can invoke it directly.
  handler.__callback = callback;
  handler.__filter = filter;
  handler.__pattern = pattern || null;
  handler.__options = options;
  rememberHandler(client, handler);
  return handler;
}

/* ------------------------------------------------------------------ *
 * Direct dispatch                                                     *
 * ------------------------------------------------------------------ */
/**
 * Registry of handlers registered through `command()`.
 * `dispatchCommandText` uses it to run a command straight from an event the
 * caller already has, instead of relying on `updates.getDifference`.
 */
const REGISTRY = new WeakMap();

/**
 * Execute every registered command handler that matches `text` against a
 * synthetic event. Used by the interactive menu: a native button asks the bot
 * to run a command, the bot queues it, and the userbot executes it here.
 *
 * Why not just send the text and let the poller pick it up?
 * ---------------------------------------------------------
 * Telegram does not reliably echo channel posts back through
 * `updates.getDifference` with `out: true`, so a `.infobot` posted by the bot
 * into a channel was logged as SUCCESS but never answered. Dispatching the
 * event we just sent removes that dependency entirely.
 *
 * @param {object} client
 * @param {object} event   GramJS-like event (needs `.message`)
 * @returns {Promise<number>} how many handlers matched
 */
async function dispatchCommandText(client, event) {
  const handlers = REGISTRY.get(client);
  if (!handlers || !handlers.length) return 0;
  const text = eventRawText(event).replace(/\s+$/, "");
  let matched = 0;
  for (const handler of handlers) {
    try {
      const filter = handler.__filter || {};
      if (typeof filter.func === "function" && !filter.func(event)) continue;
      if (filter.incoming === true && event.message && event.message.out === true) continue;
      if (filter.outgoing === true && event.message && event.message.out !== true) continue;
      await handler.__callback(event);
      matched += 1;
    } catch (err) {
      console.error("❌ dispatch error:", err.message);
    }
  }
  void text;
  return matched;
}

/**
 * Run one feature directly from a Rich Button tap: no command text, no
 * message in the chat.
 *
 * The tap arrives at the Bot API process, which cannot touch the MTProto
 * session, so it is queued and executed here. The synthetic event carries the
 * callback's own chat/message ids so replies land where the button was pressed
 * and `editMarkdown` updates the message the user is looking at.
 *
 * @param {object} client
 * @param {object} action
 * @param {string} action.command   base command (`".ytmp4"`), used to find the handler
 * @param {number|string} action.chatId
 * @param {number} [action.messageId]  message the tap came from
 * @param {string} [action.arg]        optional argument captured from the user
 * @param {number} [action.userId]     who pressed the button
 * @returns {Promise<{ok: boolean, handled: number, reason?: string}>}
 */
async function runAction(client, action = {}) {
  const handlers = REGISTRY.get(client);
  if (!handlers || !handlers.length) return { ok: false, handled: 0, reason: "no-handlers" };

  const chat = action.chatId;
  if (chat == null) return { ok: false, handled: 0, reason: "no-chat" };

  const base = String(action.command || "").trim();
  if (!base) return { ok: false, handled: 0, reason: "no-command" };

  const arg = String(action.arg || "").trim();
  const text = arg ? `${base} ${arg}` : base;

  const sender = action.userId != null ? action.userId : null;
  const event = {
    chatId: chat,
    id: action.messageId != null ? action.messageId : undefined,
    senderId: sender,
    rawText: text,
    text,
    // A button press has no reply, so handlers that need one answer with their
    // own "reply a photo first" hint instead of throwing.
    isReply: false,
    replyToMsgId: null,
    message: {
      id: action.messageId,
      chatId: chat,
      peerId: chat,
      rawText: text,
      text,
      out: false,
      senderId: sender,
      isReply: false,
      replyToMsgId: null,
      getReplyMessage: async () => null,
    },
    __fromButton: true,
  };

  // Handlers resolve their responder through `event.__client`
  // (`editMarkdown` → `message.__client`). Without it every reply silently
  // failed, which looked like "no output" and like a false "Media Tidak Valid".
  try {
    Object.defineProperty(event, "__client", {
      value: client,
      enumerable: false,
      configurable: true,
    });
  } catch {
    event.__client = client;
  }
  if (event.message) {
    try {
      Object.defineProperty(event.message, "__client", {
        value: client,
        enumerable: false,
        configurable: true,
      });
    } catch {
      event.message.__client = client;
    }
  }

  let matched = 0;
  let lastError = null;
  for (const handler of handlers) {
    const pattern = handler.__pattern;
    if (!pattern) continue;
    // Match on the base command only: the argument is optional for the pattern,
    // and a handler that requires one answers with its own usage hint.
    const hit = pattern.test(base) || pattern.test(text);
    if (!hit) continue;
    try {
      await handler.__callback(event);
      matched += 1;
    } catch (err) {
      lastError = err;
      console.error(`❌ aksi ${base}: ${err.message}`);
    }
  }
  if (!matched) return { ok: false, handled: 0, reason: "no-handler", error: lastError?.message };
  return { ok: true, handled: matched };
}

/** Register `client` in the dispatch registry (called by `command()`). */
function rememberHandler(client, handler) {
  const list = REGISTRY.get(client) || [];
  list.push(handler);
  REGISTRY.set(client, list);
  return handler;
}

/**
 * Run the permission gate, tolerating a permissions module that is missing or
 * broken (a policy bug must never take every command down).
 */
async function checkPermission(client, event, { ownerOnly = false } = {}) {
  let permissions;
  try {
    permissions = require("./permissions");
  } catch {
    return { allowed: true, level: "unknown", owner: true };
  }
  try {
    const verdict = await permissions.authorize(client, event);
    if (ownerOnly && verdict.owner !== true) {
      return { ...verdict, allowed: false, reason: "owner-only" };
    }
    return verdict;
  } catch {
    return { allowed: true, level: "unknown", owner: true };
  }
}

/** Tell the sender why a command was refused (de-duplicated per chat). */
async function notifyDenied(client, event, verdict) {
  try {
    const { shouldNotifyDenial } = require("./permissions");
    const chat = chatId(event);
    if (chat == null) return;
    if (!shouldNotifyDenial(`${chat}:${verdict.reason}`)) return;

    const { errorMessage, rateLimitMessage } = require("./formatting");
    let text;
    if (verdict.reason === "cooldown") {
      const seconds = Math.max(1, Math.ceil((verdict.retryAfterMs || 0) / 1000));
      text = rateLimitMessage(seconds, {
        action: verdict.name,
        footer: "Cooldown per pengguna untuk mencegah spam.",
      });
    } else {
      text = errorMessage(
        `Command ${verdict.name || "ini"} hanya dapat dijalankan oleh pemilik akun.`,
        "Akses Ditolak",
      );
    }
    await client.sendMessage(chat, {
      message: text,
      parseMode: PARSE_MODE_FOR_ERRORS,
      replyTo: messageId(event),
    });
  } catch {
    /* denial notices must never throw */
  }
}

/**
 * Extract the raw text of an incoming message, tolerating both the GramJS
 * `NewMessageEvent` shape (`.message`) and a bare `Api.Message`.
 */
function eventRawText(event) {
  if (!event) return "";
  const message = event.message || event;
  return (
    message.rawText ??
    message.text ??
    event.rawText ??
    event.text ??
    ""
  );
}

/** Best-effort user-facing error report so commands never fail silently. */
async function reportHandlerError(client, event, err) {
  const message = String((err && err.message) || err || "Terjadi kesalahan");
  // eslint-disable-next-line no-console
  console.error("❌ Command error:", message);
  try {
    const { errorMessage } = require("./formatting");
    const chat = chatId(event);
    if (chat == null) return;
    await client.sendMessage(chat, {
      message: errorMessage(message, "Terjadi Kesalahan"),
      parseMode: PARSE_MODE_FOR_ERRORS,
      replyTo: messageId(event),
    });
  } catch {
    /* reporting must never throw */
  }
}

const PARSE_MODE_FOR_ERRORS = "html";

function createPatternMatch(pattern, text, fallbackMatch) {
  if (!pattern) return { group: () => undefined, input: text || "", match: null };
  let match = null;
  try {
    match = String(text == null ? "" : text).match(pattern);
  } catch {
    match = null;
  }
  if (!match && fallbackMatch) match = fallbackMatch;
  return {
    match,
    input: text || "",
    group(index) {
      if (!match) return undefined;
      return match[index];
    },
  };
}

/** `event.get_sender()` -> `event.getSender()`. */
const getSender = (event) => event.getSender();

/** Convert GramJS bigint ids into plain strings like Telethon printed them. */
function toIdString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return String(value);
}

function chatId(event) {
  return event?.chatId ?? event?.message?.chatId ?? event?.message?.peerId ??
    event?.originalUpdate?.message?.peerId;
}

function senderId(event) {
  return toIdString(event.senderId ?? event.message?.senderId);
}

function messageId(event) {
  return event.id ?? event.message?.id;
}

function messageText(event) {
  return eventRawText(event);
}

/** Build a CustomFile for uploads from a local path. */
function fileFromPath(filePath, fs = require("node:fs"), path = require("node:path")) {
  const stat = fs.statSync(filePath);
  return new CustomFile(path.basename(filePath), stat.size, filePath);
}

function bufferFile(buffer, name) {
  const file = new CustomFile(name, buffer.length, "", buffer);
  return file;
}

/** Map Telethon `DocumentAttributeAudio` to the GramJS equivalent. */
function audioAttributes({ title, performer, duration = 0, voice = false } = {}) {
  return [
    new Api.DocumentAttributeAudio({
      duration,
      title: title || undefined,
      performer: performer || undefined,
      voice: Boolean(voice),
    }),
  ];
}

/** Map Telethon `DocumentAttributeVideo` to the GramJS equivalent. */
function videoAttributes({ duration = 0, width = 0, height = 0, streaming = false } = {}) {
  return [
    new Api.DocumentAttributeVideo({
      duration,
      w: width,
      h: height,
      supportsStreaming: Boolean(streaming),
    }),
  ];
}

function filenameAttribute(name) {
  return new Api.DocumentAttributeFilename({ fileName: name });
}

module.exports = {
  command,
  dispatchCommandText,
  runAction,
  checkPermission,
  createPatternMatch,
  getSender,
  toIdString,
  chatId,
  senderId,
  messageId,
  messageText,
  fileFromPath,
  bufferFile,
  audioAttributes,
  videoAttributes,
  filenameAttribute,
  CustomFile,
  NewMessage,
  Api,
  TelegramClient,
};

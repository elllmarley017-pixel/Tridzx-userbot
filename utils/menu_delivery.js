"use strict";
/**
 * Menu delivery: send a `.start` page **as the bot**, with native buttons.
 *
 * Why the bot must send the menu itself
 * -------------------------------------
 * A native `InlineKeyboardButton` only works on a message *owned by the bot*.
 * A userbot (MTProto user session) cannot attach an `inline_keyboard`, and a
 * relayed copy would degrade the buttons into text. So the menu is delivered by
 * the Bot API, which also means every `callback_query` comes back to
 * `bot_api_server.js` and can edit the very same message.
 *
 * Delivery chain (first success wins):
 *
 *   1. `bot`     Bot API `sendMessage` (parse_mode HTML + inline_keyboard)
 *                + `via @username` marker. Real, clickable buttons.
 *   2. `bridge`  Userbot relays the bot's reply (text + rendered buttons) into
 *                the chat. Used when the bot cannot post there (not a member,
 *                no rights, or the owner never started it).
 *   3. `local`   The userbot renders the same HTML itself. Always works.
 *
 * Telegram restrictions handled here:
 *   - `403 Forbidden: bot was blocked / not a member / not enough rights`
 *     → fall through to the bridge instead of failing the command.
 *   - `400 Bad Request: chat not found` → the bot never met that chat.
 *   - text > 4096 chars → `menu.truncateHtml`.
 */
const { callApi, verifyToken, BotApiError } = require("./bot_api");
const { resolveBotToken } = require("../config");
const menu = require("./menu");
const richTransport = require("./rich_transport");

/** Errors that mean "the bot may not post here" → try the next transport. */
const FALLBACK_RE = new RegExp(
  [
    "chat not found",
    "bot was blocked",
    "bot is not a member",
    "not enough rights",
    "have no rights",
    "PEER_ID_INVALID",
    "CHAT_WRITE_FORBIDDEN",
    "USER_IS_BLOCKED",
    "chat_write_forbidden",
    "message can't be sent",
    "MESSAGE_TOO_LONG",
  ].join("|"),
  "i",
);

/** True when a Bot API error should fall back to the userbot transport. */
function shouldFallback(err) {
  const message = String((err && err.message) || err || "");
  if (FALLBACK_RE.test(message)) return true;
  const code = Number(err && err.errorCode);
  return code === 403 || code === 400;
}

/** `via @username` marker (kept out of `menu.js` so pages stay transport-free). */
function viaMarker(username) {
  const name = String(username || "").replace(/^@/, "");
  return name ? `\n\n<i>🤖 via @${menu.esc(name)} · tombol di bawah interaktif.</i>` : "";
}

/** Cached `getMe` so repeated menu opens cost no extra API call. */
let identityCache = { token: "", me: null };

/** Resolve the bot identity for this token (cached). */
async function botIdentity(token = resolveBotToken()) {
  if (!token) return null;
  if (identityCache.token === token && identityCache.me) return identityCache.me;
  const result = await verifyToken(token);
  if (!result.ok || !result.me) return null;
  identityCache = { token, me: result.me };
  return result.me;
}

/** Reset the identity cache (tests / token rotation). */
function resetIdentityCache() {
  identityCache = { token: "", me: null };
}

/**
 * Build the `parse_mode: "HTML"` payload (fallback transport).
 * @returns {{text: string, reply_markup: object, parse_mode: string}}
 */
function buildPayload(page, username, extra = {}) {
  const index = menu.normalizePage(page);
  return {
    text: menu.truncateHtml(menu.renderPageHtml(index) + viaMarker(username)),
    parse_mode: "HTML",
    reply_markup: menu.buildKeyboard(index),
    link_preview_options: { is_disabled: true },
    ...extra,
  };
}

/**
 * Build the **Rich Message** payload for a page (Bot API 10.3).
 *
 * Rich Messages carry the structured layout (heading, compact table,
 * expandable quote) plus `RichBlockButtons`, and keep a native `reply_markup`
 * as well so callbacks work exactly like the HTML version.
 *
 * @returns {{message: object, keyboard: object, html: string}}
 */
function buildRichPayload(page, username, extra = {}) {
  const index = menu.normalizePage(page);
  const keyboard = menu.buildKeyboard(index);
  // Rich HTML, not blocks: `<details>`, `<summary>` and `<tg-button-row>` are
  // documented Rich HTML tags, and the parse_mode HTML parser rejects them.
  // Buttons live inside the message, so no reply_markup is sent with it.
  const html = menu.renderRichHtml(index, { botUsername: username });
  void extra;
  return { message: html, keyboard, html };
}

/**
 * Send a menu page as the bot.
 *
 * @param {object} options
 * @param {number|string} options.chatId
 * @param {number} [options.page]
 * @param {string} [options.token]
 * @param {object} [options.extra]   extra sendMessage fields (reply_parameters…)
 * @returns {Promise<{ok: boolean, transport: string, reason?: string, message?: object, username?: string}>}
 */
async function sendMenuAsBot(options = {}) {
  const token = options.token || resolveBotToken();
  if (!token) return { ok: false, transport: "none", reason: "no-token" };

  const chatId = options.chatId;
  if (chatId == null) return { ok: false, transport: "none", reason: "no-chat" };

  const me = await botIdentity(token);
  if (!me) return { ok: false, transport: "none", reason: "invalid-token" };

  // 1. Rich Message (Bot API 10.3) — keeps structured blocks + buttons.
  const capability = await richTransport.supportsRichMessages(token);
  if (capability.supported) {
    const richPayload = buildRichPayload(options.page, me.username, options.extra);
    try {
      const message = await richTransport.sendRichMessage({
        token,
        chatId,
        message: richPayload.message,
        extra: options.extra,
      });
      return { ok: true, transport: "bot", format: "rich", message, username: me.username };
    } catch (err) {
      // A rich-specific rejection (bad block, media missing…) must not lose the
      // menu: fall through to HTML, which is always deliverable.
      if (!shouldFallback(err)) {
        console.warn(`⚠️  sendRichMessage gagal (${err.message}); memakai HTML.`);
      }
    }
  }

  // 2. `parse_mode: "HTML"` + InlineKeyboardMarkup.
  const payload = buildPayload(options.page, me.username, options.extra);
  try {
    const message = await callApi(token, "sendMessage", { chat_id: chatId, ...payload });
    return { ok: true, transport: "bot", format: "html", message, username: me.username };
  } catch (err) {
    return {
      ok: false,
      transport: "bot",
      reason: err.message,
      fallback: shouldFallback(err),
      username: me.username,
      errorCode: err instanceof BotApiError ? err.errorCode : undefined,
    };
  }
}

/**
 * Edit an existing bot message into another menu page.
 * Used by the callback handler so navigation never creates duplicates.
 *
 * @returns {Promise<{ok: boolean, unchanged?: boolean, reason?: string}>}
 */
async function editMenuAsBot(options = {}) {
  const token = options.token || resolveBotToken();
  if (!token) return { ok: false, reason: "no-token" };
  const { chatId, messageId, page } = options;
  if (chatId == null || messageId == null) return { ok: false, reason: "no-message" };

  const me = await botIdentity(token);
  const username = me ? me.username : "";

  // Rich edit first: the message stays a Rich Message across navigation.
  const capability = await richTransport.supportsRichMessages(token);
  if (capability.supported) {
    const richPayload = buildRichPayload(page, username);
    try {
      const result = await richTransport.editRichMessage({
        token,
        chatId,
        messageId,
        message: richPayload.message,
      });
      return { ok: true, format: "rich", result };
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return { ok: true, unchanged: true };
      if (shouldFallback(err)) return { ok: false, reason: err.message, fallback: true };
      console.warn(`⚠️  editRichMessage gagal (${err.message}); memakai HTML.`);
    }
  }

  const payload = buildPayload(page, username);
  try {
    const result = await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      ...payload,
    });
    return { ok: true, format: "html", result };
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return { ok: true, unchanged: true };
    return { ok: false, reason: err.message, fallback: shouldFallback(err) };
  }
}

/**
 * Deliver a page with the full fallback chain.
 *
 * @param {object} options
 * @param {number|string} options.chatId
 * @param {number} [options.page]
 * @param {string} [options.token]
 * @param {object} [options.extra]
 * @param {(info: object) => Promise<boolean>} [options.bridge]
 *        Called when the Bot API cannot post; must return true on success.
 * @param {(info: object) => Promise<boolean>} [options.local]
 *        Last resort renderer; must return true on success.
 * @returns {Promise<{ok: boolean, transport: "bot"|"bridge"|"local"|"none", reason?: string}>}
 */
async function deliverMenu(options = {}) {
  const bot = await sendMenuAsBot(options);
  if (bot.ok) return { ok: true, transport: "bot", username: bot.username, message: bot.message };

  const reason = bot.reason || "unknown";
  if (typeof options.bridge === "function") {
    try {
      const delivered = await options.bridge({ page: menu.normalizePage(options.page), reason });
      if (delivered) return { ok: true, transport: "bridge", reason };
    } catch (err) {
      // A broken bridge must not stop the local fallback.
      void err;
    }
  }
  if (typeof options.local === "function") {
    try {
      const delivered = await options.local({ page: menu.normalizePage(options.page), reason });
      if (delivered) return { ok: true, transport: "local", reason };
    } catch (err) {
      return { ok: false, transport: "local", reason: err.message };
    }
  }
  return { ok: false, transport: "none", reason };
}

module.exports = {
  FALLBACK_RE,
  shouldFallback,
  viaMarker,
  botIdentity,
  resetIdentityCache,
  buildPayload,
  buildRichPayload,
  sendMenuAsBot,
  editMenuAsBot,
  deliverMenu,
};

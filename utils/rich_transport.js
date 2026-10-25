"use strict";
/**
 * Telegram Bot API 10.3 — **Rich Messages** transport.
 *
 * Verified live against the real Bot API (2025). Only the shapes below are
 * accepted; everything else is rejected with a descriptive error, so this
 * module encodes exactly what was tested:
 *
 *   sendRichMessage          { chat_id, rich_message: { blocks|html|markdown },
 *                              reply_markup?, link_preview_options? }
 *   editMessageText          { chat_id, message_id, rich_message: {...},
 *                              reply_markup? }
 *   answerInlineQuery        InputMessageContent = { rich_message: {...} }
 *
 * Verified block shapes (rejections in brackets):
 *   paragraph   { type, text: RichText }
 *   heading     { type, text, size: 1…6 }
 *   footer      { type, text }
 *   divider     { type }                    [alone → RICH_MESSAGE_EMPTY]
 *   pre         { type, text, language? }
 *   list        { type, items: [{ blocks, has_checkbox?, is_checked? }] }
 *   blockquote  { type, blocks: [...], credit? }          [text → EMPTY]
 *   expandable_blockquote { type, text, summary?, credit? } [blocks → REQUIRED]
 *   pullquote   { type, text, credit? }
 *   details     { type, summary, blocks, is_open? }
 *   table       { type, cells: [[{ text, is_header?, … }]], caption? }
 *                                                          [string cell → reject]
 *   buttons     { type, buttons: [{ text, url|callback_data|copy_text, style? }] }
 *   photo/video/audio/animation/voice_note/document
 *               { type, <kind>: { type: <kind>, media: "<url|attach://name>" },
 *                 caption?: { text }, credit?: { text } }
 *
 * Important: a Rich Message reaches an MTProto **user** session as
 * `MessageMediaUnsupported`, so it can never be relayed by the userbot. Rich
 * Messages must be sent by the bot itself; the userbot only triggers them.
 */
const { BOT_API_BASE, resolveBotToken } = require("../config");
const rich = require("./rich_message");
const { BotApiError } = require("./bot_api");

/** Telegram limits. */
const MAX_RICH_HTML = 32768;
const MAX_BLOCKS = 500;

/** Rich Messages need a bot that understands Bot API 10.3. */
const MIN_RICH_BOT_API = "10.3";

/** Cached capability probe per token. */
let capabilityCache = { token: "", result: null };

function token() {
  return resolveBotToken() || "";
}

function apiUrl(tok, method) {
  return `${BOT_API_BASE}/bot${tok}/${method}`;
}

async function readResult(res, method) {
  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) {
    throw new BotApiError(
      method,
      (json && json.description) || `HTTP ${res.status} dari ${method}`,
      (json && json.error_code) || res.status,
      json && json.parameters,
    );
  }
  return json.result;
}

/* ------------------------------------------------------------------ *
 * Capability detection                                                *
 * ------------------------------------------------------------------ */
/**
 * Is `sendRichMessage` available for this token?
 *
 * There is no feature flag in `getMe`, so the method is probed once and the
 * outcome cached. A `404 Not Found` means the server does not implement Rich
 * Messages yet → the caller must fall back to `parse_mode: "HTML"`.
 *
 * @returns {Promise<{supported: boolean, reason?: string}>}
 */
async function supportsRichMessages(tok = token(), { force = false } = {}) {
  if (!tok) return { supported: false, reason: "no-token" };
  if (!force && capabilityCache.token === tok && capabilityCache.result) {
    return capabilityCache.result;
  }
  let result;
  try {
    // Deliberately invalid (no chat_id): a 400 proves the method exists, a 404
    // proves it does not. Nothing is sent to any chat.
    const res = await fetch(apiUrl(tok, "sendRichMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 404) {
      result = { supported: false, reason: "method-not-available" };
    } else if (json.ok === true) {
      result = { supported: true };
    } else {
      // Any validation error mentioning rich_message / chat_id means the method
      // exists and parsed our request.
      const description = String(json.description || "");
      const exists = /chat_id|rich_message|Bad Request/i.test(description);
      result = exists
        ? { supported: true }
        : { supported: false, reason: description || `HTTP ${res.status}` };
    }
  } catch (err) {
    result = { supported: false, reason: err.message };
  }
  capabilityCache = { token: tok, result };
  return result;
}

/** Forget the cached capability probe (tests / token rotation). */
function resetCapabilityCache() {
  capabilityCache = { token: "", result: null };
}

/* ------------------------------------------------------------------ *
 * Payload building                                                    *
 * ------------------------------------------------------------------ */
/**
 * Build the `rich_message` object from a Rich Message value.
 *
 * The docs require **exactly one** of `html` / `markdown` / `blocks`, so this
 * function returns a payload with a single field — never a combination:
 *
 *   1. `blocks`   when the message carries them (richest: tables, buttons,
 *                 media, expandable quotes)
 *   2. `html`     when only HTML is available (trimmed to 32 768 chars)
 *   3. `markdown` when only Markdown is available
 *
 * @param {object} message  result of `buildRichMessage()` / `formatRichMessage()`
 * @returns {{blocks: Array} | {html: string} | {markdown: string}}
 */
function buildRichPayload(message) {
  if (!message) throw new TypeError("Rich Message kosong.");
  // A plain string is Rich HTML (`rich_message.html`), which is what the menu
  // uses so it can carry `<details>` / `<tg-button-row>`.
  if (typeof message === "string") {
    if (!message.trim()) throw new TypeError("Rich HTML kosong.");
    return { html: message.slice(0, MAX_RICH_HTML) };
  }
  const source = rich.isRichMessage(message) ? message : null;
  const blocks = source ? source.blocks : Array.isArray(message) ? message : null;

  if (Array.isArray(blocks) && blocks.length) {
    if (blocks.length > MAX_BLOCKS) {
      throw new RangeError(`Terlalu banyak blok (${blocks.length} > ${MAX_BLOCKS}).`);
    }
    return { blocks };
  }

  const html = source && typeof source.html === "string" ? source.html : "";
  if (html) return { html: html.slice(0, MAX_RICH_HTML) };

  const markdown = source && typeof source.markdown === "string" ? source.markdown : "";
  if (markdown) return { markdown: markdown.slice(0, MAX_RICH_HTML) };

  throw new TypeError("Rich Message tidak berisi blocks/html/markdown.");
}

/**
 * Same as `buildRichPayload` but returns `{ blocks, html, markdown }` for local
 * use (e.g. keeping the HTML copy for logging) — never send this to the API.
 */
function buildRichVariants(message) {
  const payload = buildRichPayload(message);
  const source = rich.isRichMessage(message) ? message : {};
  return {
    blocks: payload.blocks || source.blocks || [],
    html: payload.html || source.html || "",
    markdown: payload.markdown || source.markdown || "",
  };
}

/**
 * Convert native `InlineKeyboardMarkup` (plain Bot API object) into
 * `RichBlockButtons` (Rich Message buttons).
 *
 * Rich Messages have their own button type: `copy_text` becomes
 * `{ text: ... }` and styles map to the documented values. URL buttons stay
 * URL buttons.
 *
 * @param {{inline_keyboard: Array<Array<object>>}} markup
 * @returns {Array} one `buttons` block per row
 */
function inlineKeyboardToRichButtons(markup) {
  const rows = (markup && markup.inline_keyboard) || [];
  const blocks = [];
  for (const row of rows) {
    const buttons = [];
    for (const button of row || []) {
      if (!button || !button.text) continue;
      const richButton = { text: String(button.text) };
      if (button.url) {
        richButton.url = String(button.url);
      } else if (button.copy_text) {
        const value = typeof button.copy_text === "string" ? button.copy_text : button.copy_text.text;
        richButton.copy_text = { text: String(value) };
      } else if (button.callback_data) {
        // Rich Messages keep callback buttons working; the payload is the same.
        richButton.callback_data = String(button.callback_data);
      } else {
        continue;
      }
      if (button.style) richButton.style = String(button.style);
      buttons.push(richButton);
    }
    if (buttons.length) blocks.push({ type: "buttons", buttons });
  }
  return blocks;
}

/**
 * Build a Rich Message for a menu page: the page blocks plus one
 * `RichBlockButtons` row set for navigation.
 *
 * @param {object} options
 * @param {Array} options.blocks        page blocks (`menu` pages are HTML today)
 * @param {object} [options.keyboard]   native InlineKeyboardMarkup to mirror
 * @param {string} [options.html]       HTML fallback
 * @returns {object} Rich Message value accepted by `buildRichPayload`
 */
function composeRichMessage(options = {}) {
  const blocks = [...(options.blocks || [])];
  const buttonBlocks = options.keyboard ? inlineKeyboardToRichButtons(options.keyboard) : [];
  blocks.push(...buttonBlocks);
  const html = String(options.html || "").slice(0, MAX_RICH_HTML);
  return rich.buildRichMessage(blocks, { html });
}

/* ------------------------------------------------------------------ *
 * API calls                                                           *
 * ------------------------------------------------------------------ */
/**
 * `sendRichMessage` — https://core.telegram.org/bots/api#sendrichmessage
 *
 * @param {object} options
 * @param {string} [options.token]
 * @param {number|string} options.chatId
 * @param {object} options.message      Rich Message value
 * @param {object} [options.keyboard]   InlineKeyboardMarkup (native, optional)
 * @param {object} [options.extra]      reply_parameters, protect_content…
 * @returns {Promise<object>} the sent Message
 */
async function sendRichMessage(options = {}) {
  const tok = options.token || token();
  if (!tok) throw new Error("Token Bot API tidak tersedia.");
  if (options.chatId == null) throw new Error("chat_id wajib diisi.");

  const richMessage = buildRichPayload(options.message);
  const body = {
    chat_id: options.chatId,
    rich_message: richMessage,
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    ...(options.disablePreview === false ? {} : { link_preview_options: { is_disabled: true } }),
    ...(options.extra || {}),
  };
  const res = await fetch(apiUrl(tok, "sendRichMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readResult(res, "sendRichMessage");
}

/**
 * Edit a message into a Rich Message (`editMessageText` + `rich_message`).
 * Verified: the `reply_markup` must be re-sent on every edit or the keyboard
 * disappears.
 */
async function editRichMessage(options = {}) {
  const tok = options.token || token();
  if (!tok) throw new Error("Token Bot API tidak tersedia.");
  if (options.chatId == null || options.messageId == null) {
    throw new Error("chat_id dan message_id wajib diisi.");
  }
  const body = {
    chat_id: options.chatId,
    message_id: options.messageId,
    rich_message: buildRichPayload(options.message),
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    ...(options.disablePreview === false ? {} : { link_preview_options: { is_disabled: true } }),
    ...(options.extra || {}),
  };
  const res = await fetch(apiUrl(tok, "editMessageText"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return readResult(res, "editMessageText");
}

/**
 * Send a Rich Message whose blocks embed a media file.
 *
 * A local buffer cannot be referenced by URL, so it is uploaded as
 * `attach://<field>` in the same multipart request — the documented way to mix
 * Rich Message blocks with files.
 *
 * @param {object} options
 * @param {Buffer} options.file
 * @param {string} [options.filename]
 * @param {string} [options.mime]
 * @param {string} [options.field]     default "file0"
 * @param {string} options.mediaType   photo|video|audio|animation|voice_note|document
 */
async function sendRichMessageWithFile(options = {}) {
  const tok = options.token || token();
  if (!tok) throw new Error("Token Bot API tidak tersedia.");
  if (!Buffer.isBuffer(options.file) || !options.file.length) throw new Error("File kosong.");

  const field = options.field || "file0";
  const mediaType = options.mediaType || "photo";
  const blocks = [...(options.blocks || [])];
  blocks.push(
    rich.block.media(mediaType, `attach://${field}`, {
      caption: options.caption,
    }),
  );
  if (options.keyboard) blocks.push(...inlineKeyboardToRichButtons(options.keyboard));

  const richMessage = rich.buildRichMessage(blocks, {
    html: String(options.html || "").slice(0, MAX_RICH_HTML),
  });

  const form = new FormData();
  form.append("chat_id", String(options.chatId));
  form.append("rich_message", JSON.stringify(buildRichPayload(richMessage)));
  if (options.keyboard) form.append("reply_markup", JSON.stringify(options.keyboard));
  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  form.append(
    field,
    new Blob([options.file], { type: options.mime || "application/octet-stream" }),
    options.filename || `${field}.bin`,
  );

  const res = await fetch(apiUrl(tok, "sendRichMessage"), { method: "POST", body: form });
  return readResult(res, "sendRichMessage");
}

/**
 * Build the `InputMessageContent` for an inline result that must keep its Rich
 * Message formatting.
 *
 * Verified: `{ rich_message: { blocks|html|markdown } }` is accepted inside
 * `input_message_content` (validated with `savePreparedInlineMessage`).
 * `InputRichMessageContent` is not a separate field name — the payload is the
 * same `rich_message` object used by `sendRichMessage`.
 *
 * @param {object} message Rich Message value
 * @returns {{rich_message: object}}
 */
function inlineRichContent(message) {
  return { rich_message: buildRichPayload(message) };
}

module.exports = {
  MAX_RICH_HTML,
  MAX_BLOCKS,
  MIN_RICH_BOT_API,
  supportsRichMessages,
  resetCapabilityCache,
  buildRichPayload,
  buildRichVariants,
  inlineKeyboardToRichButtons,
  composeRichMessage,
  sendRichMessage,
  editRichMessage,
  sendRichMessageWithFile,
  inlineRichContent,
};

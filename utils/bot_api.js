"use strict";
/**
 * Minimal, dependency-free Telegram Bot API client.
 *
 * Used by:
 *   - `utils/bot_bridge.js`  (companion menu replies)
 *   - `utils/inline_bot.js`  (Inline Mode: answerInlineQuery …)
 *   - `utils/inline_upload.js` (uploading userbot media to obtain a file_id)
 *
 * Two transports are supported because the Bot API mixes them:
 *   JSON        → getMe, answerInlineQuery, sendMessage, deleteMessage, …
 *   multipart   → sendPhoto / sendVideo / sendDocument / sendAudio uploads
 *
 * Verified against Bot API 9.x (2025) shapes: `link_preview_options` instead of
 * the removed `disable_web_page_preview`, `reply_parameters` instead of
 * `reply_to_message_id`, `caption_entities` on media results.
 */
const { BOT_API_BASE } = require("../config");

/** Error carrying the Bot API status so callers can branch (e.g. 409). */
class BotApiError extends Error {
  constructor(method, description, code, parameters) {
    super(description || `${method} gagal`);
    this.name = "BotApiError";
    this.method = method;
    this.errorCode = code;
    this.parameters = parameters || null;
  }
}

function apiUrl(token, method) {
  return `${BOT_API_BASE}/bot${token}/${method}`;
}

async function readResult(res, method) {
  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) {
    const description =
      (json && (json.description || json.error_description)) ||
      `HTTP ${res.status} dari ${method}`;
    throw new BotApiError(method, description, (json && json.error_code) || res.status, json && json.parameters);
  }
  return json.result;
}

/**
 * Call a JSON Bot API method.
 *
 * @param {string} token
 * @param {string} method
 * @param {object} [params]
 * @param {{signal?: AbortSignal}} [options]
 */
async function callApi(token, method, params = {}, options = {}) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(apiUrl(token, method), init);
  return readResult(res, method);
}

/**
 * Call a Bot API method with `multipart/form-data`.
 *
 * @param {string} token
 * @param {string} method
 * @param {object} fields  plain key/value pairs (objects are JSON-encoded)
 * @param {Array<{field: string, filename: string, data: Buffer|Uint8Array, contentType?: string}>} files
 * @param {{signal?: AbortSignal}} [options]
 */
async function callApiForm(token, method, fields = {}, files = [], options = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const file of files) {
    const blob = new Blob([file.data], { type: file.contentType || "application/octet-stream" });
    form.append(file.field, blob, file.filename || file.field);
  }
  const init = { method: "POST", body: form };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(apiUrl(token, method), init);
  return readResult(res, method);
}

/** Download a file uploaded through the Bot API (`file_id` → Buffer). */
async function downloadFile(token, fileId, options = {}) {
  const file = await callApi(token, "getFile", { file_id: fileId }, options);
  if (!file || !file.file_path) throw new BotApiError("getFile", "file_path tidak tersedia");
  const res = await fetch(`${BOT_API_BASE}/file/bot${token}/${file.file_path}`, {
    signal: options.signal,
  });
  if (!res.ok) throw new BotApiError("downloadFile", `HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Validate a token once per process.
 * Never throws: returns `{ok:false, reason}` so a bad token only disables the
 * Bot API features instead of crashing the userbot.
 */
async function verifyToken(token, { timeoutMs = 10_000, cache = true } = {}) {
  if (!token) return { ok: false, reason: "no-token" };
  if (cache && verifyToken.cache && verifyToken.cache.token === token) {
    return verifyToken.cache.result;
  }
  let result;
  try {
    const me = await callApi(token, "getMe", {}, { signal: AbortSignal.timeout(timeoutMs) });
    result = { ok: true, me };
  } catch (err) {
    result = { ok: false, reason: err.message, code: err.errorCode };
  }
  if (cache) verifyToken.cache = { token, result };
  return result;
}

/** Forget the cached `getMe` result (tests / token rotation). */
function resetTokenCache() {
  verifyToken.cache = null;
}

/**
 * Check the capabilities this project relies on.
 * `supports_inline_queries` must be enabled in BotFather (`/setinline`);
 * otherwise every inline query is rejected by Telegram before it reaches us.
 */
function capabilities(me) {
  return {
    username: me && me.username,
    id: me && me.id,
    inline: Boolean(me && me.supports_inline_queries),
    groups: Boolean(me && me.can_join_groups),
    privacy: Boolean(me && me.can_read_all_group_messages),
  };
}

/** Register the bot command list (best effort). */
async function setMyCommands(token, commands) {
  try {
    return await callApi(token, "setMyCommands", { commands });
  } catch {
    return null;
  }
}

module.exports = {
  BotApiError,
  callApi,
  callApiForm,
  downloadFile,
  verifyToken,
  resetTokenCache,
  capabilities,
  setMyCommands,
  apiUrl,
};

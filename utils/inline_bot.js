"use strict";
/**
 * Inline Mode engine (Bot API side).
 *
 * Owner types `@hybrixhanbot <keyword>` in any chat, picks a catalogue entry,
 * and Telegram delivers it **as the bot** — the userbot's MTProto session is
 * never involved in the delivery. That is exactly why Inline Mode lives in the
 * Bot API process: only a bot can answer `inline_query`.
 *
 *   inline_query            → owner check → catalog.search() → answerInlineQuery
 *   chosen_inline_result    → audit log only (Telegram already sent the content)
 *
 * Results use the documented `InputMessageContent` union:
 *   text      → InputTextMessageContent
 *   photo     → InputPhotoContent           (caption + caption_entities)
 *   video     → InputVideoContent
 *   animation → InputAnimationContent
 *   audio     → InputAudioContent
 *   voice     → InputVoiceContent
 *   document  → InputDocumentContent
 *
 * Because the catalogue is personal, results are answered with `cache_time: 0`
 * and `is_personal: true` so Telegram never caches them for other users.
 */
const catalog = require("./inline_catalog");
const { callApi, BotApiError } = require("./bot_api");
const richTransport = require("./rich_transport");
const rich = require("./rich_message");
const { ownerIds } = require("../config");

/** Bot API: result id max length. */
const MAX_RESULT_ID = 64;

/** Owner-only denial is silent: no titles, no counts, no hints. */
const DENIED = Object.freeze({ results: [], cache_time: 0, is_personal: true });

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value, max) {
  const text = String(value == null ? "" : value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Is this inline query sent by the account owner?
 *
 * Owner ids come from `USERBOT_OWNER_ID` and `session/config.json → owner_id`,
 * both of which the userbot writes at login (`saveOwnerId`). An empty owner list
 * means "not configured" and therefore denies everyone — fail closed.
 */
function isOwnerQuery(inlineQuery, { owners = ownerIds() } = {}) {
  const sender = inlineQuery && inlineQuery.from;
  const id = Number(sender && sender.id);
  if (!Number.isInteger(id) || id <= 0) return false;
  return owners.includes(id);
}

/**
 * Build the `InputRichMessageContent` for a catalogue text item.
 *
 * Bot API 10.3 keeps the rich payload in the same `rich_message` object used by
 * `sendRichMessage` (`html` | `markdown` | `blocks` — exactly one is required
 * per the docs; we always send `blocks` plus `html` only when no blocks exist).
 * Verified accepted inside `input_message_content` with
 * `savePreparedInlineMessage`.
 *
 * @param {object} item catalogue item
 * @param {object} [options]
 * @param {boolean} [options.rich]  set false to force plain text fallback
 * @returns {{rich_message?: object, message_text?: string, parse_mode?: string}}
 */
function buildTextContent(item, options = {}) {
  const text = String(item.text || item.title || "").trim();
  const richEnabled = options.rich !== false;

  if (richEnabled) {
    try {
      const blocks = [
        { type: "heading", text: item.title || "Konten", size: 3 },
        { type: "paragraph", text: item.text || item.title || "" },
      ];
      if (item.description) {
        blocks.push({ type: "expandable_blockquote", text: item.description });
      }
      const message = rich.buildRichMessage(blocks);
      return richTransport.inlineRichContent(message);
    } catch {
      // fall through to plain text
    }
  }

  // Documented fallback: plain `InputTextMessageContent`.
  return { message_text: text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
}

/** Build one InlineQueryResult per catalogue item. */
function buildResults(items, { query = "", rich: richEnabled = true } = {}) {
  const results = [];
  for (const item of items) {
    const id = String(item.id).slice(0, MAX_RESULT_ID);
    const caption = item.caption
      ? item.caption
      : item.description
        ? `<b>${escapeHtml(item.title)}</b>\n${escapeHtml(item.description)}`
        : `<b>${escapeHtml(item.title)}</b>`;
    const title = truncate(item.title, 64);
    const description = truncate(item.description || `Konten ${item.type}`, 120);

    if (item.type === "text") {
      results.push({
        type: "article",
        id,
        title,
        description,
        // Rich content when available, plain `message_text` otherwise.
        input_message_content: buildTextContent(item, { rich: richEnabled }),
      });
      continue;
    }

    if (!item.file_id) {
      // Not uploaded yet → tell the owner instead of returning a broken result.
      results.push({
        type: "article",
        id,
        title: `⚠️ ${title}`,
        description: "Media belum diunggah ke Bot API. Jalankan .inline upload.",
        input_message_content: {
          message_text:
            `⚠️ <b>${escapeHtml(item.title)}</b>\n` +
            `Media belum diunggah ke Bot API.\n` +
            `Jalankan <code>.inline upload ${escapeHtml(item.id)}</code> dari userbot.`,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      });
      continue;
    }

    switch (item.type) {
      case "photo":
        results.push({
          type: "photo",
          id,
          title,
          description,
          photo_file_id: item.file_id,
          caption,
          parse_mode: "HTML",
        });
        break;
      case "video":
        results.push({
          type: "video",
          id,
          title,
          description,
          video_file_id: item.file_id,
          mime_type: item.mime || "video/mp4",
          caption,
          parse_mode: "HTML",
          ...(item.width && item.height
            ? { thumbnail_width: item.width, thumbnail_height: item.height }
            : {}),
        });
        break;
      case "animation":
        results.push({
          type: "gif",
          id,
          title,
          description,
          gif_file_id: item.file_id,
          caption,
          parse_mode: "HTML",
        });
        break;
      case "audio":
        results.push({
          type: "audio",
          id,
          title,
          description,
          audio_file_id: item.file_id,
          // Telegram validates that audio carries a title; it is stored with the
          // uploaded file, and repeating it here keeps older items usable.
          audio_title: item.audio_title || item.title,
          ...(item.performer ? { performer: item.performer } : {}),
          ...(item.duration ? { audio_duration: item.duration } : {}),
          caption,
          parse_mode: "HTML",
        });
        break;
      case "voice":
        results.push({
          type: "voice",
          id,
          title,
          description,
          voice_file_id: item.file_id,
          caption,
          parse_mode: "HTML",
        });
        break;
      default:
        results.push({
          type: "document",
          id,
          title,
          description,
          document_file_id: item.file_id,
          caption,
          parse_mode: "HTML",
        });
        break;
    }
  }
  void query;
  void richEnabled;
  return results;
}

/**
 * Compute the `answerInlineQuery` payload for one inline query.
 * Pure function: no network, so it is directly unit-testable.
 */
function buildAnswer(inlineQuery, options = {}) {
  const owners = options.owners || ownerIds();
  if (!isOwnerQuery(inlineQuery, { owners })) {
    return { ...DENIED, denied: true };
  }

  const raw = String((inlineQuery && inlineQuery.query) || "").trim();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 25));
  const found = catalog.search(raw, { limit });
  const results = buildResults(found.items);

  const payload = {
    inline_query_id: inlineQuery.id,
    results,
    cache_time: Number(options.cacheTime ?? 0) || 0,
    is_personal: true,
    next_offset: found.hasMore ? String(results.length) : "",
  };

  // First use: the catalogue is empty → explain how to fill it, but only to the
  // owner (a non-owner never reaches this branch).
  if (!results.length) {
    const hint = raw
      ? `Tidak ada konten yang cocok dengan “${truncate(raw, 40)}”.`
      : "Katalog inline masih kosong.";
    payload.results = [
      {
        type: "article",
        id: "help",
        title: "ℹ️ Katalog Inline",
        description: hint,
        input_message_content: {
          message_text:
            `ℹ️ <b>Katalog Inline</b>\n${escapeHtml(hint)}\n\n` +
            "<b>Menambah konten</b>\n" +
            "• Reply sebuah pesan lalu ketik <code>.inline add &lt;judul&gt;</code>\n" +
            "• <code>.inline list</code> — lihat katalog\n" +
            "• <code>.inline del &lt;id&gt;</code> — hapus item\n\n" +
            "<b>Mencari dari Inline Mode</b>\n" +
            "• <code>@bot kata kunci</code>\n" +
            "• <code>@bot type:foto kata</code> — filter jenis media\n" +
            "• <code>@bot #tag</code> — filter tag",
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      },
    ];
    payload.next_offset = "";
  }
  return payload;
}

/**
 * Answer an inline query.
 * Always resolves (Telegram expects a prompt answer; errors are logged only).
 *
 * @returns {Promise<{ok: boolean, answered: number, denied: boolean, error?: string}>}
 */
async function answerInlineQuery(token, inlineQuery, options = {}) {
  const payload = buildAnswer(inlineQuery, options);
  if (payload.denied) {
    // Telegram requires an answer; an empty result set reveals nothing.
    try {
      await callApi(token, "answerInlineQuery", {
        inline_query_id: inlineQuery.id,
        results: [],
        cache_time: 0,
        is_personal: true,
      });
      return { ok: true, answered: 0, denied: true };
    } catch (err) {
      return { ok: false, answered: 0, denied: true, error: err.message };
    }
  }

  try {
    await callApi(token, "answerInlineQuery", payload, {
      signal: options.signal,
    });
    return { ok: true, answered: payload.results.length, denied: false };
  } catch (err) {
    return { ok: false, answered: 0, denied: false, error: err.message };
  }
}

/**
 * Send catalogue content explicitly to a chat as the bot.
 * Inline Mode normally lets Telegram deliver the content, but this helper is
 * used by `/send <id> [chat_id]` for channels/groups where the owner wants a
 * direct bot-sent copy (e.g. scheduled posts).
 */
async function sendItemAsBot(token, item, chatId, options = {}) {
  if (!item) throw new Error("Item tidak ditemukan.");
  const caption = item.caption || `<b>${escapeHtml(item.title)}</b>`;
  const base = {
    chat_id: chatId,
    disable_notification: Boolean(options.silent),
    protect_content: Boolean(options.protect),
  };
  const methodByType = {
    photo: "sendPhoto",
    video: "sendVideo",
    animation: "sendAnimation",
    audio: "sendAudio",
    voice: "sendVoice",
    document: "sendDocument",
  };

  if (item.type === "text") {
    return callApi(token, "sendMessage", {
      ...base,
      text: item.text || item.title,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
  const method = methodByType[item.type] || "sendDocument";
  const field = {
    sendPhoto: "photo",
    sendVideo: "video",
    sendAnimation: "animation",
    sendAudio: "audio",
    sendVoice: "voice",
    sendDocument: "document",
  }[method];
  if (!item.file_id) throw new Error("Media belum diunggah ke Bot API.");
  return callApi(token, method, {
    ...base,
    [field]: item.file_id,
    caption: truncate(caption, 1024),
    parse_mode: "HTML",
  });
}

/**
 * Handle one Bot API update of type `inline_query` / `chosen_inline_result`.
 *
 * @param {string} token
 * @param {object} update
 * @param {{log?: Function, owners?: number[], limit?: number}} [options]
 */
async function handleUpdate(token, update, options = {}) {
  const log = options.log || (() => {});
  if (update && update.inline_query) {
    const started = Date.now();
    const query = String(update.inline_query.query || "");
    const result = await answerInlineQuery(token, update.inline_query, options);
    log(
      `inline query from ${update.inline_query.from && update.inline_query.from.id} ` +
        `"${truncate(query, 40)}" → ${result.answered} hasil` +
        `${result.denied ? " (ditolak: bukan owner)" : ""} ` +
        `[${Date.now() - started}ms]`,
    );
    if (!result.ok) log(`inline answer gagal: ${result.error}`);
    return { type: "inline_query", ...result };
  }
  if (update && update.chosen_inline_result) {
    const chosen = update.chosen_inline_result;
    const item = catalog.get(chosen.result_id);
    log(
      `chosen result ${chosen.result_id}${item ? ` (${item.title})` : ""} ` +
        `by ${chosen.from && chosen.from.id} in ${chosen.inline_message_id || "?"}`,
    );
    return { type: "chosen_inline_result", ok: true, item };
  }
  return null;
}

/** Pre-flight check used at startup: inline mode must be enabled in BotFather. */
async function assertInlineReady(token, me) {
  const enabled = Boolean(me && me.supports_inline_queries);
  if (enabled) return { ok: true };
  return {
    ok: false,
    reason:
      "Inline Mode belum aktif untuk bot ini. Buka @BotFather → /setinline → pilih bot → " +
      "isi placeholder (mis. 'Cari konten…').",
  };
}

module.exports = {
  MAX_RESULT_ID,
  DENIED,
  escapeHtml,
  truncate,
  isOwnerQuery,
  buildResults,
  buildTextContent,
  buildAnswer,
  answerInlineQuery,
  sendItemAsBot,
  handleUpdate,
  assertInlineReady,
  BotApiError,
};

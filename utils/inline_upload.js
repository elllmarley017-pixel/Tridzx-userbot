"use strict";
/**
 * Media bridge for Inline Mode.
 *
 * Why this exists
 * ---------------
 * Inline results must reference content that the *Bot API* can serve. A userbot
 * media object (MTProto) cannot be embedded in `answerInlineQuery`, so the file
 * has to be uploaded once through the Bot API; the returned `file_id` is then
 * cached in the catalogue and reused for every inline answer (no re-upload).
 *
 * Flow
 * ----
 *   reply to a photo/video/document  (userbot, MTProto)
 *        │ downloadMedia()
 *        ▼
 *   Buffer ── sendPhoto/sendVideo/sendDocument (Bot API) ──> file_id
 *        │                                                     │
 *        └──────────── session/inline_catalog.json ────────────┘
 *
 * The upload message is deleted afterwards by default so the owner's chat with
 * the bot does not fill up with duplicates; Telegram keeps the `file_id` valid
 * after deletion, which is exactly what the cache relies on.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { callApi, callApiForm } = require("./bot_api");
const catalog = require("./inline_catalog");

/** Bot API hard limits (upload side). */
const LIMITS = {
  photo: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  animation: 50 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  voice: 50 * 1024 * 1024,
  document: 50 * 1024 * 1024,
};

/** Upload method per media kind. */
const UPLOAD_METHOD = {
  photo: "sendPhoto",
  video: "sendVideo",
  animation: "sendAnimation",
  audio: "sendAudio",
  voice: "sendVoice",
  document: "sendDocument",
};

/** Field name carrying the file for each method. */
const FILE_FIELD = {
  sendPhoto: "photo",
  sendVideo: "video",
  sendAnimation: "animation",
  sendAudio: "audio",
  sendVoice: "voice",
  sendDocument: "document",
};

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".json": "application/json",
};

const EXT_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

function guessMime(fileName, fallback = "application/octet-stream") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

function guessExtension(mime, fallback = ".bin") {
  return EXT_BY_MIME[String(mime || "").toLowerCase()] || fallback;
}

/** Classify a GramJS media object into a catalogue media type. */
function mediaKind(media, message) {
  if (!media) return null;
  const name = String(media.className || "");
  if (/Photo/.test(name)) return "photo";
  if (/Geo|Contact|Poll|WebPage|Unsupported|Dice|Venue|Game/.test(name)) return null;

  const document = media.document;
  if (document) {
    const mime = String(document.mimeType || "");
    const attrs = Array.isArray(document.attributes) ? document.attributes : [];
    const attrNames = attrs.map((attr) => String(attr.className || ""));
    const isSticker = attrNames.some((n) => /Sticker/.test(n));
    if (isSticker) return null;
    if (attrNames.some((n) => /Animated/.test(n)) || mime === "image/gif") return "animation";
    if (attrNames.some((n) => /Video/.test(n)) || mime.startsWith("video/")) return "video";
    if (attrNames.some((n) => /Audio/.test(n)) || mime.startsWith("audio/")) {
      if (attrNames.some((n) => /Voice/.test(n))) return "voice";
      return "audio";
    }
    if (mime.startsWith("image/")) return "photo";
    return "document";
  }
  if (media.video || (message && message.video)) return "video";
  return null;
}

/** Read a GramJS document filename (falls back to a generated name). */
function documentName(message, kind) {
  // GramJS exposes the document on `message.media.document`; some call sites
  // pass a bare `document`, so accept both shapes.
  const document =
    (message && message.media && message.media.document) || (message && message.document);
  const attrs = document && Array.isArray(document.attributes) ? document.attributes : [];
  for (const attr of attrs) {
    if (attr && attr.fileName) return String(attr.fileName);
  }
  const mime = document && document.mimeType;
  return `inline-${Date.now()}${guessExtension(mime, kind === "photo" ? ".jpg" : ".bin")}`;
}

/** Media metadata (size, mime, dimensions, duration) for the catalogue. */
function mediaMeta(message, kind) {
  const media = message && message.media;
  const document = media && media.document;
  const photo = media && media.photo;
  const meta = {
    mime: (document && document.mimeType) || "",
    size: Number((document && document.size) || 0),
    duration: 0,
    width: 0,
    height: 0,
    file_name: "",
  };
  if (kind === "photo" && photo) {
    meta.mime = meta.mime || "image/jpeg";
    return meta;
  }
  for (const attr of (document && document.attributes) || []) {
    const name = String(attr.className || "");
    if (/Video/.test(name)) {
      meta.duration = Number(attr.duration) || 0;
      meta.width = Number(attr.w) || 0;
      meta.height = Number(attr.h) || 0;
    } else if (/Audio/.test(name)) {
      meta.duration = Number(attr.duration) || 0;
    } else if (/Filename/.test(name)) {
      meta.file_name = String(attr.fileName || "");
    }
  }
  return meta;
}

/**
 * Upload a buffer to the Bot API and return its `file_id`.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {number|string} options.chatId   chat the bot may post to (owner)
 * @param {Buffer} options.buffer
 * @param {string} options.kind            photo|video|document|audio|animation|voice
 * @param {string} [options.filename]
 * @param {string} [options.mime]
 * @param {string} [options.caption]
 * @param {boolean} [options.keepMessage]  keep the upload message in the chat
 */
async function uploadMedia(options) {
  const {
    token,
    chatId,
    buffer,
    kind,
    filename,
    mime,
    caption,
    keepMessage = false,
    title,
    performer,
    duration,
    signal,
  } = options;

  if (!token) throw new Error("Token Bot API tidak tersedia.");
  if (!chatId) throw new Error("Chat ID owner belum diketahui; set owner_id di config.");
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Media kosong.");

  const type = LIMITS[kind] ? kind : "document";
  const limit = LIMITS[type];
  if (buffer.length > limit) {
    throw new Error(
      `Ukuran ${type} ${(buffer.length / 1048576).toFixed(1)} MB melebihi batas Bot API ` +
        `${(limit / 1048576).toFixed(0)} MB.`,
    );
  }

  // sendPhoto only accepts jpg/png; anything else goes out as a document.
  let method = UPLOAD_METHOD[type];
  const contentType = String(mime || guessMime(filename, "application/octet-stream"));
  if (method === "sendPhoto" && !/^image\/(jpeg|png)$/.test(contentType)) {
    method = "sendDocument";
  }

  const field = FILE_FIELD[method];
  const fields = { chat_id: chatId, disable_notification: true };
  if (caption) fields.caption = String(caption).slice(0, 1024);

  // Telegram requires audio to carry a title, otherwise Inline Mode rejects the
  // result with AUDIO_TITLE_EMPTY. The metadata is stored on the *file*, so it
  // must be supplied here at upload time (an inline result cannot add it).
  if (method === "sendAudio") {
    fields.title = String(options.title || filename || "Audio").slice(0, 64);
    if (options.performer) fields.performer = String(options.performer).slice(0, 64);
    if (options.duration) fields.duration = Math.round(Number(options.duration) || 0);
  }

  const files = [
    {
      field,
      filename: filename || `inline${guessExtension(contentType)}`,
      data: buffer,
      contentType,
    },
  ];

  const message = await callApiForm(token, method, fields, files, { signal });
  const result = extractFileRef(message, type);

  if (!keepMessage && message && message.message_id != null) {
    // Best effort: a failed delete must not invalidate the cached file_id.
    callApi(token, "deleteMessage", {
      chat_id: message.chat ? message.chat.id : chatId,
      message_id: message.message_id,
    }).catch(() => {});
  }
  return result;
}

/** Pull the first usable file reference out of a sent message. */
function extractFileRef(message, fallbackKind) {
  if (!message) throw new Error("Bot API tidak mengembalikan pesan.");
  const candidates = ["photo", "video", "animation", "audio", "voice", "document"];
  for (const key of candidates) {
    const value = message[key];
    if (!value) continue;
    const file = Array.isArray(value) ? value[value.length - 1] : value;
    if (!file || !file.file_id) continue;
    return {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id || "",
      mime: file.mime_type || "",
      size: Number(file.file_size) || 0,
      duration: Number(file.duration) || 0,
      width: Number(file.width) || 0,
      height: Number(file.height) || 0,
      file_name: file.file_name || "",
      kind: key === "photo" ? "photo" : key,
      fallbackKind,
    };
  }
  throw new Error("Respons Bot API tidak berisi file_id.");
}

/**
 * Download a GramJS media message into a Buffer.
 * Rejects media above the Bot API limit *before* downloading.
 */
async function downloadUserbotMedia(client, message, kind) {
  const limit = LIMITS[kind] || LIMITS.document;
  const meta = mediaMeta(message, kind);
  if (meta.size && meta.size > limit) {
    throw new Error(
      `Media ${(meta.size / 1048576).toFixed(1)} MB melebihi batas ` +
        `${(limit / 1048576).toFixed(0)} MB untuk inline.`,
    );
  }
  const buffer = await client.downloadMedia(message, {});
  if (!buffer || !buffer.length) throw new Error("Gagal mengunduh media dari Telegram.");
  if (buffer.length > limit) {
    throw new Error(
      `Media ${(buffer.length / 1048576).toFixed(1)} MB melebihi batas ` +
        `${(limit / 1048576).toFixed(0)} MB untuk inline.`,
    );
  }
  return { buffer, meta };
}

/**
 * Save a buffer into the inline media directory (used when the Bot API token is
 * unavailable, so the content is not lost — it can be uploaded later with
 * `.inline upload`).
 */
function persistLocal(buffer, ext = ".bin") {
  const dir = catalog.ensureMediaDir();
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const target = path.join(dir, name);
  fs.writeFileSync(target, buffer);
  return target;
}

/** Hash used to detect the same media being added twice. */
function fingerprint(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

module.exports = {
  LIMITS,
  UPLOAD_METHOD,
  MIME_BY_EXT,
  guessMime,
  guessExtension,
  mediaKind,
  mediaMeta,
  documentName,
  uploadMedia,
  extractFileRef,
  downloadUserbotMedia,
  persistLocal,
  fingerprint,
};

"use strict";
/** Shared helpers for downloader handlers — port of the inline helpers in
 * `handlers/youtube.py` reused across handlers. */
const fs = require("node:fs");

const { errorMessage } = require("./formatting");
const { markActivityFailed } = require("./activity_logging");
const { logDownload } = require("./download_logging");
const telegram = require("./telegram");

const STAGE_LABELS = {
  EXTRACTION: "Extraction Gagal",
  DOWNLOAD: "Download Gagal",
  POSTPROCESS: "FFmpeg/Post-processing Gagal",
  FILE_OUTPUT: "File Output Gagal",
  FILE_VALIDATION: "Validasi File Gagal",
  TELEGRAM_UPLOAD: "Upload Gagal",
};

function failureMessage(stage, detail) {
  const title = STAGE_LABELS[stage] || "Download Gagal";
  let body = detail ? String(detail).slice(0, 500) : "Terjadi kesalahan tanpa detail.";
  if (stage === "TELEGRAM_UPLOAD") {
    body = `File berhasil di-download, tetapi gagal dikirim ke Telegram.\n\nPenyebab: ${body}`;
  }
  return errorMessage(body, title);
}

/** `_user_label(event)` from the Python handlers. */
async function userLabel(event) {
  try {
    const sender = await event.getSender();
    const username = sender?.username;
    if (username) return `@${username}`;
    return telegram.toIdString(event.senderId);
  } catch {
    return telegram.toIdString(event.senderId);
  }
}

function fileSize(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

module.exports = { STAGE_LABELS, failureMessage, userLabel, fileSize, markActivityFailed, logDownload };

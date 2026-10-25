"use strict";
/**
 * Detailed downloader pipeline logging — Node.js port of
 * `utils/download_logging.py`. Shares the rotating handler with the activity
 * log exactly like the Python implementation did.
 */
const { LOG_FILE, LOG_TIMEZONE } = require("../config");
const { createLogger, createFileHandler } = require("./logging");
const { sanitize, formatTimestamp } = require("./activity_logging");

const downloadLogger = createLogger("telegram_userbot.download", { level: "INFO" });

let handlerInstalled = false;
function ensureHandler() {
  if (handlerInstalled) return;
  try {
    downloadLogger.addHandler(
      createFileHandler(LOG_FILE, { maxBytes: 5 * 1024 * 1024, backupCount: 3 }),
    );
    downloadLogger.level = "INFO";
    downloadLogger.propagate = false;
    handlerInstalled = true;
  } catch {
    handlerInstalled = false;
  }
}

function logDownload(user, feature, status, options = {}) {
  const {
    url = "-",
    stage = "-",
    progress = "-",
    error = "-",
    file = "-",
    size = 0,
  } = options;
  ensureHandler();
  const timestamp = formatTimestamp();
  const message = [
    `USER    : ${sanitize(user)}`,
    `FITUR   : ${sanitize(feature)}`,
    `URL     : ${sanitize(url)}`,
    `STATUS  : ${sanitize(status)}`,
    `STAGE   : ${sanitize(stage)}`,
    `PROGRESS: ${sanitize(progress)}`,
    `FILE    : ${sanitize(file)}`,
    `SIZE    : ${(Number(size) / 1024 / 1024).toFixed(2)} MB`,
    `ERROR   : ${sanitize(error)}`,
    `WAKTU   : ${timestamp}`,
  ].join("\n");
  const failed = String(status).endsWith("FAILED") || status === "FAILED";
  downloadLogger[failed ? "error" : "info"](message);
}

module.exports = { logDownload, LOG_TIMEZONE };

"use strict";
/** Throttled progress reporting — Node.js port of `utils/progress.py`. */
const { PROGRESS_UPDATE_INTERVAL } = require("../config");
const { editMarkdown, formatRichMessage, escapeMarkdown, text } = require("./formatting");
const { richButton } = require("./rich_message");

const lastUpdate = new Map();

/**
 * Update a progress message, throttled to avoid Telegram rate limits.
 * `seconds` is derived from `Date.now()` like the Python `time.time()`.
 *
 * The percentage is rendered as a Rich Message line with an inline button that
 * copies the running command, so the progress card stays self-contained.
 */
async function progressCallback(event, current, total, action = "Memproses download") {
  const msgId = event.id;
  const now = Date.now() / 1000;
  const previous = lastUpdate.get(msgId);
  if (previous != null && now - previous < PROGRESS_UPDATE_INTERVAL) return;

  const pct = total > 0 ? Math.trunc((current / total) * 100) : 0;
  const message = formatRichMessage({
    title: `⏳ ${escapeMarkdown(action)}`,
    details: [
      text.join(
        text.raw(`<b>Progres:</b> <code>${pct}%</code> `),
        text.button(richButton("Salin Progres", { copy_text: `${pct}%` }, "link")),
      ),
    ],
    compact: true,
  });
  try {
    await editMarkdown(event, message);
    lastUpdate.set(msgId, now);
  } catch {
    /* ignore */
  }
}

function clearProgress(msgId) {
  lastUpdate.delete(msgId);
}

module.exports = { progressCallback, clearProgress };

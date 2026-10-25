"use strict";
/** URL detection and string helpers — Node.js port of `utils/helpers.py`. */

function isYouTubeUrl(text) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(
    String(text ?? "").trim(),
  );
}

function isFacebookUrl(text) {
  return /^https?:\/\/(www\.)?(facebook\.com|fb\.watch|fb\.com|m\.facebook\.com|fb\.gg)\//i.test(
    String(text ?? "").trim(),
  );
}

function isSpotifyUrl(text) {
  return /^https?:\/\/open\.spotify\.com\/track\//i.test(String(text ?? "").trim());
}

function sanitizeFilename(name, maxLen = 80) {
  return String(name ?? "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .slice(0, maxLen);
}

/** Clean a title: underscores to spaces, collapse whitespace. */
function cleanTitle(title) {
  if (!title) return title;
  return String(title).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  if (value <= 0) return "N/A";
  const total = Math.floor(value);
  let remaining = total;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Human "time left" label for an absolute expiry.
 * Used by tables/cards that show how long something stays valid.
 *
 * @param {number|Date} expiresAt  Unix seconds (or ms), or a Date
 * @param {number} [now]           reference time in ms (tests)
 * @returns {string} e.g. "2 hari 3 jam", "45 menit", "kedaluwarsa"
 */
function fmtRemaining(expiresAt, now = Date.now()) {
  const ms = toMillis(expiresAt);
  if (ms == null) return "N/A";
  const diff = ms - now;
  if (diff <= 0) return "kedaluwarsa";
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} hari`);
  if (hours) parts.push(`${hours} jam`);
  if (!days && minutes) parts.push(`${minutes} menit`);
  if (!parts.length) return "kurang dari 1 menit";
  return parts.join(" ");
}

/**
 * Format an absolute time for display.
 * @param {number|Date} value  Unix seconds (or ms), or a Date
 * @param {object} [options]   `{ timeZone, locale }`
 * @returns {string} e.g. "24/10/2026 20.15"
 */
function fmtTime(value, options = {}) {
  const ms = toMillis(value);
  if (ms == null) return "N/A";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "N/A";
  try {
    return new Intl.DateTimeFormat(options.locale || "id-ID", {
      timeZone: options.timeZone || "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Unix seconds / milliseconds / Date → milliseconds (null when unusable). */
function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Values below 1e12 are Unix seconds; above are milliseconds.
  return number < 1e12 ? number * 1000 : number;
}

module.exports = {
  isYouTubeUrl,
  isFacebookUrl,
  isSpotifyUrl,
  sanitizeFilename,
  cleanTitle,
  formatDuration,
  fmtRemaining,
  fmtTime,
  toMillis,
  mediaCaption,
};

/** Caption block for Telegram download messages. */
function mediaCaption(title, details = []) {
  const body = details.filter(Boolean).join("\n");
  return body ? `${title}\n\n${body}` : title;
}

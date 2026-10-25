"use strict";
/**
 * Central configuration.
 *
 * Two *different* credentials live here and they must never be mixed:
 *
 *   1. Userbot session (MTProto)  → `api_id` + `api_hash` + `session/userbot.session`
 *      Created at https://my.telegram.org. This is what logs in as a *person*.
 *   2. Telegram Bot API token     → `BOT_TOKEN` (env) or `session/config.json → bot_token`
 *      Created by @BotFather. This is what powers Inline Mode, the companion
 *      menu and the Rich Message renderer. It can NEVER log in as a user.
 *
 * A bot token therefore is *not* accepted as `api_hash` (see
 * `validateUserCredentials`), and the token is never hard-coded in the source:
 * it is read from the environment (optionally a local `.env`) or from the
 * session config file written by `saveBotToken()`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT_DIR = __dirname;

/* ------------------------------------------------------------------ *
 * Optional `.env` loader (no dependency)                              *
 * ------------------------------------------------------------------ */
/**
 * Load `KEY=VALUE` pairs from `<root>/.env` into `process.env`.
 * Real environment variables always win, so a shell export is never
 * overwritten by a stale file.
 */
function loadEnvFile(file = path.join(ROOT_DIR, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const applied = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}

loadEnvFile();

const CONFIG_FILE = path.join(ROOT_DIR, "session", "config.json");
const SESSION_NAME = path.join(ROOT_DIR, "session", "userbot");
const TEMP_DIR = path.join(ROOT_DIR, "temp");
const LOG_DIR = path.join(ROOT_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "activity.log");
const INLINE_LOG_FILE = path.join(LOG_DIR, "inline.log");
const LOG_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Jakarta";
const BOT_VERSION = process.env.BOT_VERSION || "1.0.0";
const PROCESS_STARTED_AT = performance.now();

// Telegram file size limit (2GB for premium, 50MB for normal - use 50MB as safe default)
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Request timeout
const REQUEST_TIMEOUT = 120;

// Progress update interval (seconds) to avoid rate limit
const PROGRESS_UPDATE_INTERVAL = 3;

// ------------------------------------------------------------------ //
// Rich Message transport (Bot API 10.3)                               //
// ------------------------------------------------------------------ //
// A userbot session (MTProto *user* account) cannot call the Bot API
// `sendRichMessage` method, and a bot token cannot answer as the user account.
// The bot token is therefore used only as a *renderer*: it validates and can
// deliver Rich Message payloads, while every command response still comes from
// the userbot account so the conversation stays in the userbot.
//
//   "userbot" (default) – render Rich Messages locally, send via GramJS
//   "bot"               – try sendRichMessage first, fall back to GramJS
//   "off"               – never contact the Bot API
const RICH_TRANSPORT = (process.env.USERBOT_RICH_TRANSPORT || "userbot").toLowerCase();

/** Bot API base URL (override for local Bot API servers / tests). */
const BOT_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

/* ------------------------------------------------------------------ *
 * Config file                                                         *
 * ------------------------------------------------------------------ */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {
    return {};
  }
  return {};
}

/** Atomically merge `patch` into the session config file. */
function updateConfig(patch) {
  const existing = loadConfig();
  const payload = JSON.stringify({ ...existing, ...patch }, null, 2);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
  return { ...existing, ...patch };
}

/** Read one config value (undefined when absent). */
function getConfigValue(key) {
  return loadConfig()[key];
}

/** Persist one config value atomically. */
function setConfigValue(key, value) {
  return updateConfig({ [key]: value })[key];
}

/* ------------------------------------------------------------------ *
 * Bot token resolution                                               *
 * ------------------------------------------------------------------ */
/** `123456789:AA...` — BotFather token shape. */
const BOT_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{25,}$/;

/** True when `value` looks like a Telegram Bot API token. */
function isBotToken(value) {
  return BOT_TOKEN_RE.test(String(value == null ? "" : value).trim());
}

/**
 * Resolve the Bot API token.
 * Order: `BOT_TOKEN` env → `TELEGRAM_BOT_TOKEN` env → `session/config.json`.
 * Never falls back to a literal token: absence simply disables Bot API
 * features (inline mode, companion menu, rich renderer).
 */
function resolveBotToken() {
  const fromEnv = String(process.env.BOT_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const fromLegacyEnv = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (fromLegacyEnv) return fromLegacyEnv;
  const cfg = loadConfig();
  const stored = String(cfg.bot_token || cfg.token || "").trim();
  return stored;
}

const BOT_TOKEN = resolveBotToken();

/** Username the userbot bridge talks to (defaults to the token's own bot). */
const BRIDGE_BOT_USERNAME = String(
  process.env.USERBOT_BRIDGE_BOT || loadConfig().bot_username || "",
)
  .trim()
  .replace(/^@/, "");

/* ------------------------------------------------------------------ *
 * Inline Mode settings                                               *
 * ------------------------------------------------------------------ */
const INLINE_ENABLED = String(process.env.INLINE_ENABLED || "1") !== "0";
const INLINE_CATALOG_FILE =
  process.env.INLINE_CATALOG_FILE || path.join(ROOT_DIR, "session", "inline_catalog.json");
const INLINE_MEDIA_DIR =
  process.env.INLINE_MEDIA_DIR || path.join(ROOT_DIR, "session", "inline_media");
const INLINE_MAX_RESULTS = Math.min(
  50,
  Math.max(1, Number(process.env.INLINE_MAX_RESULTS || 25) || 25),
);
/** Inline results are personal (owner-only) → never cached across users. */
const INLINE_CACHE_TIME = Math.max(0, Number(process.env.INLINE_CACHE_TIME || 0) || 0);
/** Answer deadline; Telegram drops answers that arrive too late. */
const INLINE_ANSWER_TIMEOUT_MS = Number(process.env.INLINE_ANSWER_TIMEOUT_MS || 8000);
/** PID lock so only one process polls the Bot API update stream. */
const BOT_LOCK_FILE = path.join(ROOT_DIR, "session", "bot_poll.lock");

/* ------------------------------------------------------------------ *
 * Session credentials                                                 *
 * ------------------------------------------------------------------ */
/**
 * Guard against using a bot token as MTProto credentials.
 * The Bot API and MTProto are unrelated protocols; a token such as
 * `123456789:AAH…` can never authenticate a user session.
 */
function validateUserCredentials(apiId, apiHash) {
  const id = Number(apiId);
  const hash = String(apiHash == null ? "" : apiHash).trim();
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError("api_id harus berupa angka bulat positif dari my.telegram.org.");
  }
  if (!hash) throw new TypeError("api_hash tidak boleh kosong.");
  if (isBotToken(hash) || /^\d{5,12}:/.test(hash)) {
    throw new TypeError(
      "api_hash terlihat seperti token BotFather. Token bot hanya untuk Bot API " +
        "(BOT_TOKEN), bukan untuk login sesi userbot MTProto.",
    );
  }
  if (!/^[a-f0-9]{32}$/i.test(hash)) {
    throw new TypeError("api_hash harus 32 karakter heksadesimal dari my.telegram.org.");
  }
  return { apiId: id, apiHash: hash };
}

function saveConfig(apiId, apiHash) {
  const { apiId: id, apiHash: hash } = validateUserCredentials(apiId, apiHash);
  // Preserve unrelated keys (bot_token, owner_id, …) that live in the same file.
  updateConfig({ api_id: id, api_hash: hash });
  return { api_id: id, api_hash: hash };
}

/** Persist the Bot API token used by Inline Mode / the renderer. */
function saveBotToken(token) {
  const value = String(token == null ? "" : token).trim();
  if (!isBotToken(value)) {
    throw new TypeError("Token Bot API tidak valid (format: <id>:<secret>).");
  }
  updateConfig({ bot_token: value });
  return value;
}

/**
 * Persist the owner's numeric Telegram id so a *separate* Bot API process
 * (`npm run bot`) can authorize inline queries without an MTProto session.
 */
function saveOwnerId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) return null;
  const cfg = loadConfig();
  const list = Array.isArray(cfg.owner_id) ? [...cfg.owner_id] : [cfg.owner_id].filter(Boolean);
  if (!list.map(Number).includes(value)) list.push(value);
  updateConfig({ owner_id: list.length === 1 ? list[0] : list });
  return value;
}

/** Every configured owner id (env + session config), as numbers. */
function ownerIds() {
  const ids = new Set();
  const push = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  };
  for (const raw of String(process.env.USERBOT_OWNER_ID || "").split(",")) push(raw.trim());
  const cfg = loadConfig();
  const list = Array.isArray(cfg.owner_id) ? cfg.owner_id : [cfg.owner_id];
  for (const raw of list) push(raw);
  return [...ids];
}

module.exports = {
  ROOT_DIR,
  CONFIG_FILE,
  SESSION_NAME,
  TEMP_DIR,
  LOG_DIR,
  LOG_FILE,
  INLINE_LOG_FILE,
  LOG_TIMEZONE,
  BOT_VERSION,
  PROCESS_STARTED_AT,
  MAX_FILE_SIZE,
  REQUEST_TIMEOUT,
  PROGRESS_UPDATE_INTERVAL,
  BOT_API_BASE,
  BOT_TOKEN,
  BRIDGE_BOT_USERNAME,
  RICH_TRANSPORT,
  INLINE_ENABLED,
  INLINE_CATALOG_FILE,
  INLINE_MEDIA_DIR,
  INLINE_MAX_RESULTS,
  INLINE_CACHE_TIME,
  INLINE_ANSWER_TIMEOUT_MS,
  BOT_LOCK_FILE,
  BOT_TOKEN_RE,
  loadEnvFile,
  loadConfig,
  updateConfig,
  getConfigValue,
  setConfigValue,
  isBotToken,
  resolveBotToken,
  validateUserCredentials,
  saveConfig,
  saveBotToken,
  saveOwnerId,
  ownerIds,
};

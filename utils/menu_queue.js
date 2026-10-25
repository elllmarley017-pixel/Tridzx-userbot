"use strict";
/**
 * Command queue between the Bot API process and the userbot.
 *
 * Why a queue is needed
 * ---------------------
 * A native `InlineKeyboardButton` callback is delivered to the **bot**, but the
 * command must be executed by the **userbot** (the MTProto account owns the
 * session, the credentials and the chat). The two run as separate processes, so
 * the bot cannot call a userbot handler directly.
 *
 * Flow
 * ----
 *   user taps a Rich Button → callback_query (bot process)
 *                              │ enqueue({chat_id, message_id, action, arg, requested_by})
 *                              ▼
 *                    session/menu_queue.json
 *                              │ polled every second
 *                              ▼
 *   userbot runs the handler for `action` directly (utils/telegram.runAction)
 *
 * No command text is ever sent to the chat: the button *is* the command.
 *
 * The file is written atomically and claims are done with a rename, so two
 * processes can never execute the same entry twice.
 */
const fs = require("node:fs");
const path = require("node:path");

const { SESSION_NAME } = require("../config");

const QUEUE_FILE = process.env.USERBOT_MENU_QUEUE || path.join(path.dirname(SESSION_NAME), "menu_queue.json");
const PROCESSED_FILE = `${QUEUE_FILE}.done`;

/** Entries older than this are dropped (a stale tap must not fire later). */
const MAX_AGE_MS = Number(process.env.USERBOT_MENU_QUEUE_TTL_MS || 60_000);
const MAX_ENTRIES = 100;

const EMPTY = () => ({ next_id: 1, entries: [] });

function ensureDir() {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
}

function normalizeId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n !== 0 ? n : null;
}

function normalize(raw) {
  const state = EMPTY();
  if (!raw || typeof raw !== "object") return state;
  const nextId = Number(raw.next_id);
  if (Number.isInteger(nextId) && nextId > 0) state.next_id = nextId;
  for (const entry of Array.isArray(raw.entries) ? raw.entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const chatId = normalizeId(entry.chat_id);
    const action = String(entry.action || "").trim();
    if (chatId == null || !action) continue;
    state.entries.push({
      id: Number(entry.id) || 0,
      chat_id: chatId,
      message_id: normalizeId(entry.message_id),
      action,
      arg: String(entry.arg || "").slice(0, 512),
      requested_by: normalizeId(entry.requested_by),
      created_at: Number(entry.created_at) || Date.now(),
    });
  }
  return state;
}

function load() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return EMPTY();
    return normalize(JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")));
  } catch {
    return EMPTY();
  }
}

function save(state) {
  ensureDir();
  const payload = JSON.stringify(normalize(state), null, 2);
  const tmp = `${QUEUE_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, QUEUE_FILE);
  return state;
}

/** Drop expired entries; returns the fresh state. */
function prune(state = load()) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const before = state.entries.length;
  state.entries = state.entries.filter((entry) => entry.created_at >= cutoff);
  return { state, removed: before - state.entries.length };
}

/**
 * Enqueue one button action for the userbot.
 * @param {{chatId: number|string, action: string, arg?: string, messageId?: number,
 *          requestedBy?: number|string}} input
 * @returns {{id: number, entry: object}}
 */
function enqueue(input = {}) {
  const chatId = normalizeId(input.chatId);
  const action = String(input.action || "").trim();
  if (chatId == null) throw new TypeError("chat_id tidak valid.");
  if (!action.startsWith(".")) throw new TypeError("Aksi userbot harus berupa nama fitur (mis. .ytmp4).");

  const { state } = prune(load());
  const entry = {
    id: state.next_id,
    chat_id: chatId,
    message_id: normalizeId(input.messageId),
    action: action.slice(0, 128),
    arg: String(input.arg || "").trim().slice(0, 512),
    requested_by: normalizeId(input.requestedBy),
    created_at: Date.now(),
  };
  state.entries.push(entry);
  state.next_id += 1;
  if (state.entries.length > MAX_ENTRIES) {
    state.entries = state.entries.slice(-MAX_ENTRIES);
  }
  save(state);
  return { id: entry.id, entry };
}

/** Read every pending entry (non-destructive). */
function pending() {
  return prune(load()).state.entries;
}

/**
 * Atomically take all pending entries.
 * A rename is used so two readers cannot claim the same batch.
 */
function drain() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  const claim = `${QUEUE_FILE}.claim`;
  try {
    fs.renameSync(QUEUE_FILE, claim);
  } catch {
    return [];
  }
  let state = EMPTY();
  try {
    state = normalize(JSON.parse(fs.readFileSync(claim, "utf8")));
  } catch {
    state = EMPTY();
  } finally {
    try {
      fs.rmSync(claim, { force: true });
    } catch {
      /* ignore */
    }
  }
  const { state: fresh } = prune(state);
  const claimed = fresh.entries;
  const remaining = { ...fresh, entries: [] };
  if (remaining.next_id) save(remaining);
  return claimed;
}

/** Mark one entry as processed (audit trail, bounded). */
function markProcessed(entry) {
  try {
    ensureDir();
    const line = JSON.stringify({
      id: entry.id,
      chat_id: entry.chat_id,
      action: entry.action,
      requested_by: entry.requested_by,
      processed_at: new Date().toISOString(),
    });
    fs.appendFileSync(PROCESSED_FILE, `${line}\n`, "utf8");
    const stat = fs.statSync(PROCESSED_FILE);
    if (stat.size > 256 * 1024) {
      const lines = fs.readFileSync(PROCESSED_FILE, "utf8").trim().split("\n");
      fs.writeFileSync(PROCESSED_FILE, `${lines.slice(-200).join("\n")}\n`, "utf8");
    }
  } catch {
    /* logging must never break execution */
  }
}

function clear() {
  save(EMPTY());
  return true;
}

module.exports = {
  QUEUE_FILE,
  PROCESSED_FILE,
  MAX_AGE_MS,
  MAX_ENTRIES,
  load,
  save,
  prune,
  enqueue,
  pending,
  drain,
  markProcessed,
  clear,
};

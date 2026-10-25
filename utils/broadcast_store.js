"use strict";
/**
 * Persistent state for the broadcast feature (`.bcall`, `.delay`, `.addbl`).
 *
 * Stored as JSON next to the session file so it survives restarts and is easy
 * to inspect/back up. Writes are atomic (tmp file + rename) and the whole file
 * is re-read on each mutation so two processes cannot silently clobber each
 * other's blacklist.
 *
 * Shape:
 *   {
 *     "delay_ms": 1500,
 *     "blacklist": [{ "id": -100123, "title": "Spam", "added_at": "…" }],
 *     "targets":   [{ "id": -100456, "title": "News", "added_at": "…" }]
 *   }
 */
const fs = require("node:fs");
const path = require("node:path");

const { SESSION_NAME } = require("../config");

const STORE_FILE = path.join(path.dirname(SESSION_NAME), "broadcast.json");

/**
 * Bounds for `.delay`.
 *
 * The floor is 1 ms: `.delay 1` must mean 1 millisecond. Flood control is
 * handled by the sender (flood-wait backoff), not by silently raising the value
 * the owner asked for.
 */
const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 60_000;
const DEFAULT_DELAY_MS = 1500;

const EMPTY = () => ({ delay_ms: DEFAULT_DELAY_MS, blacklist: [], targets: [] });

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function normalizeId(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
}

/** Coerce an on-disk payload into a well-formed state object. */
function normalize(raw) {
  const state = EMPTY();
  if (!raw || typeof raw !== "object") return state;

  const delay = Number(raw.delay_ms);
  if (Number.isFinite(delay)) {
    state.delay_ms = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.trunc(delay)));
  }

  for (const key of ["blacklist", "targets"]) {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    const seen = new Set();
    for (const entry of list) {
      const id = normalizeId(entry && (entry.id ?? entry.chat_id ?? entry));
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      state[key].push({
        id,
        title: typeof entry?.title === "string" ? entry.title : "",
        added_at: typeof entry?.added_at === "string" ? entry.added_at : "",
      });
    }
  }
  return state;
}

/** Read the state from disk (never throws; returns defaults on error). */
function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return EMPTY();
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return normalize(raw);
  } catch {
    return EMPTY();
  }
}

/** Persist the state atomically. Throws only on real filesystem errors. */
function save(state) {
  ensureDir();
  const payload = JSON.stringify(normalize(state), null, 2);
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, STORE_FILE);
  return state;
}

/** Read-modify-write helper that always starts from fresh disk state. */
function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return result === undefined ? state : result;
}

/* ------------------------------------------------------------------ *
 * Delay                                                               *
 * ------------------------------------------------------------------ */
function getDelay() {
  return load().delay_ms;
}

/**
 * Set the inter-message delay, in milliseconds.
 *
 * The value is applied verbatim (`1` → 1 ms, `1000` → 1000 ms). The running
 * broadcast reads it on every iteration, so a change also affects a run that is
 * already in flight.
 */
function setDelay(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) {
    throw new RangeError("Delay harus berupa angka.");
  }
  const ms = Math.trunc(requested);
  if (ms < MIN_DELAY_MS) throw new RangeError(`Delay minimal ${MIN_DELAY_MS} milidetik.`);
  if (ms > MAX_DELAY_MS) {
    throw new RangeError(`Delay maksimal ${MAX_DELAY_MS} ms (${MAX_DELAY_MS / 1000} detik).`);
  }
  update((state) => {
    state.delay_ms = ms;
  });
  return { requested: ms, applied: ms, clamped: false };
}

/* ------------------------------------------------------------------ *
 * Blacklist                                                           *
 * ------------------------------------------------------------------ */
function isBlacklisted(id) {
  const target = normalizeId(id);
  if (target == null) return false;
  return load().blacklist.some((entry) => entry.id === target);
}

function blacklist() {
  return load().blacklist;
}

/**
 * Add a chat to the blacklist.
 * @returns {{added: boolean, entry: object}}
 */
function addBlacklist(id, title = "") {
  const target = normalizeId(id);
  if (target == null) throw new TypeError("Chat ID tidak valid.");
  let added = false;
  const entry = update((state) => {
    const existing = state.blacklist.find((item) => item.id === target);
    if (existing) {
      if (title && !existing.title) existing.title = title;
      return existing;
    }
    added = true;
    const created = { id: target, title: String(title || ""), added_at: new Date().toISOString() };
    state.blacklist.push(created);
    return created;
  });
  return { added, entry };
}

/** Remove a chat from the blacklist. */
function removeBlacklist(id) {
  const target = normalizeId(id);
  if (target == null) return false;
  let removed = false;
  update((state) => {
    const before = state.blacklist.length;
    state.blacklist = state.blacklist.filter((item) => item.id !== target);
    removed = state.blacklist.length !== before;
  });
  return removed;
}

/* ------------------------------------------------------------------ *
 * Targets (allowed broadcast destinations)                            *
 * ------------------------------------------------------------------ */
function targets() {
  return load().targets;
}

function addTarget(id, title = "") {
  const target = normalizeId(id);
  if (target == null) throw new TypeError("Chat ID tidak valid.");
  let added = false;
  const entry = update((state) => {
    const existing = state.targets.find((item) => item.id === target);
    if (existing) {
      if (title && !existing.title) existing.title = title;
      return existing;
    }
    added = true;
    const created = { id: target, title: String(title || ""), added_at: new Date().toISOString() };
    state.targets.push(created);
    return created;
  });
  return { added, entry };
}

function removeTarget(id) {
  const target = normalizeId(id);
  if (target == null) return false;
  let removed = false;
  update((state) => {
    const before = state.targets.length;
    state.targets = state.targets.filter((item) => item.id !== target);
    removed = state.targets.length !== before;
  });
  return removed;
}

module.exports = {
  STORE_FILE,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  DEFAULT_DELAY_MS,
  normalizeId,
  load,
  save,
  update,
  getDelay,
  setDelay,
  isBlacklisted,
  blacklist,
  addBlacklist,
  removeBlacklist,
  targets,
  addTarget,
  removeTarget,
};

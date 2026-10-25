"use strict";
/**
 * Persistent access lists: extra owners and premium users.
 *
 * Stored next to the session (`session/access.json`) so it survives restarts and
 * stays independent from `config.json` (which the bot process also writes).
 *
 *   {
 *     "owners":  [{ "id": 123, "added_at": "...", "added_by": 456 }],
 *     "premium": [{ "id": 789, "days": 30, "started_at": "...",
 *                   "expires_at": "...", "added_by": 456 }]
 *   }
 *
 * Premium expiry is evaluated on read: once `expires_at` is in the past the
 * entry is no longer premium (and is pruned on the next write), so access is
 * revoked automatically without a background job.
 */
const fs = require("node:fs");
const path = require("node:path");

const { SESSION_NAME } = require("../config");

const ACCESS_FILE = process.env.USERBOT_ACCESS_FILE || path.join(path.dirname(SESSION_NAME), "access.json");

/** Hard bounds so a typo cannot create a 100-year premium or a huge list. */
const MAX_PREMIUM_DAYS = 3650;
const MAX_ENTRIES = 500;

const EMPTY = () => ({ owners: [], premium: [] });

function ensureDir() {
  fs.mkdirSync(path.dirname(ACCESS_FILE), { recursive: true });
}

/** Telegram user id: a positive integer (may exceed 32 bits). */
function normalizeId(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** ISO timestamp or null. */
function normalizeDate(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function normalize(raw) {
  const state = EMPTY();
  if (!raw || typeof raw !== "object") return state;

  const seenOwners = new Set();
  for (const entry of Array.isArray(raw.owners) ? raw.owners : []) {
    const id = normalizeId(entry && (entry.id ?? entry));
    if (id == null || seenOwners.has(id)) continue;
    seenOwners.add(id);
    state.owners.push({
      id,
      added_at: normalizeDate(entry.added_at) || "",
      added_by: normalizeId(entry.added_by),
    });
  }

  const seenPremium = new Set();
  for (const entry of Array.isArray(raw.premium) ? raw.premium : []) {
    const id = normalizeId(entry && (entry.id ?? entry));
    if (id == null || seenPremium.has(id)) continue;
    const expires = normalizeDate(entry.expires_at);
    if (!expires) continue; // an entry without expiry is meaningless
    seenPremium.add(id);
    state.premium.push({
      id,
      days: Math.max(1, Math.trunc(Number(entry.days) || 1)),
      started_at: normalizeDate(entry.started_at) || "",
      expires_at: expires,
      added_by: normalizeId(entry.added_by),
    });
  }
  return state;
}

function load() {
  try {
    if (!fs.existsSync(ACCESS_FILE)) return EMPTY();
    return normalize(JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8")));
  } catch {
    return EMPTY();
  }
}

function save(state) {
  ensureDir();
  const payload = JSON.stringify(normalize(state), null, 2);
  const tmp = `${ACCESS_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, ACCESS_FILE);
  return state;
}

/** Read-modify-write from fresh disk state. */
function update(mutator) {
  const state = load();
  mutator(state);
  return save(state);
}

/* ------------------------------------------------------------------ *
 * Owners                                                              *
 * ------------------------------------------------------------------ */
/** Extra owners (excluding the primary owner, which lives in config). */
function extraOwners() {
  return load().owners;
}

/** Every extra owner id. */
function extraOwnerIds() {
  return load().owners.map((entry) => entry.id);
}

/**
 * Add an owner.
 * @returns {{added: boolean, id: number}}
 */
function addOwner(id, options = {}) {
  const target = normalizeId(id);
  if (target == null) throw new RangeError("ID owner tidak valid (harus angka positif).");
  let added = false;
  update((state) => {
    if (state.owners.some((entry) => entry.id === target)) return;
    if (state.owners.length >= MAX_ENTRIES) {
      throw new RangeError(`Maksimal ${MAX_ENTRIES} owner tambahan.`);
    }
    state.owners.push({
      id: target,
      added_at: new Date().toISOString(),
      added_by: normalizeId(options.by),
    });
    added = true;
  });
  return { added, id: target };
}

/**
 * Remove an owner.
 * The primary owner is never stored here, so it can never be removed by this
 * function; the caller additionally guards against removing it.
 *
 * @returns {{removed: boolean, id: number}}
 */
function removeOwner(id) {
  const target = normalizeId(id);
  if (target == null) throw new RangeError("ID owner tidak valid (harus angka positif).");
  let removed = false;
  update((state) => {
    const before = state.owners.length;
    state.owners = state.owners.filter((entry) => entry.id !== target);
    removed = state.owners.length !== before;
  });
  return { removed, id: target };
}

/* ------------------------------------------------------------------ *
 * Premium                                                             *
 * ------------------------------------------------------------------ */
/** Drop expired entries (called before every write). */
function pruneExpired(state, now = Date.now()) {
  const before = state.premium.length;
  state.premium = state.premium.filter((entry) => Date.parse(entry.expires_at) > now);
  return before - state.premium.length;
}

/**
 * Add (or extend) premium access.
 * Extending an active entry adds the new days on top of the current expiry.
 *
 * @param {number|string} id
 * @param {number|string} days
 * @returns {{id:number, days:number, startedAt:string, expiresAt:string, extended:boolean}}
 */
function addPremium(id, days, options = {}) {
  const target = normalizeId(id);
  if (target == null) throw new RangeError("ID pengguna tidak valid (harus angka positif).");
  const amount = Math.trunc(Number(days));
  if (!Number.isFinite(amount) || amount < 1) {
    throw new RangeError("Durasi premium minimal 1 hari.");
  }
  if (amount > MAX_PREMIUM_DAYS) {
    throw new RangeError(`Durasi premium maksimal ${MAX_PREMIUM_DAYS} hari.`);
  }

  const now = Date.now();
  let result = null;
  update((state) => {
    pruneExpired(state, now);
    const existing = state.premium.find((entry) => entry.id === target);
    const base = existing ? Math.max(Date.parse(existing.expires_at), now) : now;
    const expires = new Date(base + amount * 86400000).toISOString();
    if (existing) {
      existing.days += amount;
      existing.expires_at = expires;
      existing.added_by = normalizeId(options.by) ?? existing.added_by;
      result = {
        id: target,
        days: existing.days,
        startedAt: existing.started_at,
        expiresAt: expires,
        extended: true,
      };
    } else {
      if (state.premium.length >= MAX_ENTRIES) {
        throw new RangeError(`Maksimal ${MAX_ENTRIES} pengguna premium.`);
      }
      const entry = {
        id: target,
        days: amount,
        started_at: new Date(now).toISOString(),
        expires_at: expires,
        added_by: normalizeId(options.by),
      };
      state.premium.push(entry);
      result = { id: target, days: amount, startedAt: entry.started_at, expiresAt: expires, extended: false };
    }
  });
  return result;
}

/** Remove premium access. @returns {{removed: boolean, id: number}} */
function removePremium(id) {
  const target = normalizeId(id);
  if (target == null) throw new RangeError("ID pengguna tidak valid (harus angka positif).");
  let removed = false;
  update((state) => {
    const before = state.premium.length;
    state.premium = state.premium.filter((entry) => entry.id !== target);
    removed = state.premium.length !== before;
  });
  return { removed, id: target };
}

/**
 * Premium record for a user, or null when absent/expired.
 * Expiry is evaluated here, so an expired user is never premium.
 */
function premiumOf(id, now = Date.now()) {
  const target = normalizeId(id);
  if (target == null) return null;
  const entry = load().premium.find((item) => item.id === target);
  if (!entry) return null;
  const expires = Date.parse(entry.expires_at);
  if (!(expires > now)) return null;
  return { ...entry, remainingMs: expires - now };
}

function isPremium(id, now = Date.now()) {
  return premiumOf(id, now) !== null;
}

/** All active premium entries (expired ones filtered out). */
function premiumList(now = Date.now()) {
  return load().premium
    .filter((entry) => Date.parse(entry.expires_at) > now)
    .map((entry) => ({ ...entry, remainingMs: Date.parse(entry.expires_at) - now }));
}

module.exports = {
  ACCESS_FILE,
  MAX_PREMIUM_DAYS,
  MAX_ENTRIES,
  normalizeId,
  load,
  save,
  extraOwners,
  extraOwnerIds,
  addOwner,
  removeOwner,
  addPremium,
  removePremium,
  premiumOf,
  premiumList,
  isPremium,
  pruneExpired,
};

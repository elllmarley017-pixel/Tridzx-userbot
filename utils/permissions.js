"use strict";
/**
 * Per-command authorization for the userbot.
 *
 * A userbot normally only reacts to messages its own account sends, because
 * `command()` filtered on `outgoing`. Requirement: the bot must also answer
 * commands written by *other* users who interact with it — while keeping
 * account-mutating, costly or privacy-sensitive features owner-only.
 *
 * Model
 * -----
 *   owner   – the account itself (`client.getMe()`), plus any id listed in
 *             `USERBOT_OWNER_ID` / `session/config.json` → `owner_id`.
 *   public  – commands in `PUBLIC_COMMANDS`; usable by anyone the account can
 *             see, subject to a per-user cooldown.
 *   owner   – everything else (`SENSITIVE_COMMANDS` is documented explicitly).
 *
 * The policy is deliberately "deny by default": a feature that is not listed
 * as public requires the owner. New handlers are therefore safe by default.
 *
 * Buttons and text share one policy: `accessLevel()` is keyed on the feature
 * name (`.ytmp4`), whether it arrives as a typed command or as a Rich Button.
 */
const fs = require("node:fs");
const path = require("node:path");

const { SESSION_NAME, loadConfig } = require("../config");

/** Access lists (extra owners, premium). Loaded lazily to avoid a cycle. */
function accessStore() {
  try {
    return require("./access_store");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Policy                                                              *
 * ------------------------------------------------------------------ */

/**
 * Commands that anyone may run. These are read-only lookups / downloads: they
 * never mutate the account, never touch private history, and never spend the
 * owner's credentials on unbounded work.
 */
const PUBLIC_COMMANDS = new Set([
  ".start",
  ".infobot",
  ".ytsearch",
  ".ytmp4",
  ".ytmp3",
  ".fb",
  ".spotify",
  ".videy",
  ".pin",
  ".tt",
  ".ttpic",
  ".mediafire",
  ".github",
  ".ttsearch",
  ".ttstalker",
  ".githubstalker",
  ".robloxstalker",
  ".igstalker",
  ".xstalker",
  ".fbstalker",
  ".pinstalker",
  ".ytstalker",
  ".extrastalker",
  ".toimg",
  ".togif",
  ".tomp3",
  ".toqr",
  ".tovn",
]);

/**
 * Sensitive commands — owner only, always.
 *
 *  .bcall / .delay / .addbl  mass messaging + its safety controls
 *  .getchat                  exports private chat history
 *  .stiker / .s              writes to the account's shared sticker pack
 *  .ai                       spends the owner's API key and creates files
 *  .id / .telesearch         Telegram account-level lookups (rate-limit risk)
 *  .inline                   inline catalogue + Bot API uploads/sends
 */
const SENSITIVE_COMMANDS = new Set([
  ".bcall",
  ".bc24h",
  ".delay24",
  ".addowner",
  ".delowner",
  ".addprem",
  ".delprem",
  ".ownerlist",
  ".listprem",
  ".listowner",
  ".ghupload",
  ".premlist",
  ".delay",
  ".addbl",
  ".getchat",
  ".stiker",
  ".s",
  ".ai",
  ".id",
  ".inline",
]);

/**
 * Features whose result is private to the person who asked.
 *
 * These stay usable by everyone, but the answer is delivered to the requester
 * instead of the shared chat (`.id`, `.telesearch`, `.getchat`).
 */
const PRIVATE_RESULT_COMMANDS = new Set([".id", ".telesearch", ".getchat", ".extrastalker"]);

/**
 * Is this feature usable by a non-owner?
 * Buttons use the same answer as typed commands so the two can never diverge.
 */
function isPublicFeature(name) {
  return accessLevel(name) === "public";
}

/**
 * Features that premium users may run in addition to `PUBLIC_COMMANDS`.
 * Premium never grants owner-only features (account-mutating commands).
 */
const PREMIUM_COMMANDS = new Set([
  ".telesearch",
  ".extrastalker",
  ".inline",
]);

/** Non-owner cooldown between commands, per user (milliseconds). */
const PUBLIC_COOLDOWN_MS = Number(process.env.USERBOT_PUBLIC_COOLDOWN_MS || 3000);

/** How long a denial notice is cached per chat, to avoid spamming. */
const DENIAL_CACHE_MS = 60_000;

const CONFIG_FILE = path.join(path.dirname(SESSION_NAME), "config.json");

/* ------------------------------------------------------------------ *
 * Owner resolution                                                    *
 * ------------------------------------------------------------------ */
function normalizeId(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return null;
}

function configuredOwnerIds() {
  const ids = new Set();
  for (const raw of String(process.env.USERBOT_OWNER_ID || "").split(",")) {
    const id = normalizeId(raw);
    if (id != null) ids.add(id);
  }
  try {
    const cfg = loadConfig();
    const list = Array.isArray(cfg.owner_id) ? cfg.owner_id : [cfg.owner_id];
    for (const raw of list) {
      const id = normalizeId(raw);
      if (id != null) ids.add(id);
    }
  } catch {
    /* ignore unreadable config */
  }
  return ids;
}

/**
 * Resolve the owner id, caching it on the client.
 * Falls back to the ids configured in env / `session/config.json` when the
 * account has not been fetched yet (e.g. inside a unit test).
 */
async function resolveOwnerIds(client) {
  if (client && client.__ownerIds instanceof Set) return client.__ownerIds;
  const ids = configuredOwnerIds();
  // Owners added at runtime via `.addowner` are owners everywhere.
  const store = accessStore();
  if (store) {
    try {
      for (const id of store.extraOwnerIds()) ids.add(id);
    } catch {
      /* a broken access file must not lock the primary owner out */
    }
  }
  if (client) {
    try {
      const me = client.__me || (await client.getMe());
      if (me) {
        client.__me = me;
        const id = normalizeId(me.id);
        if (id != null) ids.add(id);
      }
    } catch {
      /* offline / test double — rely on configured ids */
    }
  }
  if (client) client.__ownerIds = ids;
  return ids;
}

function setOwner(client, me) {
  if (!client) return;
  client.__me = me;
  const ids = configuredOwnerIds();
  const id = normalizeId(me && me.id);
  if (id != null) ids.add(id);
  const store = accessStore();
  if (store) {
    try {
      for (const extra of store.extraOwnerIds()) ids.add(extra);
    } catch {
      /* ignore */
    }
  }
  client.__ownerIds = ids;
}

/** Drop the cached owner set so a change applies immediately. */
function refreshOwners(client) {
  if (client && client.__ownerIds) delete client.__ownerIds;
}

/** True when the sender of `event` is the account owner. */
async function isOwner(client, event) {
  const owners = await resolveOwnerIds(client);
  if (!owners.size) return false;
  const sender = normalizeId(event?.senderId ?? event?.message?.senderId);
  if (sender != null && owners.has(sender)) return true;
  // Outgoing messages are authored by the account itself.
  const message = event?.message;
  if (message && message.out) {
    const me = normalizeId(client && client.__me && client.__me.id);
    if (me == null || owners.has(me)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Command name / policy                                               *
 * ------------------------------------------------------------------ */
/** `.ytmp4@somebot args` → `.ytmp4` */
function commandName(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith(".")) return "";
  const first = raw.split(/\s+/, 1)[0];
  return first.replace(/@.*$/, "").toLowerCase();
}

function accessLevel(name) {
  if (!name) return "public";
  if (SENSITIVE_COMMANDS.has(name)) return "owner";
  if (PUBLIC_COMMANDS.has(name)) return "public";
  if (PREMIUM_COMMANDS.has(name)) return "premium";
  // Unknown commands are owner-only: deny by default.
  return "owner";
}

/** True when the sender currently has premium access. */
function senderIsPremium(sender, now = Date.now()) {
  const store = accessStore();
  if (!store) return false;
  const id = normalizeId(sender);
  if (id == null) return false;
  try {
    return store.isPremium(id, now);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Cooldown (public commands, non-owner users)                         *
 * ------------------------------------------------------------------ */
const cooldowns = new Map();

function cooldownRemaining(userId) {
  const key = String(userId ?? "");
  const last = cooldowns.get(key);
  if (!last) return 0;
  const remaining = PUBLIC_COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function markCooldown(userId) {
  const key = String(userId ?? "");
  cooldowns.set(key, Date.now());
  // Bound the map so a busy group cannot grow it without limit.
  if (cooldowns.size > 5000) {
    const cutoff = Date.now() - PUBLIC_COOLDOWN_MS;
    for (const [id, at] of cooldowns) if (at < cutoff) cooldowns.delete(id);
  }
}

/* ------------------------------------------------------------------ *
 * Denial de-duplication                                               *
 * ------------------------------------------------------------------ */
const denials = new Map();

/** Returns true when a denial notice should be shown for this chat. */
function shouldNotifyDenial(chat) {
  const key = String(chat ?? "");
  const last = denials.get(key);
  if (last && Date.now() - last < DENIAL_CACHE_MS) return false;
  denials.set(key, Date.now());
  if (denials.size > 2000) {
    const cutoff = Date.now() - DENIAL_CACHE_MS;
    for (const [id, at] of denials) if (at < cutoff) denials.delete(id);
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Main entry                                                          *
 * ------------------------------------------------------------------ */
/**
 * Decide whether `event` may run the command in its text.
 *
 * @returns {Promise<{allowed: boolean, level: string, name: string,
 *                    owner: boolean, reason?: string, retryAfterMs?: number}>}
 */
async function authorize(client, event) {
  const name = commandName(eventText(event));
  const level = accessLevel(name);
  const owner = await isOwner(client, event);

  if (level === "owner" && !owner) {
    return { allowed: false, level, name, owner, reason: "owner-only" };
  }
  if (level === "premium" && !owner) {
    const sender = event?.senderId ?? event?.message?.senderId;
    if (!senderIsPremium(sender)) {
      return { allowed: false, level, name, owner, reason: "premium-only" };
    }
  }
  if (level === "public" && !owner) {
    const sender = event?.senderId ?? event?.message?.senderId;
    const remaining = cooldownRemaining(sender);
    if (remaining > 0) {
      return { allowed: false, level, name, owner, reason: "cooldown", retryAfterMs: remaining };
    }
    markCooldown(sender);
  }
  return { allowed: true, level, name, owner };
}

function eventText(event) {
  const message = event?.message || event;
  return message?.rawText ?? message?.text ?? event?.rawText ?? event?.text ?? "";
}

/** Clear all caches (tests). */
function resetPermissions() {
  cooldowns.clear();
  denials.clear();
}

module.exports = {
  PUBLIC_COMMANDS,
  SENSITIVE_COMMANDS,
  PREMIUM_COMMANDS,
  PUBLIC_COOLDOWN_MS,
  resolveOwnerIds,
  setOwner,
  isOwner,
  refreshOwners,
  senderIsPremium,
  commandName,
  accessLevel,
  isPublicFeature,
  PRIVATE_RESULT_COMMANDS,
  authorize,
  shouldNotifyDenial,
  normalizeId,
  resetPermissions,
  CONFIG_FILE,
};

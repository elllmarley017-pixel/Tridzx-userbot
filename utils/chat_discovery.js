"use strict";
/**
 * Chat discovery for `.bcall`.
 *
 * `.bcall` must reach *every chat the userbot can actually post to*, so the
 * target list is derived from the account's dialog list instead of a manually
 * maintained registry.
 *
 * A dialog is only eligible when Telegram would accept the message:
 *
 *   Users      skipped when the account is itself, a bot, deleted, or the peer
 *              is a bot (bots cannot receive user messages unless they started
 *              the conversation).
 *   Groups     skipped when the account left / was kicked / is deactivated,
 *              or when `defaultBannedRights.sendMessages` is set.
 *   Channels   skipped when it is a broadcast channel the account cannot post
 *              to (not creator/admin) and `defaultBannedRights` forbids it.
 *
 * The enumeration is read-only: nothing is sent here, so a large dialog list
 * costs no message quota.
 */
const { Api } = require("telegram");

/**
 * Upper bound on dialogs inspected per run.
 *
 * Accounts can legitimately own thousands of dialogs; this only exists to stop
 * a runaway loop. Reading dialogs costs no message quota, so the default is
 * generous and the scan reports when it was truncated.
 */
const MAX_DIALOGS = Number(process.env.USERBOT_BCALL_MAX_DIALOGS || 2000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function normalizeId(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

/** True when `rights` forbids sending plain messages. */
function sendForbidden(rights) {
  if (!rights) return false;
  // `sendMessages` is a "not-banned" flag: true means the ban is active.
  return rights.sendMessages === true;
}

/** Human-readable reason a dialog cannot receive a broadcast. */
function ineligibleReason(entity, selfId) {
  if (!entity) return "entity-tidak-tersedia";

  if (entity instanceof Api.User) {
    if (String(entity.id) === String(selfId)) return "akun-sendiri";
    if (entity.bot) return "bot";
    if (entity.deleted) return "akun-terhapus";
    if (entity.restricted && sendForbidden(entity.bannedRights)) return "dibatasi";
    return null;
  }

  if (entity instanceof Api.Chat) {
    if (entity.deactivated) return "grup-nonaktif";
    if (entity.left) return "sudah-keluar";
    if (sendForbidden(entity.defaultBannedRights)) return "pesan-dilarang";
    return null;
  }

  if (entity instanceof Api.Channel) {
    if (entity.left) return "sudah-keluar";
    if (entity.restricted && sendForbidden(entity.bannedRights)) return "dibatasi";
    if (entity.broadcast) {
      // Broadcast channels only accept posts from admins/creator.
      const isAdmin = Boolean(entity.creator) || Boolean(entity.adminRights);
      if (!isAdmin) return "channel-tanpa-izin-posting";
    }
    if (sendForbidden(entity.defaultBannedRights) && !entity.creator && !entity.adminRights) {
      return "pesan-dilarang";
    }
    return null;
  }

  return "tipe-tidak-didukung";
}

/** Short type label for summaries. */
function entityKind(entity) {
  if (!entity) return "unknown";
  if (entity instanceof Api.User) return "user";
  if (entity instanceof Api.Channel) return entity.broadcast ? "channel" : "supergroup";
  if (entity instanceof Api.Chat) return "group";
  return "unknown";
}

/**
 * Enumerate every dialog the account can post to.
 *
 * @param {object} client  GramJS TelegramClient
 * @param {object} [options]
 * @param {number} [options.limit]        max dialogs inspected
 * @param {number} [options.selfId]       the account's own id
 * @param {(n:number)=>void} [options.onProgress]
 * @returns {Promise<{targets: object[], skipped: object, scanned: number}>}
 */
async function discoverChats(client, options = {}) {
  const limit = Math.max(1, Number(options.limit) || MAX_DIALOGS);
  const selfId = options.selfId;
  const onProgress = options.onProgress;

  const targets = [];
  const skipped = {
    self: 0,
    bot: 0,
    deleted: 0,
    left: 0,
    forbidden: 0,
    channelNoPost: 0,
    unsupported: 0,
    noEntity: 0,
  };
  const seen = new Set();
  let scanned = 0;
  let truncated = false;

  const reasonBucket = {
    "akun-sendiri": "self",
    bot: "bot",
    "akun-terhapus": "deleted",
    "sudah-keluar": "left",
    "grup-nonaktif": "left",
    dibatasi: "forbidden",
    "pesan-dilarang": "forbidden",
    "channel-tanpa-izin-posting": "channelNoPost",
    "tipe-tidak-didukung": "unsupported",
    "entity-tidak-tersedia": "noEntity",
  };

  let iterator;
  try {
    iterator = client.iterDialogs({ limit });
  } catch (err) {
    throw new Error(`Tidak dapat membaca daftar chat: ${err.message}`);
  }

  for await (const dialog of iterator) {
    // Stop *before* counting an extra dialog so `scanned` never exceeds limit.
    if (scanned >= limit) {
      truncated = true;
      break;
    }
    scanned += 1;
    if (onProgress && scanned % 25 === 0) onProgress(scanned);

    const entity = dialog && dialog.entity;
    if (!entity) {
      skipped.noEntity += 1;
      continue;
    }

    const id = normalizeId(dialog.id ?? entity.id);
    if (id == null) {
      skipped.noEntity += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const reason = ineligibleReason(entity, selfId);
    if (reason) {
      skipped[reasonBucket[reason] || "unsupported"] += 1;
      continue;
    }

    targets.push({
      id,
      title: dialog.title || dialog.name || "",
      kind: entityKind(entity),
      entity,
    });
  }

  return { targets, skipped, scanned, truncated };
}

module.exports = {
  MAX_DIALOGS,
  discoverChats,
  ineligibleReason,
  entityKind,
  sendForbidden,
  normalizeId,
};

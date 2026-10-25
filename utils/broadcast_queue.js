"use strict";
/**
 * Broadcast delivery queue for `.bcall`.
 *
 * Design goals (per the feature spec):
 *   - a real queue with a fixed inter-message delay (`.delay`)
 *   - per-chat error isolation: one failing chat never aborts the run
 *   - progress reporting, plus a cooperative stop mechanism
 *   - hard guard rails so the account cannot be pushed into FLOOD_WAIT
 *   - duplicate suppression (both per run and across runs)
 *
 * Telegram limits are enforced rather than trusted:
 *   - minimum gap between two outgoing messages (`MIN_DELAY_MS`)
 *   - `FLOOD_WAIT_X` is honoured by sleeping, and repeated flood waits abort
 *   - a per-run cap on how many chats may be attempted
 *   - blacklisted chats are skipped before the queue is even built
 */
const store = require("./broadcast_store");

/** Hard ceiling on chats per broadcast run. */
const MAX_TARGETS_PER_RUN = Number(process.env.USERBOT_BCALL_MAX_TARGETS || 200);

/** Abort the run after this many consecutive FLOOD_WAIT responses. */
const MAX_CONSECUTIVE_FLOODS = 3;

/** Give up waiting when Telegram asks us to sleep longer than this. */
const MAX_FLOOD_WAIT_SECONDS = Number(process.env.USERBOT_BCALL_MAX_FLOOD_WAIT || 300);

/** Duplicate suppression window for the same content (milliseconds). */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/* ------------------------------------------------------------------ *
 * Errors                                                              *
 * ------------------------------------------------------------------ */
class BroadcastError extends Error {
  constructor(message) {
    super(message);
    this.name = "BroadcastError";
  }
}

class BroadcastCancelled extends BroadcastError {
  constructor(reason = "Broadcast dihentikan.") {
    super(reason);
    this.name = "BroadcastCancelled";
  }
}

/** Extract `FLOOD_WAIT_X` seconds, or 0 when absent. */
function floodWaitSeconds(err) {
  const text = String((err && err.message) || err || "");
  const match = /FLOOD_WAIT_(\d+)/i.exec(text);
  return match ? Number(match[1]) : 0;
}

function isFloodWait(err) {
  return floodWaitSeconds(err) > 0;
}

/* ------------------------------------------------------------------ *
 * Duplicate suppression                                               *
 * ------------------------------------------------------------------ */
/** fingerprint -> timestamp of the last successful broadcast. */
const recentBroadcasts = new Map();

/**
 * Build a stable fingerprint for the content being broadcast.
 * Text is normalised (trim + collapse whitespace) so re-sending the same text
 * with a stray newline is still detected as a duplicate.
 */
function fingerprint({ kind, text, fileId, messageId }) {
  if (kind === "text") {
    const normalized = String(text || "").trim().replace(/\s+/g, " ");
    return `text:${normalized}`;
  }
  return `${kind}:${fileId || messageId || "unknown"}`;
}

function isDuplicate(fp) {
  const at = recentBroadcasts.get(fp);
  if (!at) return false;
  if (Date.now() - at > DUPLICATE_WINDOW_MS) {
    recentBroadcasts.delete(fp);
    return false;
  }
  return true;
}

function markBroadcast(fp) {
  recentBroadcasts.set(fp, Date.now());
  if (recentBroadcasts.size > 500) {
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (const [key, at] of recentBroadcasts) if (at < cutoff) recentBroadcasts.delete(key);
  }
}

function resetDuplicates() {
  recentBroadcasts.clear();
}

/* ------------------------------------------------------------------ *
 * Active run registry (one broadcast at a time)                        *
 * ------------------------------------------------------------------ */
let activeRun = null;

function isRunning() {
  return Boolean(activeRun);
}

function currentRun() {
  return activeRun;
}

/**
 * Request cancellation of the active run.
 * @returns {boolean} true when a run was actually signalled.
 */
function cancel(reason = "Dibatalkan oleh owner.") {
  if (!activeRun) return false;
  activeRun.cancelled = true;
  activeRun.cancelReason = reason;
  return true;
}

/* ------------------------------------------------------------------ *
 * Target filtering                                                    *
 * ------------------------------------------------------------------ */
/**
 * Turn raw dialogs into a de-duplicated, blacklist-free target list.
 *
 * @param {Array<{id:number,title?:string,kind?:string}>} dialogs
 * @param {object} [options]
 * @param {Set<number>} [options.exclude]  extra ids to skip (e.g. source chat)
 * @returns {{targets: object[], skipped: {blacklisted:number, duplicate:number, excluded:number}}}
 */
function prepareTargets(dialogs, options = {}) {
  const exclude = options.exclude instanceof Set ? options.exclude : new Set();
  const blacklisted = new Set(store.blacklist().map((entry) => entry.id));
  const seen = new Set();
  const targets = [];
  const skipped = { blacklisted: 0, duplicate: 0, excluded: 0, invalid: 0 };

  for (const dialog of dialogs || []) {
    const id = store.normalizeId(dialog && (dialog.id ?? dialog.chat_id));
    if (id == null) {
      skipped.invalid += 1;
      continue;
    }
    if (exclude.has(id)) {
      skipped.excluded += 1;
      continue;
    }
    if (blacklisted.has(id)) {
      skipped.blacklisted += 1;
      continue;
    }
    if (seen.has(id)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(id);
    targets.push({ id, title: String(dialog.title || ""), kind: String(dialog.kind || "") });
  }

  if (targets.length > MAX_TARGETS_PER_RUN) {
    skipped.overLimit = targets.length - MAX_TARGETS_PER_RUN;
    targets.length = MAX_TARGETS_PER_RUN;
  }

  return { targets, skipped };
}

/* ------------------------------------------------------------------ *
 * Queue runner                                                        *
 * ------------------------------------------------------------------ */
/**
 * Deliver `payload` to every target sequentially, respecting `.delay`.
 *
 * @param {object} params
 * @param {object} params.client
 * @param {object[]} params.targets     from `prepareTargets`
 * @param {object} params.payload       `{ kind:'text'|'copy', text?, sourceChat?, messageId? }`
 * @param {number} [params.delayMs]     defaults to the persisted `.delay`
 * @param {(progress: object) => Promise<void>|void} [params.onProgress]
 * @param {string} [params.fingerprint]
 * @returns {Promise<{sent:number, failed:number, skipped:number, cancelled:boolean,
 *                    floodWaits:number, results:object[], durationMs:number}>}
 */
async function runQueue(params) {
  const {
    client,
    targets = [],
    payload = {},
    onProgress = null,
    fp = null,
  } = params;

  if (!client) throw new BroadcastError("Client Telegram tidak tersedia.");
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new BroadcastError("Tidak ada chat tujuan yang valid.");
  }

  /**
   * Live inter-message delay.
   *
   * Read fresh on every iteration so `.delay` takes effect immediately, even
   * for a run that is already in flight. An explicit `params.delayMs` pins the
   * value (used by tests); otherwise the persisted setting wins.
   */
  const pinnedDelay = Number.isFinite(Number(params.delayMs)) ? Number(params.delayMs) : null;
  const currentDelay = () => {
    const value = pinnedDelay != null ? pinnedDelay : store.getDelay();
    return Math.max(store.MIN_DELAY_MS, Math.min(store.MAX_DELAY_MS, Number(value) || store.MIN_DELAY_MS));
  };
  const delayMs = currentDelay();

  const run = {
    cancelled: false,
    cancelReason: "",
    startedAt: Date.now(),
  };
  activeRun = run;

  const results = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let floodWaits = 0;
  let consecutiveFloods = 0;
  let lastSentAt = 0;

  const report = async (extra = {}) => {
    if (!onProgress) return;
    try {
      await onProgress({
        total: targets.length,
        processed: sent + failed + skipped,
        sent,
        failed,
        skipped,
        floodWaits,
        cancelled: run.cancelled,
        current: extra.current || null,
        ...extra,
      });
    } catch {
      /* progress reporting must never abort the run */
    }
  };

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];

      if (run.cancelled) {
        skipped += targets.length - index;
        break;
      }

      // Skip anything that became blacklisted while the run was in flight.
      if (store.isBlacklisted(target.id)) {
        skipped += 1;
        results.push({ id: target.id, title: target.title, status: "skipped", reason: "blacklist" });
        await report({ current: target });
        continue;
      }

      // Enforce the gap *between* two sends, re-reading `.delay` each round so a
      // change applies to the running broadcast without a restart.
      if (lastSentAt) {
        const elapsed = Date.now() - lastSentAt;
        const wait = currentDelay() - elapsed;
        if (wait > 0) await sleep(wait);
      }

      try {
        if (payload.kind === "copy") {
          await client.forwardMessages(target.id, {
            messages: [payload.messageId],
            fromPeer: payload.sourceChat,
          });
        } else {
          await client.sendMessage(target.id, {
            message: payload.text,
            parseMode: payload.parseMode,
            linkPreview: false,
          });
        }
        sent += 1;
        consecutiveFloods = 0;
        lastSentAt = Date.now();
        results.push({ id: target.id, title: target.title, status: "sent" });
      } catch (err) {
        const wait = floodWaitSeconds(err);

        if (wait > 0) {
          floodWaits += 1;
          consecutiveFloods += 1;

          if (consecutiveFloods >= MAX_CONSECUTIVE_FLOODS) {
            failed += 1;
            results.push({
              id: target.id,
              title: target.title,
              status: "failed",
              reason: `FLOOD_WAIT_${wait} (berhenti setelah ${consecutiveFloods} kali)`,
            });
            run.cancelled = true;
            run.cancelReason = `Dihentikan otomatis: FLOOD_WAIT berulang (terakhir ${wait}s).`;
            skipped += targets.length - index - 1;
            break;
          }

          if (wait > MAX_FLOOD_WAIT_SECONDS) {
            failed += 1;
            results.push({
              id: target.id,
              title: target.title,
              status: "failed",
              reason: `FLOOD_WAIT_${wait} melebihi batas ${MAX_FLOOD_WAIT_SECONDS}s`,
            });
            run.cancelled = true;
            run.cancelReason = `Dihentikan otomatis: FLOOD_WAIT ${wait}s terlalu lama.`;
            skipped += targets.length - index - 1;
            break;
          }

          // Honour Telegram's request, then retry this chat exactly once.
          await report({ current: { ...target, waiting: wait } });
          await sleep(wait * 1000);
          if (run.cancelled) {
            skipped += 1;
            results.push({ id: target.id, title: target.title, status: "skipped", reason: "cancelled" });
            skipped += targets.length - index - 1;
            break;
          }
          try {
            if (payload.kind === "copy") {
              await client.forwardMessages(target.id, {
                messages: [payload.messageId],
                fromPeer: payload.sourceChat,
              });
            } else {
              await client.sendMessage(target.id, {
                message: payload.text,
                parseMode: payload.parseMode,
                linkPreview: false,
              });
            }
            sent += 1;
            consecutiveFloods = 0;
            lastSentAt = Date.now();
            results.push({ id: target.id, title: target.title, status: "sent", retried: true });
          } catch (retryErr) {
            failed += 1;
            results.push({
              id: target.id,
              title: target.title,
              status: "failed",
              reason: describeError(retryErr),
            });
          }
          await report({ current: target });
          continue;
        }

        failed += 1;
        results.push({
          id: target.id,
          title: target.title,
          status: "failed",
          reason: describeError(err),
        });
      }

      await report({ current: target });
    }
  } finally {
    if (activeRun === run) activeRun = null;
  }

  if (sent > 0 && fp) markBroadcast(fp);

  return {
    sent,
    failed,
    skipped,
    cancelled: run.cancelled,
    cancelReason: run.cancelReason,
    floodWaits,
    results,
    durationMs: Date.now() - run.startedAt,
  };
}

/** Short, log-safe description of a Telegram error. */
function describeError(err) {
  const text = String((err && err.message) || err || "Kesalahan tidak diketahui");
  return text.replace(/\s+/g, " ").slice(0, 160);
}

module.exports = {
  BroadcastError,
  BroadcastCancelled,
  MAX_TARGETS_PER_RUN,
  MAX_CONSECUTIVE_FLOODS,
  MAX_FLOOD_WAIT_SECONDS,
  DUPLICATE_WINDOW_MS,
  floodWaitSeconds,
  isFloodWait,
  fingerprint,
  isDuplicate,
  markBroadcast,
  resetDuplicates,
  isRunning,
  currentRun,
  cancel,
  prepareTargets,
  runQueue,
  describeError,
  sleep,
};

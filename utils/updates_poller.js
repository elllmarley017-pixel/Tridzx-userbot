"use strict";
/**
 * Update synchronisation for GramJS.
 *
 * Telegram only *pushes* certain updates (e.g. messages from other users)
 * over the live connection. Messages that this very client sends — which is
 * exactly what a userbot cares about, since commands are typed by the account
 * owner — are delivered via `updates.getDifference` and then, depending on the
 * server, may only surface through that pull path.
 *
 * GramJS ships a `catchUp()` stub that is intentionally empty, so we implement
 * the missing behaviour here:
 *
 *   1. On startup, fetch `updates.State` and drain the backlog with
 *      `updates.getDifference` so nothing queued while offline is lost.
 *   2. Poll `updates.getDifference` on a short interval and feed the results
 *      back into GramJS's own `_handleUpdate`, so every registered
 *      `NewMessage`/`Raw` handler fires exactly as if the update had been
 *      pushed.
 *
 * Successive `getDifference` calls are safe and idempotent thanks to the
 * persisted `pts`/`qts`/`date` cursors we advance after each batch.
 */
const { Api } = require("telegram");
const { _handleUpdate } = require("telegram/client/updates");

const DEFAULT_INTERVAL_MS = 1500;
const ERROR_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 30000;

/**
 * Start the catch-up + polling loop for a connected client.
 *
 * @param {import("telegram").TelegramClient} client
 * @param {object} [options]
 * @param {number} [options.intervalMs]  Poll interval (default 1500ms).
 * @param {boolean} [options.log]        Emit diagnostic lines.
 * @returns {{ stop: () => void, poll: () => Promise<void> }}
 */
function startUpdatesPoller(client, options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log ?? false;

  if (client.__updatesPollerStarted) {
    return client.__updatesPoller;
  }

  let stopped = false;
  let timer = null;
  let backoff = 0;
  let running = false;

  /**
   * Message ids already dispatched in this process.
   *
   * Telegram delivers the same message twice: once through the live update
   * stream (GramJS `_handleUpdate`) and once through `updates.getDifference`
   * (this poller). Without this guard every command runs twice — visible as
   * duplicated `PENDING` log lines and two bot replies for one `.start`.
   *
   * Key: `<peerKey>:<messageId>`. Bounded so a long-running process cannot grow
   * it forever.
   */
  const seenMessages = new Set();
  const SEEN_LIMIT = 2000;

  function messageKey(message) {
    const peer = message && message.peerId;
    const peerId = peer
      ? peer.channelId ?? peer.chatId ?? peer.userId ?? "?"
      : message && message.chatId;
    return `${peerId}:${message && message.id}`;
  }

  /** True when this message was already handled (and remembers it). */
  function alreadyHandled(message) {
    const key = messageKey(message);
    if (seenMessages.has(key)) return true;
    seenMessages.add(key);
    if (seenMessages.size > SEEN_LIMIT) {
      // Drop the oldest half — insertion order is preserved by Set.
      const drop = Math.floor(SEEN_LIMIT / 2);
      let index = 0;
      for (const value of seenMessages) {
        seenMessages.delete(value);
        if (++index >= drop) break;
      }
    }
    return false;
  }

  // Expose the guard so the command layer can de-duplicate its own dispatches.
  client.__seenMessageIds = seenMessages;

  const state = { pts: 0, qts: 0, date: 0, ready: false };

  async function loadState() {
    const current = await client.invoke(new Api.updates.GetState());
    state.pts = current.pts ?? 0;
    state.qts = current.qts ?? 0;
    state.date = current.date ?? 0;
    state.ready = true;
  }

  /**
   * Messages pulled from `getDifference` sometimes lack a reliable `out` flag
   * (e.g. everything chat with yourself arrives with `out: false`). Recompute
   * it from the sender/peer so outgoing-only handlers still fire.
   */
  function normaliseOut(message) {
    try {
      const selfId = client._selfInputPeer?.userId?.toString();
      if (!selfId) return;
      const from = message.fromId;
      const fromUserId = from?.userId?.toString();
      const peerUserId = message.peerId?.userId?.toString();
      const senderIsSelf = !!fromUserId && fromUserId === selfId;
      const selfChat = peerUserId === selfId && (from === undefined || from === null);
      if (message.out === true || senderIsSelf || selfChat) {
        message.out = true;
      }
    } catch {
      /* best effort */
    }
  }

  /** Feed a single new message back through GramJS as a synthetic update. */
  function dispatchMessage(message) {
    try {
      if (alreadyHandled(message)) return;
      normaliseOut(message);
      const peerId = message.peerId;
      const isChannel = peerId && peerId.className === "PeerChannel";
      const update = isChannel
        ? new Api.UpdateNewChannelMessage({ message, pts: message.pts ?? 0, ptsCount: message.ptsCount ?? 0 })
        : new Api.UpdateNewMessage({ message, pts: message.pts ?? 0, ptsCount: message.ptsCount ?? 0 });
      // GramJS threads entity maps only for Updates/UpdatesCombined; a bare
      // update is handled the same way `UpdateShort` is.
      _handleUpdate(client, update);
    } catch (err) {
      if (log) console.error("⚠️  Gagal dispatch pesan:", err.message);
    }
  }

  function dispatchOther(update) {
    try {
      _handleUpdate(client, update);
    } catch (err) {
      if (log) console.error("⚠️  Gagal dispatch update:", err.message);
    }
  }

  async function drain() {
    if (!state.ready) await loadState();
    let guard = 0;
    // A single difference may be a slice; loop until it is complete.
    while (!stopped && guard++ < 50) {
      const diff = await client.invoke(
        new Api.updates.GetDifference({ pts: state.pts, date: state.date, qts: state.qts }),
      );
      const name = diff.className;

      if (name === "updates.DifferenceEmpty") {
        state.date = diff.date ?? state.date;
        return;
      }
      if (name === "updates.Difference") {
        if (log) console.log(`   [diff] newMessages=${(diff.newMessages || []).length} other=${(diff.otherUpdates || []).length}`);
        for (const message of diff.newMessages || []) dispatchMessage(message);
        for (const update of diff.otherUpdates || []) dispatchOther(update);
        for (const chat of diff.chats || []) try { client.session.processEntities(chat); } catch { /* ignore */ }
        for (const user of diff.users || []) try { client.session.processEntities(user); } catch { /* ignore */ }
        state.pts = diff.state?.pts ?? state.pts;
        state.qts = diff.state?.qts ?? state.qts;
        state.date = diff.state?.date ?? state.date;
        return;
      }
      if (name === "updates.DifferenceSlice") {
        if (log) console.log(`   [slice] newMessages=${(diff.newMessages || []).length}`);
        for (const message of diff.newMessages || []) dispatchMessage(message);
        for (const update of diff.otherUpdates || []) dispatchOther(update);
        state.pts = diff.intermediateState?.pts ?? state.pts;
        state.qts = diff.intermediateState?.qts ?? state.qts;
        state.date = diff.intermediateState?.date ?? state.date;
        continue; // more slices to pull
      }
      if (name === "updates.DifferenceTooLong") {
        // Our cursor is too old; resync from a fresh state.
        state.pts = diff.pts ?? state.pts;
        state.ready = false;
        await loadState();
        return;
      }
      return;
    }
  }

  async function poll() {
    if (stopped || running) return;
    running = true;
    try {
      await drain();
      backoff = 0;
    } catch (err) {
      const message = String(err && err.message);
      // Requests can fail while the client is mid-reconnect; back off quietly.
      backoff = Math.min(backoff ? backoff * 2 : ERROR_BACKOFF_MS, MAX_BACKOFF_MS);
      if (log) console.error(`⚠️  getDifference gagal: ${message} (retry in ${backoff}ms)`);
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped) return;
    const delay = backoff || intervalMs;
    timer = setTimeout(async () => {
      await poll();
      schedule();
    }, delay);
    // Don't keep the event loop alive solely for the poller.
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  // Initial catch-up, then start polling.
  loadState()
    .then(() => drain())
    .catch((err) => {
      if (log) console.error("⚠️  Catch-up awal gagal:", err.message);
    })
    .finally(schedule);

  const poller = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      client.__updatesPollerStarted = false;
    },
    poll,
    get state() {
      return { ...state };
    },
  };

  client.__updatesPollerStarted = true;
  client.__updatesPoller = poller;
  return poller;
}

module.exports = { startUpdatesPoller };

"use strict";
/**
 * `.start` — interactive feature menu.
 *
 * Transport
 * ---------
 * The menu is a **native Telegram keyboard** (`InlineKeyboardMarkup`), so the
 * buttons really do something instead of printing a command to copy:
 *
 *   [⬇️][🔍]  [🕵️][🔧]  …        category pages
 *   [.ytmp4][.ytmp3][.fb] …       run that command
 *   [⬅️][🏠 Menu][➡️]  [✖️ Tutup]  navigation / close
 *
 * Two delivery paths, same rendering (`utils/menu.js`):
 *
 *   1. Bot API (preferred) — `bot_api_server.js` sends
 *      `parse_mode: "HTML"` + `inline_keyboard` and edits the *same* message on
 *      every callback, so navigation never duplicates messages.
 *   2. Local fallback — if the Bot API is unreachable the userbot sends the
 *      identical HTML itself, plus a plain-text navigation hint (an MTProto user
 *      session cannot attach an `inline_keyboard`).
 *
 * Commands
 * --------
 *   .start            main menu, delivered through Inline Mode (one command)
 *
 * `.start` takes no argument: the single message carries every page and
 * category as inline buttons.
 *
 * Commands picked from a button arrive through `utils/menu_queue.js`: the bot
 * enqueues them, the userbot executes them by sending the command text into the
 * requesting chat, so the existing handlers do the actual work.
 */
const {
  escapeMarkdown,
  formatMessage,
  respondMarkdown,
} = require("../utils/formatting");
const { command, chatId, runAction } = require("../utils/telegram");
const bridgeModule = require("../utils/bot_bridge");
const menu = require("../utils/menu");
const menuInline = require("../utils/menu_inline");
const delivery = require("../utils/menu_delivery");

/** MTProto text limit used by the local fallback transport. */
const LEGACY_LIMIT = 4096;

/** Feature catalogue — re-exported from the shared menu module. */
const FEATURE_SECTIONS = menu.SECTIONS;

const TOTAL_COMMANDS = menu.TOTAL_COMMANDS;
const FOOTER = menu.FOOTER;
const PAGE_COUNT = menu.PAGE_COUNT;

/**
 * Strip the `<placeholder>` part of a command so the button payload is
 * paste-ready while sub-commands stay distinct:
 *
 *   ".ytmp4 <link> [resolusi]" -> ".ytmp4"
 *   ".bcall add"               -> ".bcall add"
 *   ".bcall (teks)"            -> ".bcall"
 */
const commandBase = menu.commandBase;

/* ------------------------------------------------------------------ *
 * Local fallback rendering (MTProto, no inline keyboard)              *
 * ------------------------------------------------------------------ */
/**
 * Plain-text navigation block appended to the local fallback.
 * A user session cannot attach an `inline_keyboard`, so this is the only place
 * where page shortcuts are printed — the inline/bot transports never need them.
 */
/**
 * Explain why the interactive version is unavailable and how to fix it.
 * A dead end is worse than a hint: the owner can act on both cases below.
 */
function transportHint(reason) {
  const text = String(reason || "");
  if (/not a member|PEER_ID_INVALID|chat not found/i.test(text)) {
    return (
      "<b>ℹ️ Tombol native belum tersedia di chat ini</b>\n" +
      "Bot belum menjadi anggota chat ini. Tambahkan bot ke grup/channel " +
      "(beri izin mengirim pesan) lalu jalankan <code>.start</code> lagi."
    );
  }
  if (/blocked|USER_IS_BLOCKED/i.test(text)) {
    return (
      "<b>ℹ️ Tombol native belum tersedia</b>\n" +
      "Bot sedang diblokir. Buka DM bot, tekan <i>Unblock/Start</i>, lalu ulangi <code>.start</code>."
    );
  }
  if (/rights|forbidden|chat_write_forbidden/i.test(text)) {
    return (
      "<b>ℹ️ Tombol native belum tersedia</b>\n" +
      "Bot tidak punya izin mengirim pesan di chat ini. Beri izin <i>Send Messages</i>."
    );
  }
  if (/bot-timeout|BOT_RESPONSE_TIMEOUT|local-timeout/i.test(text)) {
    return (
      "<b>ℹ️ Bot tidak merespons</b>\n" +
      "Permintaan inline ke bot habis waktu. Jalankan <code>npm run bot</code> " +
      "(atau <code>npm run bot:inline</code>) dan pastikan <code>BOT_TOKEN</code> valid."
    );
  }
  if (/no-inline-results/i.test(text)) {
    return (
      "<b>ℹ️ Menu inline kosong</b>\n" +
      "Bot belum mengaktifkan inline mode: @BotFather → <code>/setinline</code>."
    );
  }
  return "";
}

function localNavHint() {
  const shortcuts = menu.SECTIONS.map(
    (section, position) => `${position + 1}. ${section.title}`,
  ).join("\n");
  return [
    `<b>📂 Kategori</b>`,
    shortcuts,
    "",
    `<i>${escapeMarkdown(FOOTER)}</i>`,
  ].join("\n");
}

/**
 * Build the local fallback message for one page.
 * Text is the same HTML the Bot API sends, so both paths look identical.
 */
function renderLocal(page, options = {}) {
  const index = menu.normalizePage(page);
  const body = menu.renderPageHtml(index, options);
  const text = `${body}\n\n${localNavHint()}`;
  return text.length <= LEGACY_LIMIT
    ? text
    : `${body.slice(0, LEGACY_LIMIT - 200)}\n\n<i>…</i>`;
}

/* ------------------------------------------------------------------ *
 * Registration                                                        *
 * ------------------------------------------------------------------ */
/**
 * How long to wait for the bot to answer an inline query.
 * Telegram itself gives up around 10s (`BOT_RESPONSE_TIMEOUT`), so waiting
 * longer only delays the fallback transport.
 */
const INLINE_QUERY_BUDGET_MS = Math.max(1000, Number(process.env.USERBOT_INLINE_BUDGET_MS || 2500));

/**
 * Cache the outcome of a failed inline attempt so repeated `.start` calls do not
 * each pay the ~10s `BOT_RESPONSE_TIMEOUT` penalty. Any successful answer (or a
 * different failure) clears it.
 */
const inlineHealth = { downUntil: 0, reason: "" };
const INLINE_DOWN_COOLDOWN_MS = Math.max(5000, Number(process.env.USERBOT_INLINE_COOLDOWN_MS || 60_000));

/** True when a recent inline attempt already failed (skip it for a while). */
function inlineRecentlyDown() {
  return inlineHealth.downUntil > Date.now();
}

/**
 * Human-readable reason for an inline failure, used by `transportHint()`.
 * `BOT_RESPONSE_TIMEOUT` almost always means the bot process is not running or
 * its token is invalid — worth telling the owner explicitly.
 */
function inlineFailureReason(err) {
  const message = String((err && (err.errorMessage || err.message)) || err || "");
  if (/BOT_RESPONSE_TIMEOUT/i.test(message)) return "bot-timeout";
  if (/Timeout \d+ ms/i.test(message)) return "local-timeout";
  if (/no-inline-results/i.test(message)) return "no-inline-results";
  return message || "inline-failed";
}

/**
 * Deliver the menu **through Inline Mode** (preferred transport).
 *
 * The userbot asks the bot for the `menu` inline result and sends it with
 * `messages.sendInlineBotResult`. Telegram then posts the menu as the bot —
 * HTML formatted, with a native keyboard and a "via @bot" label — and every
 * button press returns to the bot as a `callback_query`, so all pages are
 * reachable from this single message.
 *
 * @returns {Promise<{ok: boolean, reason?: string, transport?: string}>}
 */
async function sendViaInline(client, event, page = 0) {
  const { getInlineResultsSafe, sendInlineResult, withTimeout, INLINE_TIMEOUT } = require("../userbot");
  const { resolveBotToken, BRIDGE_BOT_USERNAME } = require("../config");
  // Cheap, synchronous name first; only fall back to a network lookup when the
  // configuration does not know the bot.
  const botName = BRIDGE_BOT_USERNAME || (await botUsername(client));

  if (!botName) return { ok: false, reason: "no-bot-username" };
  if (!resolveBotToken()) return { ok: false, reason: "no-token" };

  // A previous attempt already proved the bot does not answer inline queries.
  // Skipping it keeps `.start` instant instead of waiting ~10s every time.
  if (inlineRecentlyDown()) return { ok: false, reason: inlineHealth.reason || "bot-timeout" };

  const peer = await client.getInputEntity(chatId(event));
  const botEntity = await client.getEntity(botName);
  const query = menuInline.queryForPage(page);

  // Telegram answers inline queries within ~10s and returns BOT_RESPONSE_TIMEOUT
  // when the bot does not reply in time. Cap our wait *below* that so we can
  // fall through to the next transport instead of surfacing an error.
  const budget = Math.min(INLINE_TIMEOUT, INLINE_QUERY_BUDGET_MS);

  let answer;
  try {
    answer = await withTimeout(getInlineResultsSafe(client, botEntity, peer, query, ""), budget);
  } catch (err) {
    const reason = inlineFailureReason(err);
    if (reason === "bot-timeout" || reason === "local-timeout") {
      inlineHealth.downUntil = Date.now() + INLINE_DOWN_COOLDOWN_MS;
      inlineHealth.reason = reason;
    }
    return { ok: false, reason };
  }

  // A successful answer means the bot is healthy again.
  inlineHealth.downUntil = 0;
  inlineHealth.reason = "";

  if (!answer.results || !answer.results.length) {
    return { ok: false, reason: "no-inline-results" };
  }

  const chosen = answer.results[0];
  try {
    await withTimeout(sendInlineResult(client, peer, answer.queryId, chosen.id), budget);
  } catch (err) {
    return { ok: false, reason: inlineFailureReason(err) };
  }
  return { ok: true, transport: "inline", mode: answer.mode };
}

/**
 * `.start` / `.help` → rich message from the bot.
 *
 * userbot: messages.getInlineBotResults(bot, peer, "start"|"help")
 * bot:     answerInlineQuery (InputRichMessageContent, text fallback)
 * userbot: messages.sendInlineBotResult(first result), then delete the command.
 *
 * Telegram only attaches "via @bot" to this message; the command message is
 * removed only after the send succeeded, so a failure never loses the command.
 *
 * @returns {Promise<{ok: boolean, reason?: string, mode?: string}>}
 */
async function sendRichCommand(client, event, query) {
  const { getInlineResultsSafe, sendInlineResult, withTimeout, INLINE_TIMEOUT } = require("../userbot");
  const { resolveBotToken, BRIDGE_BOT_USERNAME } = require("../config");
  const botName = BRIDGE_BOT_USERNAME || (await botUsername(client));
  if (!botName) return { ok: false, reason: "no-bot-username" };
  if (!resolveBotToken()) return { ok: false, reason: "no-token" };
  if (inlineRecentlyDown()) return { ok: false, reason: inlineHealth.reason || "bot-timeout" };

  const peer = await client.getInputEntity(chatId(event));
  const botEntity = await client.getEntity(botName);
  // Telegram aborts at ~10s (BOT_RESPONSE_TIMEOUT); stay below it.
  const budget = Math.min(INLINE_TIMEOUT, Math.max(INLINE_QUERY_BUDGET_MS, 8000));

  let answer;
  try {
    answer = await withTimeout(getInlineResultsSafe(client, botEntity, peer, query, ""), budget);
  } catch (err) {
    const reason = inlineFailureReason(err);
    if (reason === "bot-timeout" || reason === "local-timeout") {
      inlineHealth.downUntil = Date.now() + INLINE_DOWN_COOLDOWN_MS;
      inlineHealth.reason = reason;
    }
    return { ok: false, reason };
  }
  inlineHealth.downUntil = 0;
  inlineHealth.reason = "";
  if (!answer.results || !answer.results.length) return { ok: false, reason: "no-inline-results" };

  try {
    await withTimeout(sendInlineResult(client, peer, answer.queryId, answer.results[0].id), budget);
  } catch (err) {
    return { ok: false, reason: inlineFailureReason(err) };
  }

  const message = event && (event.message || event);
  if (message && message.id != null) {
    try {
      await client.deleteMessages(chatId(event), [message.id], { revoke: true });
    } catch (err) {
      console.warn(`⚠️  Pesan perintah tidak terhapus: ${err.message}`);
    }
  }
  return { ok: true, mode: answer.mode };
}

/** Messages sent through a bot (our own results) must never re-trigger commands. */
function isViaBot(event) {
  const message = event && (event.message || event);
  return Boolean(message && (message.viaBotId || message.viaBusinessBotId));
}

/**
 * Ask the Bot API for the menu (preferred transport).
 *
 * The bot sends `parse_mode: "HTML"` + a native `InlineKeyboardMarkup` into the
 * chat, so the buttons really work and every tap returns as a callback_query.
 * If the bot may not post there (blocked / not a member / no rights) the caller
 * falls through to the next transport instead of failing silently.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function sendViaBot(client, event, page) {
  const chat = chatId(event);
  if (chat == null) return { ok: false, reason: "no-chat" };

  // Saved Messages ("chat with yourself") is a private chat whose id *equals*
  // the account id. No bot can post there, and a user account cannot attach an
  // `inline_keyboard` either (Telegram silently drops it — verified live). The
  // interactive menu is therefore delivered to the owner's DM with the bot and
  // a short pointer is posted here, so the buttons stay real and clickable.
  if (isSelfChat(client, event)) {
    // No bot → no DM menu; fall through so the local renderer runs instantly.
    if (inlineRecentlyDown()) return { ok: false, reason: "bot-timeout" };
    return sendMenuToBotDm(client, event, page);
  }
  const replyTo = event?.id ?? event?.message?.id;
  const result = await delivery.sendMenuAsBot({
    chatId: chat,
    page,
    extra: replyTo != null ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {},
  });
  if (result.ok) return result;
  return { ok: false, reason: result.reason || "bot-failed" };
}

/**
 * Deliver the menu to the owner's DM with the bot and post a pointer in
 * Saved Messages.
 *
 * This is the only correct option there: Telegram never lets a bot post into a
 * user's Saved Messages, and never lets a user account attach an inline
 * keyboard. Sending the menu to the bot DM keeps the native buttons working.
 *
 * @returns {Promise<{ok: boolean, reason?: string, transport?: string}>}
 */
async function sendMenuToBotDm(client, event, page) {
  const { ownerIds } = require("../config");
  const me = client.__me || (await client.getMe().catch(() => null));
  const ownerId = me && me.id != null ? Number(me.id) : (ownerIds()[0] ?? null);
  const username = await botUsername();

  if (ownerId == null) return { ok: false, reason: "no-owner-id" };

  const result = await delivery.sendMenuAsBot({ chatId: ownerId, page });
  if (!result.ok) return { ok: false, reason: result.reason || "bot-dm-failed" };

  // Pointer in Saved Messages (no buttons possible here, so give a real link).
  const link = username ? `https://t.me/${username}?start=menu` : "https://t.me";
  const pointer = [
    `<b>🤖 Menu Interaktif</b>`,
    menu.DIVIDER,
    `Menu dengan tombol native dikirim ke DM <b>@${escapeMarkdown(username || "bot")}</b>.`,
    "",
    `Saved Messages tidak dapat menampilkan <code>inline_keyboard</code> ` +
      `(batasan Telegram untuk akun pengguna), jadi tombol dikirim oleh bot.`,
    "",
    `<b>Buka menu:</b> <a href="${link}">buka DM bot</a>`,
  ].join("\n");

  try {
    await respondMarkdown(client, event, pointer, { linkPreview: false });
  } catch {
    /* the DM menu already succeeded; the pointer is a nicety */
  }
  return { ok: true, reason: "bot-dm", transport: "bot-dm" };
}

/**
 * True when the command was issued in the account's own Saved Messages.
 * GramJS reports both `chatId` and `senderId` as the account id there, so an
 * equality check is enough and costs no extra API call.
 */
function isSelfChat(client, event) {
  const message = event?.message || event;
  const selfId = client?.__me?.id ?? client?.__selfId;
  const peer = message?.peerId;
  const peerUserId =
    peer && typeof peer === "object"
      ? peer.userId ?? (peer.userId === undefined && peer.className === "PeerUser" ? peer.userId : undefined)
      : undefined;
  const chat = chatId(event);
  const sender = event?.senderId ?? message?.senderId;
  if (peerUserId != null && selfId != null) return String(peerUserId) === String(selfId);
  if (selfId != null && chat != null && sender != null) {
    return String(chat) === String(selfId) && String(sender) === String(selfId);
  }
  return false;
}

/**
 * Relay the menu through the bot → userbot bridge.
 * The bot answers `/start` with the same HTML + buttons; the bridge re-sends it
 * from the account. Buttons arrive as formatted text on this transport.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function sendViaBridge(client, event, command_) {
  try {
    const bridge = bridgeModule.getBridge() || bridgeModule.createBridge(client);
    const result = await bridge.forward(event, command_, { waitMs: 8000 });
    return result && result.ok ? { ok: true } : { ok: false, reason: "bridge-timeout" };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Bot username used for the inline query and the "via @bot" marker.
 *
 * Resolution order is deliberately cheapest-first so `.start` never waits on a
 * cold Bot API round-trip:
 *
 *   1. `USERBOT_BRIDGE_BOT` / `session/config.json` (synchronous)
 *   2. the bridge's already-resolved username
 *   3. the MTProto entity cache (`getEntity`, ~100 ms)
 *   4. `getMe()` over HTTPS (only when nothing else is known)
 */
let cachedBotUsername = "";
async function botUsername(client) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const bridge = bridgeModule.getBridge();
    if (bridge && bridge.botUsername) {
      cachedBotUsername = bridge.botUsername;
      return cachedBotUsername;
    }
  } catch {
    /* bridge optional */
  }

  const configured = String(require("../config").BRIDGE_BOT_USERNAME || "").trim();
  if (configured) {
    cachedBotUsername = configured;
    return cachedBotUsername;
  }

  // The token is required for inline mode anyway; its `getMe` is cached by
  // `menu_delivery`, so this is a one-time cost at most.
  try {
    const me = await delivery.botIdentity();
    if (me && me.username) {
      cachedBotUsername = me.username;
      return cachedBotUsername;
    }
  } catch {
    /* fall through */
  }

  if (client) {
    try {
      const configuredName = String(require("../config").BRIDGE_BOT_USERNAME || "").trim();
      void configuredName;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** Forget the cached bot username (tests / token rotation). */
function resetBotUsernameCache() {
  cachedBotUsername = "";
}

/**
 * Compact "all categories" summary (helper, no command).
 * Stays inside the MTProto limit, so it is always deliverable.
 */
function renderAll() {
  const lines = [
    "<b>🤖 Telegram Userbot</b>",
    menu.DIVIDER,
    `<b>📌 ${TOTAL_COMMANDS} command dalam ${FEATURE_SECTIONS.length} kategori</b>`,
    "",
  ];
  for (const section of FEATURE_SECTIONS) {
    lines.push(`<b>${section.title}</b>`);
    lines.push(section.items.map(([, cmd]) => `<code>${escapeMarkdown(commandBase(cmd))}</code>`).join(" · "));
    lines.push("");
  }
  lines.push(`<i>${escapeMarkdown(FOOTER)}</i>`);
  return lines.join("\n");
}

/**
 * Execute one feature a user picked from a Rich Button.
 *
 * The Bot API enqueues `{chat_id, message_id, action, arg}`. Nothing is typed
 * into the chat: the handler runs directly with a synthetic event carrying the
 * chat and message the button came from, so the response edits or replies in
 * place and no command text ever appears.
 *
 * @returns {Promise<{ok: boolean, reason?: string, handled?: number}>}
 */
async function executeQueuedCommand(client, entry) {
  const target = Number(entry.chat_id);
  if (!Number.isInteger(target) || target === 0) return { ok: false, reason: "chat-id-tidak-valid" };
  const action = String(entry.action || "").trim();
  if (!action.startsWith(".")) return { ok: false, reason: "bukan-aksi" };

  try {
    const result = await runAction(client, {
      command: action,
      arg: entry.arg,
      chatId: target,
      messageId: entry.message_id,
      userId: entry.requested_by,
    });
    return result.ok
      ? { ok: true, handled: result.handled }
      : { ok: false, reason: result.reason || "gagal", handled: 0 };
  } catch (err) {
    return { ok: false, reason: err.message, handled: 0 };
  }
}

/**
 * Poll the shared queue and execute pending button commands.
 * Started by `main.js`; safe to run twice (entries are claimed atomically).
 *
 * @param {object} client        GramJS client
 * @param {object} [options]
 * @param {number} [options.intervalMs]  default 1000
 * @param {boolean} [options.log]
 * @returns {{stop: Function}}
 */
function startMenuQueue(client, options = {}) {
  const queue = require("../utils/menu_queue");
  const interval = Math.max(250, Number(options.intervalMs) || 1000);
  const log = options.log !== false;
  let running = true;
  let timer = null;

  const tick = async () => {
    if (!running) return;
    let entries = [];
    try {
      entries = queue.drain();
    } catch (err) {
      if (log) console.error(`🎛️  Queue: ${err.message}`);
    }
    for (const entry of entries) {
      const result = await executeQueuedCommand(client, entry);
      try {
        queue.markProcessed(entry);
      } catch {
        /* ignore */
      }
      if (log) {
        console.log(
          result.ok
            ? `🎛️  Tombol: ${entry.action} dijalankan di chat ${entry.chat_id} ` +
              `(${result.handled || 0} handler)`
            : `🎛️  Tombol: ${entry.action} gagal (${result.reason})`,
        );
      }
    }
    timer = setTimeout(tick, interval);
    if (typeof timer.unref === "function") timer.unref();
  };

  timer = setTimeout(tick, interval);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}

function register(client) {
  // `.help` — rich message "help" from the bot. Failure → plain notice.
  command(client, /^\.help\s*$/, async (event) => {
    if (isViaBot(event)) return;
    const result = await sendRichCommand(client, event, "help");
    if (result.ok) return;
    const hint = transportHint(result.reason);
    await respondMarkdown(
      client,
      event,
      hint || `<b>❌ .help gagal</b>\n<code>${escapeMarkdown(String(result.reason || "unknown"))}</code>`,
      { linkPreview: false },
    );
  }, { incoming: false });

  // One command only: `.start`. Every page and category is reachable from
  // the buttons on the single message, so no argument is accepted.
  command(client, /^\.start\s*$/, async (event) => {
    const username = await botUsername();
    const page = 0;

    if (isViaBot(event)) return;

    // 0. Rich message ("start" query).
    const viaRich = await sendRichCommand(client, event, "start");
    if (viaRich.ok) return;
    console.warn(`⚠️  .start rich gagal (${viaRich.reason}) → jalur inline lama`);

    // 1. Inline Mode: the bot posts the menu, Telegram labels it "via @bot",
    //    and all navigation happens through the attached buttons.
    const viaInline = await sendViaInline(client, event, page);
    if (viaInline.ok) return;

    // 2. Bot API direct: same HTML + native keyboard, sent by the bot.
    const viaBot = await sendViaBot(client, event, page);
    if (viaBot.ok) return;

    // 3. Bridge: bot renders, userbot relays (buttons degrade to text).
    //    Skipped when the bot already failed to answer — waiting another 8s for
    //    a dead bot only delays the local menu.
    const viaBridge = inlineRecentlyDown()
      ? { ok: false, reason: "bot-timeout" }
      : await sendViaBridge(client, event, page ? `/start ${page}` : "/start");
    if (viaBridge.ok) return;

    // 4. Local: identical HTML, always deliverable, with a hint on how to get
    //    the interactive version back.
    const hint = transportHint(viaBridge.reason || viaBot.reason || viaInline.reason);
    const body = renderLocal(page, { botUsername: username });
    await respondMarkdown(
      client,
      event,
      hint ? `${hint}\n\n${body}` : body,
      { linkPreview: false },
    );
  });
}

const START_TEXT = menu.renderPageHtml(0);
const START_BLOCKS = [START_TEXT];
const START_PAGES = Array.from({ length: PAGE_COUNT }, (_, page) => menu.renderPageHtml(page));

module.exports = {
  register,
  executeQueuedCommand,
  startMenuQueue,
  renderLocal,
  renderAll,
  botUsername,
  sendViaBot,
  sendViaInline,
  sendRichCommand,
  isViaBot,
  resetBotUsernameCache,
  inlineFailureReason,
  inlineHealth,
  INLINE_QUERY_BUDGET_MS,
  sendMenuToBotDm,
  sendViaBridge,
  transportHint,
  isSelfChat,
  START_TEXT,
  START_BLOCKS,
  START_PAGES,
  FEATURE_SECTIONS,
  TOTAL_COMMANDS,
  PAGE_COUNT,
  LEGACY_LIMIT,
  commandBase,
  chatId,
};

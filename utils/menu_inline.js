"use strict";
/**
 * `.start` delivered through **Inline Mode**.
 *
 * Requirement
 * -----------
 * The owner types `.start` once and immediately sees the main menu — with HTML
 * formatting, real inline buttons and a `via @bot` marker — without typing
 * `.start 1`, `.start 2`, … again. Every page and category is then reachable
 * from the buttons attached to that single message.
 *
 * Why inline mode is the right transport here
 * -------------------------------------------
 * A user account cannot attach an `inline_keyboard`, and a Rich Message arrives
 * at MTProto as `MessageMediaUnsupported` (GramJS layer 198 has no `Rich*`
 * types). An **inline result** however is sent by Telegram on behalf of the bot:
 * it keeps `parse_mode: "HTML"`, keeps a native `reply_markup`, and — crucially —
 * every button press comes back to the bot as a `callback_query` carrying
 * `inline_message_id`, so the bot can edit that same message in place.
 *
 * Flow
 * ----
 *   1. owner: `.start`
 *   2. userbot: messages.getInlineBotResults(bot, peer, "menu", "")
 *   3. bot:     answerInlineQuery → article "🤖 Menu Utama" (HTML + keyboard)
 *   4. userbot: messages.sendInlineBotResult(peer, query_id, "menu")
 *   5. Telegram posts the menu as the bot, labelled "via @bot"
 *   6. owner taps a button → callback_query → editMessageText(inline_message_id)
 *
 * The bot resolves `"menu"` / `"menu:<page>"` / `"menu:cat:<key>"` queries
 * (`utils/menu.js` renders every page), so one `.start` is enough.
 */
const menu = require("./menu");
const richTransport = require("./rich_transport");
const { callApi, BotApiError } = require("./bot_api");

/** Inline result ids: 1–64 bytes. */
const MENU_RESULT_PREFIX = "menu";
/** Query prefixes understood by `bot_api_server.js` / `bot.js`. */
const QUERY_MAIN = "menu";
const QUERY_PAGE = "menu:page:";
const QUERY_CAT = "menu:cat:";

/* ------------------------------------------------------------------ *
 * Query building (userbot side)                                       *
 * ------------------------------------------------------------------ */
/**
 * Inline query text for a page.
 * `page 0` → `"menu"` (the main menu), otherwise `"menu:page:<n>"`.
 */
function queryForPage(page) {
  const index = menu.normalizePage(page);
  return index === 0 ? QUERY_MAIN : `${QUERY_PAGE}${index}`;
}

/** Inline query text for one category (by key). */
function queryForCategory(key) {
  const name = String(key || "").trim();
  if (!name) return QUERY_MAIN;
  return `${QUERY_CAT}${name}`;
}

/**
 * Parse a menu query coming from the userbot.
 *
 * @param {string} raw
 * @returns {{isMenu: boolean, page: number, category: string|null}}
 */
function parseMenuQuery(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { isMenu: false, page: 0, category: null };

  if (text === QUERY_MAIN) return { isMenu: true, page: 0, category: null };

  if (text.startsWith(QUERY_PAGE)) {
    const page = Number(text.slice(QUERY_PAGE.length));
    return { isMenu: true, page: menu.normalizePage(Number.isInteger(page) ? page : 0), category: null };
  }

  if (text.startsWith(QUERY_CAT)) {
    const key = text.slice(QUERY_CAT.length).trim();
    const index = menu.SECTIONS.findIndex((section) => section.key === key);
    return { isMenu: true, page: index >= 0 ? index + 1 : 0, category: key || null };
  }

  return { isMenu: false, page: 0, category: null };
}

/* ------------------------------------------------------------------ *
 * Inline result (bot side)                                            *
 * ------------------------------------------------------------------ */
/**
 * Build the `InlineQueryResultArticle` for one menu page.
 *
 * Verified against the Bot API:
 *   - `input_message_content.message_text` + `parse_mode: "HTML"` works,
 *   - `reply_markup` on an article result keeps the buttons clickable,
 *   - a rich payload (`input_message_content.rich_message`) is accepted but a
 *     userbot running GramJS layer 198 cannot parse the returned
 *     `botInlineMessageRichMessage`, so HTML is used for the *inline* menu.
 *     `rich_message` is still offered through `rich` so a newer library can use
 *     it without a code change.
 *
 * @param {number} page
 * @param {object} [options]
 * @param {string} [options.botUsername]  adds the `via @bot` marker
 * @param {boolean} [options.rich]        use InputRichMessageContent
 * @returns {object} InlineQueryResultArticle
 */
function buildMenuResult(page, options = {}) {
  const index = menu.normalizePage(page);
  const username = String(options.botUsername || "").replace(/^@/, "");
  const via = username ? `via @${username}` : "";
  const title = index === 0
    ? "🤖 Menu Utama"
    : `${menu.SECTIONS[index - 1].title}`;
  const description = index === 0
    ? `${menu.TOTAL_COMMANDS} command · ${menu.SECTIONS.length} kategori`
    : `${menu.SECTIONS[index - 1].items.length} command · halaman ${index}/${menu.SECTIONS.length}`;

  const html = menu.truncateHtml(
    `${menu.renderPageHtml(index)}${via ? `\n\n<i>🤖 ${menu.esc(via)} · tombol di bawah interaktif.</i>` : ""}`,
  );

  const result = {
    type: "article",
    id: `${MENU_RESULT_PREFIX}-${index}`.slice(0, 64),
    title: title.slice(0, 64),
    description: description.slice(0, 120),
    // Native keyboard: every category/page is reachable from this one message.
    reply_markup: menu.buildKeyboard(index),
  };

  if (options.rich) {
    try {
      const { blocks } = menu.renderPageBlocks(index, { botUsername: username });
      result.input_message_content = richTransport.inlineRichContent(
        require("./rich_message").buildRichMessage(blocks),
      );
      return result;
    } catch {
      /* fall through to HTML */
    }
  }

  result.input_message_content = {
    message_text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  return result;
}

/* ------------------------------------------------------------------ *
 * `.start` / `.help` rich results (queries "start" and "help")        *
 * ------------------------------------------------------------------ */
const RICH_QUERIES = new Set(["start", "help"]);

/**
 * `"start"` / `"help"` (optionally `!`-prefixed = force plain text).
 * @returns {{kind: "start"|"help", forceText: boolean} | null}
 */
function parseRichQuery(raw) {
  let text = String(raw == null ? "" : raw).trim().toLowerCase();
  const forceText = text.startsWith("!");
  if (forceText) text = text.slice(1).trim();
  return RICH_QUERIES.has(text) ? { kind: text, forceText } : null;
}

/** Rich blocks for `start` (main menu) or `help` (every category). */
function buildRichBlocks(kind, botUsername = "") {
  if (kind === "start") return menu.renderPageBlocks(0, { botUsername }).blocks;
  const blocks = [{ type: "heading", text: "📖 Bantuan", size: 1 }];
  for (let page = 1; page <= menu.SECTIONS.length; page += 1) {
    // Each page = heading + table + quote + footer; keep heading + table only.
    blocks.push(...menu.renderPageBlocks(page, { botUsername }).blocks.slice(0, 2));
  }
  blocks.push({ type: "footer", text: menu.FOOTER });
  return blocks;
}

const RICH_META = {
  start: { id: "start", title: "🤖 Menu Utama", description: "Rich message · .start" },
  help: { id: "help", title: "📖 Bantuan", description: "Rich message · .help" },
};

/**
 * InlineQueryResultArticle whose `input_message_content` is
 * InputRichMessageContent = `{ rich_message: { blocks } }` (exactly one of
 * html / markdown / blocks; `buildRichPayload` guarantees a single field).
 */
function buildRichInfoResult(kind, botUsername = "") {
  const meta = RICH_META[kind];
  const message = require("./rich_message").buildRichMessage(buildRichBlocks(kind, botUsername));
  return {
    type: "article",
    ...meta,
    input_message_content: richTransport.inlineRichContent(message),
  };
}

/** Same content as plain HTML (`InputTextMessageContent`) — fallback result. */
function buildTextInfoResult(kind) {
  const meta = RICH_META[kind];
  const pages = kind === "start"
    ? [menu.renderPageHtml(0)]
    : menu.SECTIONS.map((_, index) => menu.renderPageHtml(index + 1));
  return {
    type: "article",
    ...meta,
    input_message_content: {
      message_text: menu.truncateHtml(pages.join("\n\n")),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  };
}

/**
 * Answer a `start` / `help` inline query: rich first, plain HTML if Telegram
 * rejects the rich payload (or the query carries the `!` marker).
 *
 * @returns {Promise<{answered: number, isRich: boolean, kind?: string, mode?: string}>}
 */
async function answerRichQuery(token, inlineQuery, options = {}) {
  const parsed = parseRichQuery(inlineQuery && inlineQuery.query);
  if (!parsed) return { answered: 0, isRich: false };

  const base = {
    inline_query_id: inlineQuery.id,
    cache_time: 0,
    is_personal: true,
    next_offset: "",
  };
  if (!parsed.forceText) {
    try {
      await callApi(token, "answerInlineQuery", {
        ...base,
        results: [buildRichInfoResult(parsed.kind, options.botUsername)],
      });
      return { answered: 1, isRich: true, kind: parsed.kind, mode: "rich" };
    } catch (err) {
      if (options.log) options.log(`rich ditolak (${err.message}) → fallback teks`);
    }
  }
  await callApi(token, "answerInlineQuery", {
    ...base,
    results: [buildTextInfoResult(parsed.kind)],
  });
  return { answered: 1, isRich: true, kind: parsed.kind, mode: "text" };
}

/**
 * Answer an inline query that asks for the menu.
 *
 * @param {string} token
 * @param {object} inlineQuery
 * @param {object} [options]
 * @returns {Promise<{answered: number, page: number, isMenu: boolean}>}
 */
async function answerMenuQuery(token, inlineQuery, options = {}) {
  const raw = String((inlineQuery && inlineQuery.query) || "");
  const parsed = parseMenuQuery(raw);
  if (!parsed.isMenu) return { answered: 0, page: 0, isMenu: false };

  const result = buildMenuResult(parsed.page, {
    botUsername: options.botUsername,
    rich: options.rich === true,
  });

  await callApi(token, "answerInlineQuery", {
    inline_query_id: inlineQuery.id,
    results: [result],
    cache_time: 0,
    is_personal: true,
    next_offset: "",
  });
  return { answered: 1, page: parsed.page, isMenu: true };
}

/* ------------------------------------------------------------------ *
 * Callback editing (bot side)                                         *
 * ------------------------------------------------------------------ */
/**
 * Edit the menu message a callback belongs to.
 *
 * Two shapes must be supported, because a menu opened via `.start` (inline) has
 * **no** `callbackQuery.message`:
 *
 *   inline  → `{ inline_message_id }`
 *   regular → `{ chat_id, message_id }`
 *
 * The keyboard is always re-sent: `editMessageText` drops `reply_markup` when it
 * is omitted, which would leave a dead menu.
 *
 * @param {string} token
 * @param {object} callbackQuery
 * @param {number} page
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, target: "inline"|"chat"|"none", reason?: string}>}
 */
async function editMenuFromCallback(token, callbackQuery, page, options = {}) {
  const index = menu.normalizePage(page);
  const username = String(options.botUsername || "").replace(/^@/, "");
  const via = username ? `\n\n<i>🤖 via @${username} · tombol di bawah interaktif.</i>` : "";
  const text = menu.truncateHtml(`${menu.renderPageHtml(index)}${via}`);
  const keyboard = menu.buildKeyboard(index);

  const inlineId = callbackQuery && callbackQuery.inline_message_id;
  const message = callbackQuery && callbackQuery.message;

  if (inlineId) {
    try {
      await callApi(token, "editMessageText", {
        inline_message_id: inlineId,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      return { ok: true, target: "inline" };
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return { ok: true, target: "inline" };
      return { ok: false, target: "inline", reason: err.message };
    }
  }

  if (message && message.chat && message.message_id != null) {
    try {
      await callApi(token, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      return { ok: true, target: "chat" };
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return { ok: true, target: "chat" };
      return { ok: false, target: "chat", reason: err.message };
    }
  }

  return { ok: false, target: "none", reason: "no-inline-message-id" };
}

/** Delete the menu message behind a callback (inline or regular). */
async function deleteMenuFromCallback(token, callbackQuery) {
  const inlineId = callbackQuery && callbackQuery.inline_message_id;
  const message = callbackQuery && callbackQuery.message;
  try {
    if (inlineId) {
      // Inline messages can only be deleted through the chat that hosts them,
      // which the bot does not know here; clearing the keyboard is the closest
      // supported action and leaves the text intact.
      await callApi(token, "editMessageReplyMarkup", {
        inline_message_id: inlineId,
        reply_markup: { inline_keyboard: [] },
      });
      return { ok: true, target: "inline" };
    }
    if (message && message.chat) {
      await callApi(token, "deleteMessage", {
        chat_id: message.chat.id,
        message_id: message.message_id,
      });
      return { ok: true, target: "chat" };
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: false, reason: "no-target" };
}

module.exports = {
  MENU_RESULT_PREFIX,
  QUERY_MAIN,
  QUERY_PAGE,
  QUERY_CAT,
  queryForPage,
  queryForCategory,
  parseMenuQuery,
  buildMenuResult,
  answerMenuQuery,
  parseRichQuery,
  buildRichBlocks,
  buildRichInfoResult,
  buildTextInfoResult,
  answerRichQuery,
  editMenuFromCallback,
  deleteMenuFromCallback,
  BotApiError,
};

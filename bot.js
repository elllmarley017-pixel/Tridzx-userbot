#!/usr/bin/env node
"use strict";
/**
 * bot.js — Bot API 10.3 inline bot (Rich Messages).
 *
 * ALUR (6 langkah)
 * ----------------
 *  1. User mengetik  @hanzgdbot status   (inline mode di chat mana pun)
 *  2. Telegram  →  inline_query  →  bot.js
 *  3. bot.js menyusun InlineQueryResultArticle
 *       input_message_content = { rich_message: { blocks: [...] } }
 *  4. bot.js  →  answerInlineQuery  (maks 50 hasil, next_offset utk paginasi)
 *  5. User memilih satu hasil; Telegram menampilkan preview rich message
 *  6. Telegram mengirim pesan itu ke chat tujuan dengan label "via @hanzgdbot"
 *
 * Bot ini TIDAK mengirim pesan ke chat: untuk inline mode, Telegram yang
 * mengirim. Bot hanya menjawab query (dan callback tombol).
 *
 * Jalankan:
 *   export BOT_TOKEN="123456:ABC..."     # dari @BotFather, jangan di-hardcode
 *   node bot.js
 *
 * Prasyarat: aktifkan inline mode di @BotFather → /setinline.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Shared menu catalogue + inline-menu helpers (single source of truth).
let menu = null;
let menuInline = null;
try {
  menu = require("./utils/menu");
  menuInline = require("./utils/menu_inline");
} catch {
  /* standalone use without the utils folder still works */
}

/* ------------------------------------------------------------------ *
 * Konfigurasi (env saja — tidak ada token di dalam kode)              *
 * ------------------------------------------------------------------ */
/** Muat `.env` sederhana tanpa dependensi. Env asli selalu menang. */
function loadEnvFile(file = path.join(__dirname, ".env")) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
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
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* .env opsional */
  }
}
loadEnvFile();

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const POLL_TIMEOUT = Math.max(1, Number(process.env.BOT_POLL_TIMEOUT || 25));
const PAGE_SIZE = Math.min(50, Math.max(1, Number(process.env.INLINE_PAGE_SIZE || 5)));
const MAX_RESULTS = 50;
const CACHE_TIME = Math.max(0, Number(process.env.INLINE_CACHE_TIME || 0));
/** Hanya owner yang boleh memakai bot (kosong = semua orang). */
const OWNER_IDS = String(process.env.BOT_OWNER_IDS || process.env.USERBOT_OWNER_ID || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
/** Media rich message HARUS file yang sudah diupload → pakai file_id. */
const MEDIA_FILE_ID = String(process.env.INLINE_MEDIA_FILE_ID || "").trim();
const LOCK_FILE = path.join(__dirname, "session", "inline_bot.lock");

/* ------------------------------------------------------------------ *
 * HTTP helper                                                         *
 * ------------------------------------------------------------------ */
class BotApiError extends Error {
  constructor(method, description, code, parameters) {
    super(description || `${method} gagal`);
    this.name = "BotApiError";
    this.method = method;
    this.errorCode = code;
    this.parameters = parameters || null;
  }
}

async function callApi(method, params = {}, options = {}) {
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, init);
  const json = await res.json().catch(() => null);
  if (!json || json.ok !== true) {
    throw new BotApiError(
      method,
      (json && json.description) || `HTTP ${res.status}`,
      (json && json.error_code) || res.status,
      json && json.parameters,
    );
  }
  return json.result;
}

/* ------------------------------------------------------------------ *
 * Rich Message blocks (bentuk yang diverifikasi Bot API 10.3)         *
 * ------------------------------------------------------------------ */
const esc = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const code = (value) => ({ type: "code", text: String(value) });
const bold = (value) => ({ type: "bold", text: String(value) });

/** `{ type: "buttons", buttons: [...] }` — RichBlockButtons. */
function buttonsRow(list) {
  return {
    type: "buttons",
    buttons: list.map((item) => {
      if (item.url) return { text: item.text, url: item.url, style: item.style };
      if (item.callback) return { text: item.text, callback_data: item.callback, style: item.style };
      return { text: item.text, copy_text: { text: item.copy || item.text }, style: item.style };
    }),
  };
}

/**
 * Tabel kompak. Setiap sel WAJIB objek (`RichBlockTableCell must be an object`).
 */
function table(headers, rows, caption) {
  return {
    type: "table",
    cells: [
      headers.map((value) => ({ text: value, is_header: true })),
      ...rows.map((row) => row.map((value) => ({ text: value }))),
    ],
    is_compact: true,
    is_striped: true,
    ...(caption ? { caption } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Konten yang ditampilkan bot                                         *
 * ------------------------------------------------------------------ */
const STARTED_AT = Date.now();

function uptime() {
  let total = Math.floor((Date.now() - STARTED_AT) / 1000);
  const days = Math.floor(total / 86400);
  total %= 86400;
  const hours = Math.floor(total / 3600);
  total %= 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts = [];
  if (days) parts.push(`${days}h`);
  if (hours) parts.push(`${hours}j`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function memoryMb() {
  const used = process.memoryUsage().rss / 1048576;
  return `${used.toFixed(1)} MB`;
}

/** Daftar perintah yang ditampilkan di menu. */
const COMMANDS = [
  [".bot <query>", "Kirim rich message dari bot ini (dari userbot)"],
  [".bot 2 <query>", "Pilih hasil ke-2"],
  [".botlist <query>", "Lihat daftar hasil inline"],
  [".start", "Menu userbot"],
  [".infobot", "Info bot & owner"],
];

/**
 * Katalog konten inline.
 * Setiap entri → satu InlineQueryResultArticle dengan rich message.
 */
function buildCatalog() {
  const entries = [];

  entries.push({
    key: "status",
    title: "📊 Status Server",
    description: "Uptime, memori, runtime",
    keywords: ["status", "server", "uptime", "health", "stat"],
    blocks: () => [
      { type: "heading", text: "📊 Status Server", size: 1 },
      table(
        ["Metrik", "Nilai"],
        [
          ["Uptime", uptime()],
          ["Memori (RSS)", memoryMb()],
          ["Runtime", `Node.js ${process.versions.node}`],
          ["Platform", `${os.platform()} ${os.arch()}`],
          ["Load avg", os.loadavg().map((n) => n.toFixed(2)).join(" · ")],
        ],
        "Diperbarui saat query",
      ),
      {
        type: "expandable_blockquote",
        text: [
          bold("Catatan"),
          "\nData diambil langsung dari proses bot saat query diterima.",
          "\nAngka dapat berubah setiap kali menu dibuka.",
        ],
        credit: "via bot",
      },
      buttonsRow([
        { text: "Refresh", callback: "act:status", style: "primary" },
        { text: "Salin", copy: "@hanzgdbot status" },
      ]),
      { type: "footer", text: "Rich Message · Bot API 10.3" },
    ],
  });

  entries.push({
    key: "menu",
    title: "📋 Daftar Perintah",
    description: "Semua perintah userbot",
    keywords: ["menu", "help", "bantuan", "perintah", "command", "daftar"],
    blocks: () => [
      { type: "heading", text: "📋 Daftar Perintah", size: 1 },
      table(
        ["Command", "Fungsi"],
        COMMANDS.map(([cmd, desc]) => [cmd, desc]),
        `${COMMANDS.length} perintah`,
      ),
      {
        type: "expandable_blockquote",
        text: "Ketik perintah di chat mana pun. Tombol di bawah menyalin format siap pakai.",
        credit: "via bot",
      },
      buttonsRow([
        { text: ".bot status", copy: ".bot status", style: "primary" },
        { text: ".botlist status", copy: ".botlist status" },
      ]),
      { type: "footer", text: "Inline mode · @hanzgdbot" },
    ],
  });

  entries.push({
    key: "ping",
    title: "🏓 Ping",
    description: "Latensi jawaban bot",
    keywords: ["ping", "latency", "latensi", "tes", "test"],
    blocks: () => [
      { type: "heading", text: "🏓 Pong", size: 2 },
      { type: "paragraph", text: [bold("Bot aktif. "), "Jawaban dibuat saat query diterima."] },
      table(["Item", "Nilai"], [["Waktu", new Date().toISOString()], ["Uptime", uptime()]]),
      { type: "footer", text: "via bot" },
    ],
  });

  entries.push({
    key: "about",
    title: "ℹ️ Tentang Bot",
    description: "Arsitektur bot + userbot",
    keywords: ["about", "tentang", "info", "arsitektur"],
    blocks: () => [
      { type: "heading", text: "ℹ️ Tentang", size: 1 },
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "Bot menerima inline_query dan menjawab answerInlineQuery." }] },
          { blocks: [{ type: "paragraph", text: "Hasil berupa rich message (blocks), bukan teks HTML biasa." }] },
          { blocks: [{ type: "paragraph", text: "Userbot memilih hasil dan mengirimnya lewat MTProto." }] },
          { blocks: [{ type: "paragraph", text: "Userbot tidak pernah memakai token bot." }] },
        ],
      },
      {
        type: "expandable_blockquote",
        text: "Label “via @bot” ditambahkan Telegram otomatis pada pesan hasil inline.",
        credit: "Telegram",
      },
    ],
  });

  return entries;
}

const CATALOG = buildCatalog();

/** Cari entri berdasarkan kata kunci judul/deskripsi/keywords. */
function searchCatalog(rawQuery) {
  const query = String(rawQuery || "").trim().toLowerCase();
  if (!query) return CATALOG.slice();
  const words = query.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const entry of CATALOG) {
    const haystack = [entry.key, entry.title, entry.description, ...entry.keywords]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const word of words) {
      if (!haystack.includes(word)) {
        score = 0;
        break;
      }
      if (entry.key === word) score += 10;
      else if (entry.keywords.includes(word)) score += 6;
      else if (entry.title.toLowerCase().includes(word)) score += 4;
      else score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.entry);
}

/* ------------------------------------------------------------------ *
 * InlineQueryResultArticle + InputRichMessageContent                  *
 * ------------------------------------------------------------------ */
/**
 * Satu hasil inline.
 *
 * `input_message_content.rich_message` adalah bentuk **InputRichMessageContent**
 * pada Bot API 10.3: objek yang sama dengan `sendRichMessage`. Dokumentasi
 * mensyaratkan tepat satu dari `html` / `markdown` / `blocks` → di sini selalu
 * `blocks`.
 */
function buildRichResult(entry, index) {
  const blocks = entry.blocks();
  if (MEDIA_FILE_ID) {
    // Media rich message hanya boleh file yang sudah diupload → `file_id`.
    blocks.splice(1, 0, {
      type: "photo",
      photo: { type: "photo", media: MEDIA_FILE_ID },
      caption: { text: entry.description },
    });
  }
  return {
    type: "article",
    id: `${entry.key}-${index}`.slice(0, 64),
    title: entry.title.slice(0, 64),
    description: entry.description.slice(0, 120),
    input_message_content: { rich_message: { blocks } },
  };
}

/**
 * Flatten a RichText value to **plain text**.
 * RichText nodes are objects (`{type, text}`), so `JSON.stringify` would emit
 * `{"type":...}` which Telegram rejects as invalid HTML ("Unsupported start tag").
 */
function richTextToPlain(value) {
  if (value == null || value === false || value === true) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(richTextToPlain).join("");
  if (typeof value === "object") {
    if (value.type === "custom_emoji") return String(value.alternative_text || "");
    if (value.type === "mathematical_expression") return String(value.expression || "");
    if (value.text !== undefined) return richTextToPlain(value.text);
    if (value.expression !== undefined) return String(value.expression);
  }
  return "";
}

/** One block → plain text lines (no markup). */
function blockToPlain(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "buttons") {
    return (node.buttons || []).map((b) => `[${richTextToPlain(b.text)}]`).join(" ");
  }
  if (node.type === "divider") return "-".repeat(24);
  if (node.type === "table") {
    return (node.cells || [])
      .map((row) => (row || []).map((cell) => richTextToPlain(cell && cell.text)).join(" | "))
      .join("\n");
  }
  if (node.type === "list") {
    return (node.items || [])
      .map((item) => `- ${(item.blocks || []).map(blockToPlain).join(" ")}`)
      .join("\n");
  }
  if (node.type === "details") {
    return `${richTextToPlain(node.summary)}\n${(node.blocks || []).map(blockToPlain).join("\n")}`;
  }
  if (node.blocks) return node.blocks.map(blockToPlain).join("\n");
  if (node.text !== undefined) return richTextToPlain(node.text);
  return "";
}

/**
 * Fallback terdokumentasi: `InputTextMessageContent` (plain text, tanpa markup).
 * `parse_mode` sengaja tidak diisi supaya tidak ada tag yang perlu di-escape.
 */
function buildTextResult(entry, index) {
  const plain = entry
    .blocks()
    .map(blockToPlain)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4096);
  return {
    type: "article",
    id: `${entry.key}-${index}`.slice(0, 64),
    title: entry.title.slice(0, 64),
    description: entry.description.slice(0, 120),
    input_message_content: {
      message_text: plain || entry.title,
      link_preview_options: { is_disabled: true },
    },
  };
}

/** Apakah query berasal dari owner (jika OWNER_IDS diisi)? */
function isAllowed(userId) {
  if (!OWNER_IDS.length) return true;
  return OWNER_IDS.includes(Number(userId));
}

/**
 * Jawab satu inline_query.
 * @returns {Promise<{answered: number, mode: string}>}
 */
async function answerInlineQuery(inlineQuery) {
  const queryId = inlineQuery.id;
  let rawQuery = String(inlineQuery.query || "").trim();
  const offset = Math.max(0, Number(inlineQuery.offset) || 0);

  // Prefix `!` = minta hasil teks (`InputTextMessageContent`).
  // Dipakai userbot sebagai fallback saat library MTProto-nya belum bisa
  // mem-parsing `botInlineMessageRichMessage`.
  const forceText = rawQuery.startsWith("!");
  if (forceText) rawQuery = rawQuery.slice(1).trim();

  if (!isAllowed(inlineQuery.from && inlineQuery.from.id)) {
    // Tetap dijawab (kosong) supaya klien tidak menggantung, tanpa bocor data.
    await callApi("answerInlineQuery", {
      inline_query_id: queryId,
      results: [],
      cache_time: 0,
      is_personal: true,
    });
    return { answered: 0, mode: "denied" };
  }

  // `.start` menu queries: answered with one article that carries the native
  // keyboard, so every page is reachable from a single message.
  if (menu && menuInline) {
    const parsed = menuInline.parseMenuQuery(rawQuery);
    if (parsed.isMenu) {
      const me = await callApi("getMe");
      const result = menuInline.buildMenuResult(parsed.page, { botUsername: me.username });
      await callApi("answerInlineQuery", {
        inline_query_id: queryId,
        results: [result],
        cache_time: 0,
        is_personal: true,
        next_offset: "",
      });
      console.log(`⚡ inline menu -> halaman ${parsed.page}`);
      return { answered: 1, mode: "menu" };
    }
  }

  const matches = searchCatalog(rawQuery);
  const page = matches.slice(offset, offset + PAGE_SIZE).slice(0, MAX_RESULTS);
  const hasMore = offset + page.length < matches.length;

  let results = forceText
    ? page.map((entry, index) => buildTextResult(entry, offset + index))
    : page.map((entry, index) => buildRichResult(entry, offset + index));
  let mode = forceText ? "text" : "rich";

  try {
    await callApi("answerInlineQuery", {
      inline_query_id: queryId,
      results,
      cache_time: CACHE_TIME,
      is_personal: true,
      next_offset: hasMore ? String(offset + page.length) : "",
    });
  } catch (err) {
    // Jika server belum mendukung rich content, ulangi dengan teks biasa.
    if (forceText || !/rich|RICH|content|parse/i.test(err.message)) throw err;
    results = page.map((entry, index) => buildTextResult(entry, offset + index));
    mode = "text";
    await callApi("answerInlineQuery", {
      inline_query_id: queryId,
      results,
      cache_time: CACHE_TIME,
      is_personal: true,
      next_offset: hasMore ? String(offset + page.length) : "",
    });
  }

  console.log(
    `⚡ inline "${rawQuery || "*"}"${forceText ? " [text]" : ""} offset=${offset} → ` +
      `${results.length} hasil (${mode})`,
  );
  return { answered: results.length, mode };
}

/* ------------------------------------------------------------------ *
 * Callback & pesan                                                    *
 * ------------------------------------------------------------------ */
async function handleCallback(callbackQuery) {
  const data = String(callbackQuery.data || "");
  try {
    if (data === "act:status") {
      await callApi("answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: `Uptime ${uptime()} · RAM ${memoryMb()}`,
        show_alert: true,
      });
      return "status";
    }
    await callApi("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    return "ok";
  } catch (err) {
    console.warn(`⚠️  callback: ${err.message}`);
    return "error";
  }
}

async function handleMessage(message) {
  const text = String(message.text || "").trim();
  const command = text.split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
  const chatId = message.chat.id;

  if (command === "/start" || command === "/help") {
    const me = await callApi("getMe");
    await callApi("sendMessage", {
      chat_id: chatId,
      text:
        `<b>🤖 @${esc(me.username)}</b>\n` +
        `Bot ini dipakai lewat <b>inline mode</b>.\n\n` +
        `Ketik <code>@${esc(me.username)} status</code> di chat mana pun, ` +
        `lalu pilih hasilnya.\n\n` +
        `Perintah userbot: <code>.bot &lt;query&gt;</code>`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Coba: status", switch_inline_query_current_chat: "status" },
            { text: "Daftar perintah", switch_inline_query_current_chat: "menu" },
          ],
        ],
      },
    });
    return "help";
  }
  if (command === "/id") {
    await callApi("sendMessage", {
      chat_id: chatId,
      text: `Chat ID: <code>${chatId}</code>\nUser ID: <code>${message.from && message.from.id}</code>`,
      parse_mode: "HTML",
    });
    return "id";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Single-instance lock                                                *
 * ------------------------------------------------------------------ */
function acquireLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    const raw = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, "utf8") : "";
    const pid = Number(String(raw).trim());
    if (pid && pid !== process.pid) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) return { ok: false, reason: `pid ${pid} masih berjalan` };
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: true, warning: err.message };
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (!pid || pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Main                                                                *
 * ------------------------------------------------------------------ */
async function main() {
  if (!BOT_TOKEN) {
    console.error("❌ BOT_TOKEN belum diset. Contoh: export BOT_TOKEN='123456:ABC…'");
    process.exit(1);
  }

  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`❌ Tidak bisa mulai: ${lock.reason}. Hentikan proses itu dulu.`);
    process.exit(1);
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    console.log("\n👋 Dihentikan.");
    process.exit(0);
  });

  const me = await callApi("getMe");
  console.log(`🤖 Bot: @${me.username} (${me.id})`);
  if (!me.supports_inline_queries) {
    console.log("⚠️  Inline mode BELUM aktif. Buka @BotFather → /setinline → pilih bot ini.");
    console.log("    Isi placeholder, mis.: 'Cari konten…'");
  } else {
    console.log("✅ Inline mode aktif");
  }
  console.log(`   Konten: ${CATALOG.length} entri · ${PAGE_SIZE} hasil/halaman`);
  if (OWNER_IDS.length) console.log(`   Owner: ${OWNER_IDS.join(", ")}`);
  if (MEDIA_FILE_ID) console.log("   Media: file_id terpasang pada rich message");

  try {
    await callApi("deleteWebhook", { drop_pending_updates: false });
  } catch (err) {
    console.warn(`⚠️  deleteWebhook: ${err.message}`);
  }

  let offset = 0;
  let conflicts = 0;
  for (;;) {
    try {
      const updates = await callApi(
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ["inline_query", "callback_query", "message"],
        },
        { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) },
      );
      conflicts = 0;
      for (const update of updates || []) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          if (update.inline_query) await answerInlineQuery(update.inline_query);
          else if (update.callback_query) await handleCallback(update.callback_query);
          else if (update.message) await handleMessage(update.message);
        } catch (err) {
          console.error(`⚠️  update ${update.update_id}: ${err.message}`);
        }
      }
    } catch (err) {
      if (/409|Conflict|terminated by other getUpdates/i.test(err.message)) {
        conflicts += 1;
        console.error(`⚠️  Konflik getUpdates (${conflicts}) — ada proses lain memakai token ini.`);
        await new Promise((r) => setTimeout(r, Math.min(30_000, 5000 * conflicts)));
        continue;
      }
      console.error(`⚠️  polling: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    releaseLock();
    console.error("❌", err.message);
    process.exit(1);
  });
}

module.exports = {
  buildCatalog,
  searchCatalog,
  buildRichResult,
  buildTextResult,
  richTextToPlain,
  blockToPlain,
  answerInlineQuery,
  handleCallback,
  handleMessage,
  callApi,
  esc,
  CATALOG,
  COMMANDS,
};

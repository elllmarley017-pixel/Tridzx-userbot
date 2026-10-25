#!/usr/bin/env node
"use strict";
/**
 * userbot.js — MTProto user account yang mengirim rich message dari inline bot.
 *
 * ALUR (6 langkah)
 * ----------------
 *  1. Owner mengetik  .bot status  di chat mana pun
 *  2. userbot.js memanggil  messages.getInlineBotResults(bot, peer, query, offset)
 *  3. Bot menjawab dengan InlineQueryResultArticle + InputRichMessageContent
 *  4. userbot.js memilih satu hasil (default: hasil pertama, atau `.bot 2 <q>`)
 *  5. userbot.js memanggil  messages.sendInlineBotResult(peer, query_id, id, random_id)
 *  6. Telegram mengirim rich message ke chat dengan label "via @bot"
 *
 * Userbot TIDAK memakai token bot sama sekali: seluruh interaksi dengan bot
 * terjadi lewat MTProto, memakai sesi akun user.
 *
 * Jalankan:
 *   export TG_API_ID=12345
 *   export TG_API_HASH=0123456789abcdef0123456789abcdef
 *   export USERBOT_BOT=hanzgdbot
 *   node userbot.js                     # login interaktif bila belum ada sesi
 *
 * Login pertama (interaktif, sekali saja):
 *   node userbot.js --login
 * Lalu simpan sesi:
 *   file: session/userbot.session (chmod 600, jangan di-commit)
 *   atau: export TG_SESSION="<string sesi>"  (StringSession, untuk CI)
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

// Termux: native-addon / node_modules resolution from shared storage.
try {
  require("./native_bootstrap");
} catch {
  /* not on Termux — a normal node_modules lookup still works */
}

/* ------------------------------------------------------------------ *
 * .env opsional (tanpa dependensi)                                    *
 * ------------------------------------------------------------------ */
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
    /* opsional */
  }
}
loadEnvFile();

let TelegramClient;
let Api;
let StringSession;
try {
  ({ TelegramClient, Api } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
} catch (err) {
  console.error("❌ Library 'telegram' (GramJS) belum terpasang.");
  console.error("   Jalankan: npm install telegram");
  console.error(`   (${err.message})`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Konfigurasi                                                         *
 * ------------------------------------------------------------------ */
const API_ID = Number(process.env.TG_API_ID || 0);
const API_HASH = String(process.env.TG_API_HASH || "").trim();
const SESSION_FILE = process.env.TG_SESSION_FILE || path.join(__dirname, "session", "userbot.session");
const SESSION_STRING = String(process.env.TG_SESSION || "").trim();
/** Username bot inline (tanpa @). */
const BOT_USERNAME = String(process.env.USERBOT_BOT || "hanzgdbot").replace(/^@/, "").trim();
/**
 * Mode permintaan ke bot.
 *   "rich"  (default) — minta hasil rich message; bila library MTProto tidak
 *                       bisa mem-parsing-nya, ulangi otomatis dengan "text".
 *   "text"            — langsung minta hasil teks (paling kompatibel).
 *
 * Kenapa perlu: Bot API 10.1+ mengirim `botInlineMessageRichMessage`
 * (constructor 0xa617e7b) ketika hasil inline berisi rich message. GramJS
 * 2.26.22 (layer 198) belum punya tipe `Rich*` sama sekali, sehingga
 * `tgReadObject` melempar TypeNotFoundError. Error ini tidak mematikan koneksi,
 * jadi permintaan bisa diulang dengan hasil non-rich.
 */
const INLINE_MODE = String(process.env.USERBOT_INLINE_MODE || "rich").toLowerCase();
/** Prefix perintah. */
const PREFIX = String(process.env.USERBOT_PREFIX || ".");
/** Timeout satu permintaan inline (ms). */
const INLINE_TIMEOUT = Math.max(1000, Number(process.env.USERBOT_INLINE_TIMEOUT || 15_000));
/** Batas hasil yang diminta. Bot membatasi maksimum 50 per query. */
const MAX_LIST = Math.min(50, Math.max(1, Number(process.env.USERBOT_INLINE_LIST || 10)));

/* ------------------------------------------------------------------ *
 * Sesi                                                               *
 * ------------------------------------------------------------------ */
function ensureSessionDir() {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
}

/** File sesi harus privat: hanya pemilik yang boleh membaca. */
function hardenSessionFile() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* Windows / FS tanpa permission: abaikan */
  }
}

function loadSession() {
  if (SESSION_STRING) {
    console.log("🔑 Memakai sesi dari TG_SESSION (StringSession).");
    return new StringSession(SESSION_STRING);
  }
  ensureSessionDir();
  hardenSessionFile();
  if (fs.existsSync(SESSION_FILE)) {
    const raw = fs.readFileSync(SESSION_FILE, "utf8").trim();
    if (raw) {
      try {
        return new StringSession(raw);
      } catch {
        console.warn("⚠️  File sesi tidak dapat dibaca, login ulang diperlukan.");
      }
    }
  }
  return new StringSession("");
}

/** Prompt interaktif (hanya dipakai saat login). */
function prompts() {
  const ask = async (label) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(label)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    phoneNumber: async () => ask("Nomor telepon (contoh +628123456789): "),
    password: async () => ask("Password 2FA (kosongkan jika tidak ada): "),
    phoneCode: async () => ask("Kode OTP dari Telegram: "),
    onError: (err) => console.error(`❌ Login gagal: ${err.message}`),
  };
}

function requireCredentials() {
  if (!Number.isInteger(API_ID) || API_ID <= 0) {
    console.error("❌ TG_API_ID belum diset (angka dari https://my.telegram.org).");
    process.exit(1);
  }
  if (!/^[a-f0-9]{32}$/i.test(API_HASH)) {
    console.error("❌ TG_API_HASH harus 32 karakter heksadesimal dari https://my.telegram.org.");
    console.error("   Catatan: token bot (@BotFather) TIDAK bisa dipakai sebagai API hash.");
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ *
 * Rich message helpers (tampilan lokal untuk daftar hasil)            *
 * ------------------------------------------------------------------ */
const esc = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const html = {
  b: (value) => `<b>${esc(value)}</b>`,
  i: (value) => `<i>${esc(value)}</i>`,
  code: (value) => `<code>${esc(value)}</code>`,
  a: (label, url) => `<a href="${esc(url)}">${esc(label)}</a>`,
  line: "┈".repeat(14),
};

/* ------------------------------------------------------------------ *
 * MTProto: inline query                                              *
 * ------------------------------------------------------------------ */
/**
 * Ambil hasil inline dari bot.
 *
 * Method: `messages.getInlineBotResults` — ADA di skema MTProto (layer 198),
 * diverifikasi lewat GramJS `Api.messages.GetInlineBotResults`:
 *   flags, bot, peer, geoPoint, query, offset
 *
 * @returns {Promise<{queryId: bigint, results: Array, nextOffset: string}>}
 */
async function getInlineResults(client, botEntity, peer, query, offset = "") {
  const request = new Api.messages.GetInlineBotResults({
    bot: botEntity,
    peer,
    query: String(query || ""),
    offset: String(offset || ""),
    geoPoint: new Api.InputGeoPoint({ lat: 0, long: 0, accuracyRadius: 1 }),
  });
  request.readResult = readBotResultsTolerant;
  const result = await client.invoke(request);
  return {
    queryId: result.queryId,
    results: result.results || [],
    nextOffset: result.nextOffset || "",
  };
}

const CTOR_BOT_RESULTS = 0xe021f2f6;
const CTOR_VECTOR = 0x1cb5c415;

/**
 * Parser `messages.botResults` yang tahan rich message.
 *
 * GramJS 2.26.x (layer 198) tidak punya `botInlineMessageRichMessage`
 * (0x0a617e7b), jadi parser bawaan melempar TypeNotFoundError untuk SELURUH
 * balasan. Kita hanya butuh `query_id` dan `id` hasil, jadi: coba parser
 * bawaan dulu; bila gagal karena tipe Rich*, baca manual header + hasil
 * pertama (id/type/title/description) lalu berhenti sebelum `send_message`.
 * Batas: hanya hasil pertama yang dapat dibaca pada jalur ini.
 */
function readBotResultsTolerant(reader) {
  const start = reader.tellPosition();
  try {
    return reader.tgReadObject();
  } catch (err) {
    if (!isUnsupportedRichError(err)) throw err;
    reader.setPosition(start);
  }
  if (reader.readInt(false) !== CTOR_BOT_RESULTS) throw new Error("messages.botResults: constructor tak dikenal");
  const flags = reader.readInt();
  const queryId = reader.readLong();
  const nextOffset = flags & 2 ? reader.tgReadString() : "";
  if (flags & (4 | 8)) throw new Error("messages.botResults: switch_pm/switch_webview tidak didukung pada jalur rich");
  if (reader.readInt(false) !== CTOR_VECTOR) throw new Error("messages.botResults: vector hasil tidak ditemukan");
  const count = reader.readInt();
  if (count < 1) return { queryId, results: [], nextOffset, rich: true };
  // Hanya botInlineResult (artikel) yang dibaca; media result tidak dipakai bot ini.
  const resultCtor = reader.readInt(false);
  if (resultCtor !== 0x11965f3a) throw new Error("messages.botResults: hasil bukan botInlineResult");
  const rflags = reader.readInt();
  const first = { id: reader.tgReadString(), className: "BotInlineResult", rich: true };
  first.type = reader.tgReadString();
  if (rflags & 2) first.title = reader.tgReadString();
  if (rflags & 4) first.description = reader.tgReadString();
  return { queryId, results: [first], nextOffset, rich: true, truncated: count > 1 };
}

/**
 * `messages.sendInlineBotResult` mengembalikan `Updates` berisi pesan rich
 * (constructor `message` layer baru) yang tidak bisa di-parse GramJS. Pesan
 * SUDAH terkirim saat balasan tiba, jadi kegagalan parse tidak boleh dianggap
 * kegagalan kirim.
 */
function readSendResultTolerant(reader) {
  const start = reader.tellPosition();
  try {
    return reader.tgReadObject();
  } catch (err) {
    if (!isUnsupportedRichError(err)) throw err;
    reader.setPosition(start);
    return { className: "UpdatesUnparsed", updates: [], unparsed: true };
  }
}

/**
 * Kirim satu hasil inline ke chat.
 *
 * Method: `messages.sendInlineBotResult` — ADA di skema MTProto:
 *   flags, silent, background, clearDraft, hideVia, peer, replyTo, randomId,
 *   queryId, id, scheduleDate, sendAs, quickReplyShortcut
 *
 * `randomId` harus angka 64-bit acak (GramJS: BigInt).
 */
async function sendInlineResult(client, peer, queryId, resultId) {
  const randomId = BigInt(Date.now()) * 1000n + BigInt(cryptoRandom(0, 999));
  const request = new Api.messages.SendInlineBotResult({
    peer,
    queryId,
    id: String(resultId),
    randomId,
  });
  request.readResult = readSendResultTolerant;
  return client.invoke(request);
}

function cryptoRandom(min, max) {
  const { randomInt } = require("node:crypto");
  return randomInt(min, max + 1);
}

/** Ambil pesan hasil dari `Updates` / `UpdatesCombined`. */
function extractMessage(updates) {
  const list = updates && updates.updates ? updates.updates : [];
  for (const update of list) {
    if (update.message) return update.message;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Perintah                                                           *
 * ------------------------------------------------------------------ */
/** Apakah teks adalah perintah userbot? */
function parseCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith(PREFIX)) return null;
  const body = raw.slice(PREFIX.length);
  const [name, ...rest] = body.split(/\s+/);
  return { name: (name || "").toLowerCase(), args: rest.join(" ").trim() };
}

/**
 * `.bot <query>` — kirim hasil pertama.
 * `.bot 2 <query>` — kirim hasil ke-2.
 * `.botlist <query>` — tampilkan daftar hasil.
 */
async function handleCommand(client, botEntity, event, parsed) {
  const peer = await client.getInputEntity(event.chatId);
  const chatId = event.chatId;

  if (parsed.name === "botlist") {
    const { results, mode } = await withTimeout(
      getInlineResultsSafe(client, botEntity, peer, parsed.args, ""),
      INLINE_TIMEOUT,
    );
    if (!results.length) {
      await client.sendMessage(chatId, {
        message: `${html.b("ℹ️ Tidak ada hasil")}\nQuery: ${html.code(parsed.args || "(kosong)")}`,
        parseMode: "html",
        linkPreview: false,
      });
      return;
    }
    const lines = results.slice(0, MAX_LIST).map((result, index) => {
      const title = result.title || (result.sendMessage && result.sendMessage.message) || "(tanpa judul)";
      return `${index + 1}. ${html.code(result.id)} — ${esc(String(title).slice(0, 60))}`;
    });
    await client.sendMessage(chatId, {
      message: [
        html.b("📋 Hasil Inline"),
        html.line,
        `${results.length} hasil untuk ${html.code(parsed.args || "*")}`,
        mode === "text"
          ? html.i("Mode teks: library MTProto belum mendukung rich message.")
          : html.i("Mode rich: pesan dikirim sebagai rich message."),
        "",
        ...lines,
        "",
        html.i(`Kirim dengan: ${PREFIX}bot <nomor> <query>`),
      ].join("\n"),
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  if (parsed.name !== "bot") return;

  // `.bot 2 status` → pilih hasil ke-2
  let index = 0;
  let query = parsed.args;
  const match = /^(\d+)\s*([\s\S]*)$/.exec(query);
  if (match) {
    index = Math.max(0, Number(match[1]) - 1);
    query = match[2].trim();
  }

  const { queryId, results, mode } = await withTimeout(
    getInlineResultsSafe(client, botEntity, peer, query, ""),
    INLINE_TIMEOUT,
  );

  if (!results.length) {
    await client.sendMessage(chatId, {
      message: [
        html.b("❌ Tidak ada hasil"),
        `Query: ${html.code(query || "(kosong)")}`,
        "",
        html.i(`Coba ${PREFIX}botlist ${query || ""} untuk melihat daftar.`),
      ].join("\n"),
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  const chosen = results[Math.min(index, results.length - 1)];
  const updates = await withTimeout(
    sendInlineResult(client, peer, queryId, chosen.id),
    INLINE_TIMEOUT,
  );
  const sent = extractMessage(updates);

  console.log(
    `✅ Terkirim: ${chosen.id} (${mode}) → chat ${chatId}` +
      (sent ? ` (msg ${sent.id}, viaBot=${sent.viaBotId || "-"})` : ""),
  );
}

/**
 * True when the error is the MTProto "unknown constructor" failure caused by a
 * rich inline result the installed layer cannot decode.
 */
function isUnsupportedRichError(err) {
  const message = String((err && (err.message || err.errorMessage)) || "");
  return (
    /Could not find a matching Constructor ID/i.test(message) ||
    /TypeNotFoundError/i.test(message) ||
    /invalidConstructorId/i.test(String(err && err.invalidConstructorId))
  );
}

/**
 * True when Telegram reports that the bot never answered the inline query.
 * Retrying immediately is pointless (the bot is down or the token is invalid),
 * so callers should fall back to another transport instead.
 */
function isBotTimeoutError(err) {
  const message = String((err && (err.message || err.errorMessage)) || "");
  return /BOT_RESPONSE_TIMEOUT|BOT_RESPONSE_TIMEOUT|query is too old/i.test(message);
}

/**
 * Ambil hasil inline dengan fallback otomatis.
 *
 * `query` dipakai apa adanya untuk percobaan pertama. Bila server membalas
 * hasil rich yang tidak bisa di-decode, query yang sama diminta ulang dengan
 * penanda `!` yang dipahami `bot.js` untuk mengirim hasil teks biasa
 * (`InputTextMessageContent`).
 *
 * @returns {Promise<{queryId: bigint, results: Array, nextOffset: string, mode: string}>}
 */
async function getInlineResultsSafe(client, botEntity, peer, query, offset = "") {
  const base = String(query || "").trim();

  if (INLINE_MODE === "text") {
    const plain = await getInlineResults(client, botEntity, peer, `!${base}`, offset);
    return { ...plain, mode: "text" };
  }

  try {
    const rich = await getInlineResults(client, botEntity, peer, base, offset);
    return { ...rich, mode: "rich" };
  } catch (err) {
    if (!isUnsupportedRichError(err)) throw err;
    console.log(
      "⚠️  Hasil rich tidak dapat dibaca library MTProto (layer tanpa tipe Rich*). " +
        "Mengulang dengan hasil teks…",
    );
    // A bot timeout is not a rich-parsing problem: propagate it so the caller
    // can fall back to a transport that does not depend on the bot answering.
    if (isBotTimeoutError(err)) throw err;
    const plain = await getInlineResults(client, botEntity, peer, `!${base}`, offset);
    return { ...plain, mode: "text" };
  }
}

/**
 * Bungkus promise dengan timeout agar chat tidak menggantung.
 *
 * Catatan: promise aslinya tidak bisa dibatalkan di MTProto, tetapi pemanggil
 * berhenti menunggu tepat saat timeout — itu yang dibutuhkan untuk beralih ke
 * transport lain. Promise yang kalah balapan diberi `.catch()` agar tidak
 * menghasilkan unhandled rejection.
 */
function withTimeout(promise, ms) {
  const guarded = Promise.resolve(promise);
  // The losing promise must never surface as an unhandled rejection.
  guarded.catch(() => {});
  const timeout = new Promise((_, reject) => {
    // Do NOT `unref()`: an unref'd timer lets the process/loop treat the wait as
    // idle, so the rejection is only observed much later. The timer is short and
    // always cleared implicitly when the race settles.
    setTimeout(() => {
      const err = new Error(`Timeout ${ms} ms`);
      err.code = "LOCAL_TIMEOUT";
      reject(err);
    }, ms);
  });
  // No `.finally()` here: it would wait for the *original* promise to settle,
  // which is exactly what we are trying to stop waiting for.
  return Promise.race([guarded, timeout]);
}

/* ------------------------------------------------------------------ *
 * Main                                                               *
 * ------------------------------------------------------------------ */
async function main() {
  requireCredentials();

  const loginOnly = process.argv.includes("--login");
  const session = loadSession();

  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: false,
    autoReconnect: true,
  });

  console.log("🔐 Menghubungkan ke Telegram…");
  await client.connect();

  let authorized = false;
  try {
    await client.getMe();
    authorized = true;
  } catch (err) {
    if (!/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_INVALID/.test(String(err.message))) {
      throw err;
    }
  }

  if (!authorized) {
    console.log("👤 Belum login. Ikuti prompt berikut (sekali saja).");
    await client.start(prompts());
    const saved = client.session.save();
    if (!SESSION_STRING) {
      ensureSessionDir();
      fs.writeFileSync(SESSION_FILE, String(saved), { mode: 0o600 });
      hardenSessionFile();
      console.log(`💾 Sesi disimpan: ${SESSION_FILE} (mode 600)`);
      console.log("   Jangan commit file ini. Backup dengan aman.");
    } else {
      console.log("💾 Sesi aktif (TG_SESSION). Simpan string itu di secret manager.");
    }
  }

  const me = await client.getMe();
  console.log(`✅ Login sebagai ${me.firstName || ""} (@${me.username || "tanpa username"})`);

  if (loginOnly) {
    console.log("✅ Login selesai (--login). Jalankan tanpa --login untuk memakai userbot.");
    await client.disconnect();
    process.exit(0);
  }

  let botEntity;
  try {
    botEntity = await client.getEntity(BOT_USERNAME);
  } catch (err) {
    console.error(`❌ Bot @${BOT_USERNAME} tidak dapat ditemukan: ${err.message}`);
    console.error("   Pastikan username benar dan akun pernah membuka bot tersebut.");
    process.exit(1);
  }
  console.log(`🤖 Bot inline: @${botEntity.username || BOT_USERNAME}`);

  const { NewMessage } = require("telegram/events");
  const { EditedMessage } = require("telegram/events");

  const handler = async (event) => {
    const text = event.message && event.message.message;
    const parsed = parseCommand(text);
    if (!parsed) return;
    if (!["bot", "botlist"].includes(parsed.name)) return;

    try {
      await handleCommand(client, botEntity, event, parsed);
    } catch (err) {
      const message = String(err.errorMessage || err.message || err);
      console.error(`❌ ${PREFIX}${parsed.name}: ${message}`);
      try {
        await client.sendMessage(event.chatId, {
          message: `${html.b("❌ Gagal")}\n${esc(message)}`,
          parseMode: "html",
          linkPreview: false,
          replyTo: event.message.id,
        });
      } catch {
        /* pelaporan gagal tidak boleh melempar */
      }
    }
  };

  client.addEventHandler(handler, new NewMessage({}));
  client.addEventHandler(handler, new EditedMessage({}));

  console.log(`\n✅ Userbot aktif. Coba: ${PREFIX}bot status`);
  console.log(`   ${PREFIX}botlist status   — lihat daftar hasil`);
  console.log("   Ctrl+C untuk berhenti.\n");

  process.on("SIGINT", async () => {
    console.log("\n👋 Berhenti.");
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseCommand,
  getInlineResults,
  readBotResultsTolerant,
  readSendResultTolerant,
  getInlineResultsSafe,
  isUnsupportedRichError,
  isBotTimeoutError,
  withTimeout,
  INLINE_TIMEOUT,
  INLINE_MODE,
  sendInlineResult,
  handleCommand,
  extractMessage,
  loadSession,
  html,
  PREFIX,
  BOT_USERNAME,
};

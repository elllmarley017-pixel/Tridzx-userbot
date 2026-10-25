"use strict";
/**
 * `.inline` — owner-only management of the Inline Mode catalogue.
 *
 * The userbot (MTProto) is the only component that can *see* and *download* the
 * owner's media; the Bot API process is the only component that can *serve*
 * Inline Mode. This handler is the bridge between them:
 *
 *   .inline add <judul> [#tag…]     reply → teks / foto / video / dokumen
 *   .inline list [kata] [n]         lihat katalog (dengan pencarian)
 *   .inline show <id>               detail satu item
 *   .inline del <id>                hapus item + media lokal
 *   .inline clear                   kosongkan katalog
 *   .inline upload [id|all]         unggah media lokal ke Bot API → file_id
 *   .inline send <id> [chat]        kirim item sebagai bot ke sebuah chat
 *   .inline search <kata>           uji mesin pencari inline
 *   .inline status                  ringkasan katalog + kesiapan inline
 *
 * Every sub-command is owner-only (see `utils/permissions.js`, deny-by-default)
 * and additionally guarded here so a future policy change cannot leak the
 * catalogue.
 */
const fs = require("node:fs");
const path = require("node:path");

const {
  BOT_TOKEN,
  INLINE_MAX_RESULTS,
  resolveBotToken,
  saveOwnerId,
} = require("../config");
const {
  editMarkdown,
  errorMessage,
  formatRichMessage,
  inlineCode,
} = require("../utils/formatting");
const { richButton } = require("../utils/rich_message");
const { command, chatId } = require("../utils/telegram");
const catalog = require("../utils/inline_catalog");
const upload = require("../utils/inline_upload");
const botApi = require("../utils/bot_api");
const inlineBot = require("../utils/inline_bot");
const permissions = require("../utils/permissions");

const PAGE_SIZE = 10;

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */
function token() {
  return resolveBotToken() || BOT_TOKEN || "";
}

/** Owner id used as the Bot API upload destination (the owner's own chat). */
function ownerChatId(client, event) {
  const candidates = [
    client && client.__me && client.__me.id,
    event && event.senderId,
    ...require("../config").ownerIds(),
  ];
  for (const value of candidates) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function typeIcon(type) {
  return {
    text: "📝",
    photo: "🖼️",
    video: "🎬",
    document: "📄",
    audio: "🎵",
    animation: "🎞️",
    voice: "🎙️",
  }[type] || "📦";
}

function kindLabel(item) {
  const size = item.size ? ` · ${(item.size / 1048576).toFixed(2)} MB` : "";
  const state = item.type === "text" ? "" : item.uploaded ? " · ✅ siap inline" : " · ⚠️ belum diunggah";
  return `${typeIcon(item.type)} ${inlineCode(item.type)}${size}${state}`;
}

async function repliedMessage(event) {
  if (!event?.isReply && event?.replyToMsgId == null) return null;
  try {
    return await event.message.getReplyMessage();
  } catch {
    return null;
  }
}

/** Deny anything that is not the account owner (defence in depth). */
async function requireOwner(client, event) {
  let owner = false;
  try {
    owner = await permissions.isOwner(client, event);
  } catch {
    owner = false;
  }
  if (!owner) {
    await editMarkdown(
      event,
      errorMessage("Fitur katalog inline hanya dapat digunakan oleh pemilik akun.", "Akses Ditolak"),
    );
    return false;
  }
  return true;
}

/** Extract `#tags` from an argument string, returning the remaining title. */
function splitTags(raw) {
  const tags = [];
  const words = [];
  for (const token_ of String(raw || "").split(/\s+/).filter(Boolean)) {
    if (token_.startsWith("#") && token_.length > 1) tags.push(token_.slice(1));
    else words.push(token_);
  }
  return { title: words.join(" ").trim(), tags };
}

/* ------------------------------------------------------------------ *
 * Cards                                                              *
 * ------------------------------------------------------------------ */
function itemCard(item, extra = []) {
  const details = [
    `<b>ID:</b> ${inlineCode(item.id)}`,
    `<b>Judul:</b> ${item.title}`,
    `<b>Jenis:</b> ${kindLabel(item)}`,
    item.tags.length ? `<b>Tag:</b> ${item.tags.map((tag) => inlineCode(`#${tag}`)).join(" ")}` : "",
    item.description ? `<b>Deskripsi:</b> ${item.description}` : "",
    item.file_name ? `<b>File:</b> ${inlineCode(item.file_name)}` : "",
    item.mime ? `<b>MIME:</b> ${inlineCode(item.mime)}` : "",
    item.type === "text" ? `<b>Isi:</b> ${inlineCode(item.text.slice(0, 160))}` : "",
    ...extra,
  ].filter(Boolean);

  return formatRichMessage({
    title: `${typeIcon(item.type)} ${item.title}`,
    body: item.type === "text" ? item.text.slice(0, 400) : item.caption || "",
    details,
    footer: "Gunakan di chat mana pun: ketik @bot lalu pilih konten ini.",
    buttons: [
      richButton("Cari", { copy_text: `@${botApiUsername() || "bot"} ${item.title}` }, "primary"),
      richButton("Hapus", { copy_text: `.inline del ${item.id}` }, "danger"),
    ],
  });
}

let cachedBotUsername = "";
function botApiUsername() {
  return cachedBotUsername;
}

function listCard(found, { query = "", page = 1 } = {}) {
  // `formatRichMessage({details})` already prefixes every line with "▸ ".
  const lines = found.items.map(
    (item) =>
      `${typeIcon(item.type)} ${inlineCode(item.id)} — <b>${item.title}</b>` +
      `${item.tags.length ? ` ${item.tags.map((t) => inlineCode(`#${t}`)).join(" ")}` : ""}`,
  );
  const stats = catalog.stats();
  const pages = Math.max(1, Math.ceil(found.total / PAGE_SIZE));
  return formatRichMessage({
    title: "🗂️ Katalog Inline",
    body: query ? `Hasil pencarian untuk ${inlineCode(query)}` : "Semua konten yang tersedia",
    details: lines.length ? lines : ["<i>Katalog masih kosong.</i>"],
    note:
      `<b>Total:</b> ${inlineCode(stats.total)} · ` +
      `<b>Halaman:</b> ${inlineCode(`${page}/${pages}`)} · ` +
      `<b>Cocok:</b> ${inlineCode(found.total)}`,
    footer: `Gunakan .inline list ${query ? `${query} ` : ""}${page + 1} untuk halaman berikutnya.`,
    buttons: [
      richButton("Tambah", { copy_text: ".inline add " }, "success"),
      richButton("Status", { copy_text: ".inline status" }, "primary"),
    ],
  });
}

function statusCard(me) {
  const stats = catalog.stats();
  const perType = catalog.ALL_TYPES.filter((type) => stats.byType[type])
    .map((type) => `${typeIcon(type)} ${type}: ${inlineCode(stats.byType[type])}`)
    .join(" · ");
  return formatRichMessage({
    title: "📊 Status Inline Mode",
    details: [
      `<b>Bot API:</b> ${
        me ? inlineCode(`@${me.username}`) : "❌ token belum diset / tidak valid (BOT_TOKEN)"
      }`,
      `<b>Inline Mode:</b> ${me && me.supports_inline_queries ? "✅ aktif" : "❌ belum aktif"}`,
      `<b>Katalog:</b> ${inlineCode(stats.total)} item`,
      `<b>Media siap:</b> ${inlineCode(stats.uploaded)} · <b>Belum diunggah:</b> ${inlineCode(stats.pending)}`,
      perType ? `<b>Per jenis:</b> ${perType}` : "",
      `<b>Berkas katalog:</b> ${inlineCode(path.basename(catalog.CATALOG_FILE))}`,
      `<b>Cache inline:</b> ${inlineCode("personal (0s)")}`,
    ].filter(Boolean),
    footer:
      me && me.supports_inline_queries
        ? `Coba: ketik @${me.username} di chat mana pun.`
        : "Aktifkan Inline Mode: @BotFather → /setinline.",
    buttons: [
      richButton("Daftar", { copy_text: ".inline list" }, "primary"),
      richButton("Tambah", { copy_text: ".inline add " }, "success"),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Sub-commands                                                       *
 * ------------------------------------------------------------------ */
async function addItem(client, event, raw) {
  const reply = await repliedMessage(event);
  const { title: rawTitle, tags } = splitTags(raw);

  if (!reply) {
    await editMarkdown(
      event,
      errorMessage(
        "Reply sebuah pesan (teks, foto, video, atau dokumen) lalu jalankan .inline add <judul>.",
        "Tidak Ada Konten",
      ),
    );
    return;
  }

  const body = String(reply.message || reply.text || "").trim();
  const kind = upload.mediaKind(reply.media, reply);
  if (!kind && !body) {
    await editMarkdown(
      event,
      errorMessage("Pesan yang di-reply tidak berisi teks atau media yang didukung.", "Konten Kosong"),
    );
    return;
  }

  const title = rawTitle || (kind ? upload.documentName(reply, kind) : body.split("\n")[0].slice(0, 60));
  const meta = kind ? upload.mediaMeta(reply, kind) : { mime: "", size: 0 };

  // Text item: no upload needed.
  if (!kind) {
    const { item, total } = catalog.add({
      type: "text",
      title,
      text: body,
      tags,
      source: { chat_id: chatId(event), message_id: reply.id },
    });
    await editMarkdown(event, itemCard(item, [`<b>Total katalog:</b> ${inlineCode(total)}`]));
    return;
  }

  const status = await editMarkdown(
    event,
    formatRichMessage({
      title: "⏳ Menambahkan Konten",
      body: `Mengunduh ${inlineCode(kind)} dari Telegram…`,
      compact: true,
    }),
  ).catch(() => null);

  let buffer;
  try {
    ({ buffer } = await upload.downloadUserbotMedia(client, reply, kind));
  } catch (err) {
    await editMarkdown(status || event, errorMessage(err.message, "Gagal Mengunduh Media"));
    return;
  }

  const fileName = upload.documentName(reply, kind);
  const mime = meta.mime || upload.guessMime(fileName, "application/octet-stream");
  const caption = String(reply.message || "").trim();

  // Try to upload right away so the item is instantly usable in Inline Mode.
  const token_ = token();
  const chat = ownerChatId(client, event);
  let uploaded = null;
  let uploadError = "";
  if (token_ && chat) {
    try {
      if (status) {
        await editMarkdown(
          status,
          formatRichMessage({
            title: "⏫ Mengunggah ke Bot API",
            body: `Mengunggah ${inlineCode(fileName)} agar dapat dikirim lewat Inline Mode…`,
            compact: true,
          }),
        ).catch(() => null);
      }
      uploaded = await upload.uploadMedia({
        token: token_,
        chatId: chat,
        buffer,
        kind,
        filename: fileName,
        mime,
        caption: caption ? caption.slice(0, 1024) : undefined,
        title: kind === "audio" ? title : undefined,
        duration: meta.duration || undefined,
      });
    } catch (err) {
      uploadError = err.message;
    }
  } else {
    uploadError = token_ ? "chat owner tidak diketahui" : "token Bot API tidak tersedia";
  }

  const localPath = uploaded ? "" : upload.persistLocal(buffer, upload.guessExtension(mime));

  const { item, total } = catalog.add({
    type: kind,
    title,
    tags,
    caption: caption.slice(0, 1024),
    mime: (uploaded && uploaded.mime) || mime,
    size: (uploaded && uploaded.size) || buffer.length,
    duration: (uploaded && uploaded.duration) || meta.duration || 0,
    width: (uploaded && uploaded.width) || meta.width || 0,
    height: (uploaded && uploaded.height) || meta.height || 0,
    file_name: (uploaded && uploaded.file_name) || fileName,
    audio_title: kind === "audio" ? title : "",
    file_id: uploaded ? uploaded.file_id : "",
    file_unique_id: uploaded ? uploaded.file_unique_id : "",
    uploaded: Boolean(uploaded),
    local_path: localPath,
    source: { chat_id: chatId(event), message_id: reply.id },
  });

  const extra = [`<b>Total katalog:</b> ${inlineCode(total)}`];
  if (uploadError) {
    extra.push(`<b>Upload:</b> ⚠️ ${uploadError}`);
    extra.push("Jalankan <code>.inline upload " + item.id + "</code> setelah masalah teratasi.");
  }
  await editMarkdown(status || event, itemCard(item, extra));
}

async function listItems(event, raw) {
  const args = String(raw || "").trim().split(/\s+/).filter(Boolean);
  let page = 1;
  if (args.length && /^\d+$/.test(args[args.length - 1])) {
    page = Math.max(1, Number(args.pop()));
  }
  const query = args.join(" ");
  const offset = (page - 1) * PAGE_SIZE;
  const found = catalog.search(query, { limit: PAGE_SIZE, offset });

  if (!found.total && page === 1) {
    await editMarkdown(
      event,
      formatRichMessage({
        title: "🗂️ Katalog Kosong",
        body: query
          ? `Tidak ada konten yang cocok dengan ${inlineCode(query)}.`
          : "Belum ada konten. Reply sebuah pesan lalu jalankan .inline add <judul>.",
        buttons: [richButton("Tambah Konten", { copy_text: ".inline add " }, "success")],
      }),
    );
    return;
  }
  await editMarkdown(event, listCard(found, { query, page }));
}

async function uploadItems(client, event, raw) {
  const arg = String(raw || "").trim();
  const token_ = token();
  if (!token_) {
    await editMarkdown(
      event,
      errorMessage("Token Bot API belum dikonfigurasi (BOT_TOKEN).", "Token Tidak Ada"),
    );
    return;
  }
  const chat = ownerChatId(client, event);
  if (!chat) {
    await editMarkdown(
      event,
      errorMessage("Chat ID owner tidak diketahui. Set owner_id di session/config.json.", "Owner Tidak Diketahui"),
    );
    return;
  }

  const pending = catalog
    .items()
    .filter((item) => item.type !== "text" && !item.uploaded)
    .filter((item) => !arg || arg === "all" || item.id === arg);

  if (!pending.length) {
    await editMarkdown(
      event,
      formatRichMessage({
        title: "✅ Tidak Ada yang Perlu Diunggah",
        body: arg && arg !== "all"
          ? `Item ${inlineCode(arg)} sudah siap atau tidak ditemukan.`
          : "Semua media di katalog sudah memiliki file_id Bot API.",
      }),
    );
    return;
  }

  let done = 0;
  const failures = [];
  for (const item of pending) {
    try {
      if (!item.local_path || !fs.existsSync(item.local_path)) {
        throw new Error("berkas lokal tidak ditemukan — tambahkan ulang dengan .inline add");
      }
      const buffer = fs.readFileSync(item.local_path);
      const uploaded = await upload.uploadMedia({
        token: token_,
        chatId: chat,
        buffer,
        kind: item.type,
        filename: item.file_name || `inline${upload.guessExtension(item.mime)}`,
        mime: item.mime,
        caption: item.caption || undefined,
        title: item.type === "audio" ? item.audio_title || item.title : undefined,
        duration: item.duration || undefined,
      });
      catalog.updateItem(item.id, {
        file_id: uploaded.file_id,
        file_unique_id: uploaded.file_unique_id,
        uploaded: true,
        size: uploaded.size || buffer.length,
        mime: uploaded.mime || item.mime,
        local_path: "",
      });
      try {
        fs.rmSync(item.local_path, { force: true });
      } catch {
        /* leftover temp file is harmless */
      }
      done += 1;
    } catch (err) {
      failures.push(`${item.id}: ${err.message}`);
    }
  }

  await editMarkdown(
    event,
    formatRichMessage({
      title: done ? "✅ Unggah Selesai" : "⚠️ Unggah Gagal",
      body: `${done} dari ${pending.length} item berhasil diunggah ke Bot API.`,
      details: failures.length ? failures.slice(0, 10).map((line) => `▸ ${line}`) : [],
      footer: "Item yang sudah diunggah dapat langsung dipakai di Inline Mode.",
      buttons: [richButton("Status", { copy_text: ".inline status" }, "primary")],
    }),
  );
}

async function sendItem(event, raw) {
  const args = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const id = args.shift();
  if (!id) {
    await editMarkdown(event, errorMessage("Format: .inline send <id> [chat_id|@username]", "Argumen Kurang"));
    return;
  }
  const item = catalog.get(id);
  if (!item) {
    await editMarkdown(event, errorMessage(`Item ${inlineCode(id)} tidak ditemukan.`, "Tidak Ditemukan"));
    return;
  }
  const token_ = token();
  if (!token_) {
    await editMarkdown(event, errorMessage("Token Bot API belum dikonfigurasi (BOT_TOKEN).", "Token Tidak Ada"));
    return;
  }
  const target = args.shift() || String(chatId(event));
  try {
    const sent = await inlineBot.sendItemAsBot(token_, item, target);
    await editMarkdown(
      event,
      formatRichMessage({
        title: "📤 Terkirim oleh Bot",
        body: `Item ${inlineCode(item.id)} dikirim sebagai bot ke ${inlineCode(target)}.`,
        details: [
          `<b>Message ID:</b> ${inlineCode(sent && sent.message_id)}`,
          `<b>Chat:</b> ${inlineCode(sent && sent.chat && sent.chat.id)}`,
        ],
        footer: "Pengiriman ini memakai identitas bot, bukan akun userbot.",
      }),
    );
  } catch (err) {
    await editMarkdown(event, errorMessage(err.message, "Gagal Mengirim"));
  }
}

async function searchItems(event, raw) {
  const query = String(raw || "").trim();
  if (!query) {
    await editMarkdown(event, errorMessage("Format: .inline search <kata kunci>", "Argumen Kurang"));
    return;
  }
  const found = catalog.search(query, { limit: INLINE_MAX_RESULTS });
  const parsed = found.parsed;
  const details = found.items.slice(0, 10).map(
    (item) => `${typeIcon(item.type)} ${inlineCode(item.id)} — <b>${item.title}</b>`,
  );
  await editMarkdown(
    event,
    formatRichMessage({
      title: "🔍 Hasil Pencarian Inline",
      body: `Kueri: ${inlineCode(query)}`,
      details: details.length ? details : ["<i>Tidak ada hasil.</i>"],
      note:
        `<b>Cocok:</b> ${inlineCode(found.total)} · ` +
        `<b>Kata:</b> ${parsed.terms.length ? parsed.terms.map((t) => inlineCode(t)).join(" ") : "-"} · ` +
        `<b>Jenis:</b> ${parsed.types.length ? parsed.types.map((t) => inlineCode(t)).join(" ") : "semua"}`,
      footer: "Urutan hasil di Inline Mode mengikuti skor judul → tag → isi.",
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Registration                                                       *
 * ------------------------------------------------------------------ */
/** Current bot identity (cached by `bot_api.verifyToken`), or null. */
async function botIdentity() {
  const current = token();
  if (!current) return null;
  const result = await botApi.verifyToken(current);
  if (!result.ok) return null;
  if (result.me && result.me.username) cachedBotUsername = result.me.username;
  return result.me;
}

function register(client) {
  // Warm the bot username so cards can suggest `@bot <judul>`.
  botIdentity().catch(() => {});

  command(
    client,
    /^\.inline(?:\s+([\s\S]*))?$/,
    async (event) => {
      if (!(await requireOwner(client, event))) return;

      const raw = String(event.patternMatch.group(1) || "").trim();
      const [sub = ""] = raw.split(/\s+/);
      const arg = raw.slice(sub.length).trim();
      const action = sub.toLowerCase();

      try {
        switch (action) {
          case "":
          case "help": {
            await editMarkdown(event, statusCard(await botIdentity()));
            return;
          }
          case "add":
            await addItem(client, event, arg);
            return;
          case "list":
            await listItems(event, arg);
            return;
          case "show": {
            const item = catalog.get(arg);
            if (!item) {
              await editMarkdown(event, errorMessage(`Item ${inlineCode(arg)} tidak ditemukan.`, "Tidak Ditemukan"));
              return;
            }
            await editMarkdown(event, itemCard(item));
            return;
          }
          case "del":
          case "delete": {
            const removed = catalog.remove(arg);
            await editMarkdown(
              event,
              removed
                ? formatRichMessage({
                    title: "🗑️ Item Dihapus",
                    body: `${typeIcon(removed.type)} ${removed.title} (${inlineCode(removed.id)}) dihapus dari katalog.`,
                    details: [`<b>Sisa item:</b> ${inlineCode(catalog.stats().total)}`],
                  })
                : errorMessage(`Item ${inlineCode(arg)} tidak ditemukan.`, "Tidak Ditemukan"),
            );
            return;
          }
          case "clear": {
            const count = catalog.clear();
            await editMarkdown(
              event,
              formatRichMessage({
                title: "🧹 Katalog Dikosongkan",
                body: `${count} item dihapus.`,
              }),
            );
            return;
          }
          case "upload":
            await uploadItems(client, event, arg);
            return;
          case "send":
            await sendItem(event, arg);
            return;
          case "search":
            await searchItems(event, arg);
            return;
          case "status": {
            await editMarkdown(event, statusCard(await botIdentity()));
            return;
          }
          case "owner": {
            const id = Number(arg);
            const saved = saveOwnerId(id);
            await editMarkdown(
              event,
              saved
                ? formatRichMessage({
                    title: "👑 Owner ID Disimpan",
                    body: `Inline Mode sekarang melayani ${inlineCode(saved)}.`,
                    footer: "ID ini dibaca oleh proses Bot API (npm run bot) untuk validasi akses.",
                  })
                : errorMessage("Owner ID harus berupa angka.", "ID Tidak Valid"),
            );
            return;
          }
          default:
            await editMarkdown(
              event,
              errorMessage(
                `Sub-command ${inlineCode(action)} tidak dikenal. Gunakan .inline untuk melihat status.`,
                "Sub-command Tidak Dikenal",
              ),
            );
        }
      } catch (err) {
        await editMarkdown(event, errorMessage(err.message, "Inline Gagal"));
      }
    },
    { ownerOnly: true },
  );
}

module.exports = {
  register,
  addItem,
  listItems,
  uploadItems,
  sendItem,
  searchItems,
  listCard,
  statusCard,
  itemCard,
  requireOwner,
  botIdentity,
  splitTags,
  ownerChatId,
  PAGE_SIZE,
};

"use strict";
/**
 * Broadcast control: `.bcall`, `.delay`, `.addbl`.
 *
 *   .bcall <teks>        kirim teks ke semua chat tujuan yang diizinkan
 *   .bcall               (reply) salin konten pesan yang di-reply
 *   .bcall add [chat]    daftarkan chat tujuan (default: chat ini)
 *   .bcall del <chat>    hapus chat tujuan
 *   .bcall list          tampilkan daftar tujuan & blacklist
 *   .bcall stop          hentikan proses yang sedang berjalan
 *   .delay <angka>       jeda antar pesan (ms, minimal 1000)
 *   .addbl               masukkan chat ini ke blacklist
 *   .addbl <chat>        masukkan chat tertentu ke blacklist
 *
 * All three commands are owner-only (see `utils/permissions.js`); the queue
 * itself lives in `utils/broadcast_queue.js` and the persisted state in
 * `utils/broadcast_store.js`.
 */
const { PROGRESS_UPDATE_INTERVAL } = require("../config");
const {
  block,
  editMarkdown,
  errorMessage,
  escapeMarkdown,
  exampleButton,
  formatRichMessage,
  inlineCode,
  respondMarkdown,
  text,
} = require("../utils/formatting");
const { buildRichMessage, richButton } = require("../utils/rich_message");
const { command, chatId, messageId } = require("../utils/telegram");
const store = require("../utils/broadcast_store");
const queue = require("../utils/broadcast_queue");
const discovery = require("../utils/chat_discovery");
const { markActivityFailed } = require("../utils/activity_logging");

/** Resolve a chat reference (`-100…`, `@username`, or a reply) to a dialog. */
async function resolveChatRef(client, ref, event) {
  const raw = String(ref || "").trim();
  if (!raw) {
    // No argument: use the chat the command was issued in.
    const id = store.normalizeId(chatId(event));
    if (id == null) throw new Error("Chat ini tidak dapat diidentifikasi.");
    let title = "";
    try {
      const entity = await client.getEntity(id);
      title = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || "";
    } catch {
      /* title is cosmetic */
    }
    return { id, title };
  }

  const numeric = store.normalizeId(raw);
  if (numeric != null) {
    let title = "";
    try {
      const entity = await client.getEntity(numeric);
      title = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || "";
    } catch {
      /* keep the bare id */
    }
    return { id: numeric, title };
  }

  const username = raw.replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) {
    throw new Error("Chat tujuan harus berupa ID angka atau @username yang valid.");
  }
  let entity;
  try {
    entity = await client.getEntity(username);
  } catch {
    throw new Error(`Chat @${username} tidak dapat diakses oleh akun ini.`);
  }
  const id = store.normalizeId(entity.id);
  if (id == null) throw new Error("ID chat tujuan tidak valid.");
  // Channel/supergroup ids are stored with the -100 prefix.
  const marked = typeof entity.className === "string" && /Channel/.test(entity.className)
    ? Number(`-100${entity.id}`)
    : id;
  return {
    id: marked,
    title: entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(" ") || "",
  };
}

/** Human-readable label for a stored target. */
function label(entry) {
  const title = entry.title ? escapeMarkdown(entry.title) : "<i>tanpa judul</i>";
  return `${title} · ${inlineCode(entry.id)}`;
}

/* ------------------------------------------------------------------ *
 * Cards                                                               *
 * ------------------------------------------------------------------ */
function statusCard(extra = {}) {
  const targets = store.targets();
  const blacklisted = store.blacklist();
  const delay = store.getDelay();
  const running = queue.isRunning();

  // Every button below is a RichTextButton inside a paragraph, using the
  // documented `text.example(prefix, text.button(richButton(...)))` shape.
  // `.bcall` always scans every dialog; `.bcall add` only appends extras.
  const mode = targets.length
    ? `semua chat tersedia + ${targets.length} dari .bcall add`
    : "semua chat tersedia";
  const rows = [
    block.paragraph("🎯 Mode tujuan: ", text.bold(mode)),
    exampleButton(`🎯 Target tambahan: ${targets.length} `, "Lihat", { copy_text: ".bcall list" }, "link"),
    exampleButton(`🚫 Blacklist: ${blacklisted.length} `, "Tambah Chat Ini", { copy_text: ".addbl" }, "primary"),
    exampleButton(`⏱ Delay: ${delay} ms `, "Ubah", { copy_text: ".delay 1500" }, "link"),
    block.paragraph(`📡 Status: ${running ? "🟠 Sedang berjalan" : "🟢 Idle"}`),
  ];

  return formatRichMessage({
    title: "📢 Broadcast Control",
    blocks: rows,
    ...extra,
    note:
      "Kirim teks dengan .bcall <teks>, atau reply sebuah pesan lalu ketik .bcall untuk menyalin isinya. " +
      "Pesan dikirim ke SEMUA grup, channel, dan chat pribadi yang dapat diakses akun. " +
      ".bcall add hanya menambah tujuan tertentu, bukan syarat. Chat blacklist selalu dilewati.",
    footer: `Owner-only · jeda aktif ${delay} ms · maksimal ${queue.MAX_TARGETS_PER_RUN} chat per proses.`,
    buttons: [
      richButton("Daftar Tujuan", { copy_text: ".bcall list" }, "primary"),
      richButton("Stop", { copy_text: ".bcall stop" }, "danger"),
    ],
  });
}

function targetListCard() {
  const targets = store.targets();
  const blacklisted = store.blacklist();

  // A destination list is tabular data: name + id read better as a table than
  // as bullet lines, and the table pipeline renders `<table>` (rich) or an
  // aligned `<pre>` block (parse_mode fallback).
  const toRows = (list) =>
    list.map((entry) => [entry.title || "tanpa judul", String(entry.id)]);
  const targetTable = targets.length
    ? { headers: ["Tujuan", "ID"], rows: toRows(targets), caption: `${targets.length} chat tujuan` }
    : null;
  const blackTable = blacklisted.length
    ? { headers: ["Blacklist", "ID"], rows: toRows(blacklisted), caption: `${blacklisted.length} chat` }
    : null;

  return formatRichMessage({
    title: "📋 Daftar Broadcast",
    table: targetTable,
    sections: [
      targetTable
        ? null
        : {
            title: "🎯 Chat Tujuan (0)",
            details: [
              "<i>Tidak ada tujuan tambahan. .bcall tetap mengirim ke semua dialog akun; " +
                ".bcall add hanya untuk menambah chat tertentu.</i>",
            ],
          },
      { title: "🚫 Blacklist", table: blackTable },
      blackTable ? null : { title: "🚫 Blacklist (0)", details: ["<i>Blacklist kosong.</i>"] },
    ].filter(Boolean),
    blocks: [
      exampleButton("Tambah tujuan: ", "Chat Ini", { copy_text: ".bcall add" }, "success"),
      exampleButton("Blacklist chat ini: ", "Tambahkan", { copy_text: ".addbl" }, "link"),
    ],
    footer: `Jeda aktif: ${store.getDelay()} ms · maksimal ${queue.MAX_TARGETS_PER_RUN} chat per proses.`,
  });
}

/** ` · 361 grup, 59 pribadi, 5 channel` for the footer. */
function kindsLabel(kinds) {
  if (!kinds || typeof kinds !== "object") return "";
  const parts = [
    [kinds.supergroup, "grup"],
    [kinds.user, "pribadi"],
    [kinds.channel, "channel"],
    [kinds.group, "grup"],
  ]
    .filter(([count]) => count)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? ` · ${[...new Set(parts)].join(", ")}` : "";
}

function progressCard(state, meta) {
  const pct = state.total ? Math.trunc((state.processed / state.total) * 100) : 0;
  // Numbers must be RichText nodes, not pre-rendered HTML strings: a plain
  // string is escaped by the renderer, which printed `&lt;code&gt;12&lt;/code&gt;`.
  const stat = (label, value) => block.paragraph(label, " ", text.code(String(value)));
  const rows = [
    block.paragraph(
      "📊 Progres: ",
      text.code(`${state.processed}/${state.total} (${pct}%)`),
    ),
    stat("✅ Terkirim:", state.sent),
    stat("❌ Gagal:", state.failed),
    stat("⏭ Dilewati:", state.skipped),
  ];
  if (state.current) {
    const title = state.current.title ? String(state.current.title) : String(state.current.id);
    const waiting = state.current.waiting ? ` · menunggu ${state.current.waiting}s` : "";
    rows.push(block.paragraph(`📨 Sekarang: ${title}${waiting}`));
  }
  if (state.floodWaits) rows.push(stat("⚠️ Flood wait:", state.floodWaits));

  return formatRichMessage({
    title: state.cancelled ? "🛑 Broadcast Dihentikan" : "📤 Broadcast Berjalan",
    blocks: rows,
    compact: true,
    footer: `Jeda ${meta.delayMs} ms · ${meta.targetCount} tujuan${
      meta.scanned ? ` · ${meta.scanned} dipindai` : ""
    }${kindsLabel(meta.kinds)}${meta.curated ? ` · +${meta.curated} dari .bcall add` : ""}`,
  });
}

function summaryCard(result, meta) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const failures = result.results
    .filter((item) => item.status === "failed")
    .slice(0, 5)
    .map((item) => `${escapeMarkdown(item.title || String(item.id))} — ${escapeMarkdown(item.reason || "gagal")}`);

  // `details` rows are RichText; inline code is expressed as a node so the
  // renderer emits real <code> instead of escaping a literal tag.
  const row = (label, value) => [
    text.bold(label),
    " ",
    text.code(String(value)),
  ];
  const details = [
    row("✅ Terkirim:", result.sent),
    row("❌ Gagal:", result.failed),
    row("⏭ Dilewati:", result.skipped),
    row("⏱ Durasi:", `${seconds}s`),
  ];
  if (result.floodWaits) details.push(row("⚠️ Flood wait:", result.floodWaits));
  if (failures.length) {
    details.push([text.bold("Kegagalan:"), `\n${failures.map((f) => `▸ ${f}`).join("\n")}`]);
  }

  const title = result.cancelled
    ? "🛑 Broadcast Dihentikan"
    : result.failed && !result.sent
      ? "❌ Broadcast Gagal"
      : "✅ Broadcast Selesai";

  const sourceLabel = `semua chat tersedia (${meta.scanned || 0} dipindai${
    meta.truncated ? ", dibatasi" : ""
  }${kindsLabel(meta.kinds)}${meta.curated ? `, +${meta.curated} dari .bcall add` : ""})`;
  return formatRichMessage({
    title,
    details,
    note: result.cancelReason ? escapeMarkdown(result.cancelReason) : undefined,
    footer: `Sumber: ${sourceLabel} · jeda ${meta.delayMs} ms · ${meta.targetCount} chat`,
    buttons: [
      richButton("Status", { copy_text: ".bcall" }, "primary"),
      richButton("Daftar Tujuan", { copy_text: ".bcall list" }, "link"),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Broadcast runner                                                    *
 * ------------------------------------------------------------------ */
/**
 * Resolve broadcast targets.
 *
 * `.bcall` now reaches **every chat the userbot can post to**, discovered from
 * the account's dialog list. The persisted `.bcall add` registry is still
 * honoured as an explicit allow-list override: when it is non-empty the owner
 * has opted into a curated list and that list wins.
 *
 * @returns {Promise<{targets: object[], source: string, skipped: object, scanned: number}>}
 */
/**
 * Build the broadcast target list.
 *
 * The account's dialog list is ALWAYS the source of truth: `.bcall <text>`
 * must reach every group, channel and private chat without requiring
 * `.bcall add` first. `.bcall add` only contributes extra chats that are not
 * reachable from the dialog list (or are pinned on purpose).
 *
 * @returns {Promise<{targets: object[], source: string, skipped: object,
 *                    scanned: number, truncated?: boolean, curated: number}>}
 */
async function resolveTargets(client, event) {
  let selfId = null;
  try {
    const me = client.__me || (await client.getMe());
    selfId = me && me.id != null ? String(me.id) : null;
  } catch {
    /* discovery still works without it; only "self" filtering degrades */
  }

  const found = await discovery.discoverChats(client, { selfId });

  // Optional extras from `.bcall add`: appended, never a prerequisite.
  const curated = store.targets();
  const seen = new Set(found.targets.map((target) => String(target.id)));
  const extras = [];
  for (const entry of curated) {
    const id = store.normalizeId(entry && entry.id);
    if (id == null || seen.has(String(id))) continue;
    seen.add(String(id));
    extras.push({ id, title: entry.title || "", kind: "curated" });
  }

  const targets = [...found.targets, ...extras];
  return {
    targets,
    // `dialogs` is reported even when extras exist, because the scan ran.
    source: extras.length ? "dialogs+registry" : "dialogs",
    skipped: found.skipped,
    scanned: found.scanned,
    truncated: found.truncated,
    curated: extras.length,
    kinds: found.kinds || {},
    unique: found.unique || 0,
  };
}

async function runBroadcast(client, event, payload, meta) {
  if (queue.isRunning()) {
    await editMarkdown(
      event,
      formatRichMessage({
        title: "⏳ Broadcast Sedang Berjalan",
        body: "Selesaikan atau hentikan proses sebelumnya terlebih dahulu.",
        buttons: [richButton("Hentikan", { copy_text: ".bcall stop" }, "danger")],
      }),
    );
    return;
  }

  // Duplicate guard: identical content inside the suppression window.
  if (queue.isDuplicate(meta.fingerprint)) {
    await editMarkdown(
      event,
      formatRichMessage({
        title: "♻️ Konten Duplikat",
        body: "Konten yang sama sudah dibroadcast beberapa saat lalu. Pengiriman dilewati untuk mencegah duplikat.",
        footer: "Tunggu 10 menit atau ubah isi pesan.",
      }),
    );
    return;
  }

  // Show a scanning status while the dialog list is being read.
  const scanning = await respondMarkdown(
    client,
    event,
    formatRichMessage({
      title: "🔎 Mengumpulkan Chat",
      body: "Membaca daftar chat yang dapat diakses akun userbot…",
      compact: true,
      footer: `Jeda ${store.getDelay()} ms · maksimal ${queue.MAX_TARGETS_PER_RUN} chat per proses.`,
    }),
  ).catch(() => null);

  let resolved;
  try {
    resolved = await resolveTargets(client, event);
  } catch (err) {
    markActivityFailed(err.message);
    await editMarkdown(
      scanning || event,
      errorMessage(err.message, "Gagal Membaca Daftar Chat"),
    );
    return;
  }

  // Filter blacklist/duplicates before queueing.
  const exclude = new Set();
  const sourceChat = store.normalizeId(chatId(event));
  if (sourceChat != null) exclude.add(sourceChat);
  const prepared = queue.prepareTargets(resolved.targets, { exclude });

  if (!prepared.targets.length) {
    const why = resolved.skipped || {};
    await editMarkdown(
      scanning || event,
      formatRichMessage({
        title: "🚫 Tidak Ada Chat yang Dapat Dikirimi",
        body:
          "Tidak ada chat yang dapat dikirimi pesan dari akun ini " +
          "(semua dialog tidak memenuhi syarat, diblacklist, atau dikecualikan).",
        details: [
          [text.bold("Chat dipindai:"), " ", text.code(String(resolved.scanned || 0))],
          [text.bold("Blacklist:"), " ", text.code(String(prepared.skipped.blacklisted))],
          [text.bold("Duplikat:"), " ", text.code(String(prepared.skipped.duplicate))],
          [text.bold("Dikecualikan:"), " ", text.code(String(prepared.skipped.excluded))],
          why.bot ? [text.bold("Bot:"), " ", text.code(String(why.bot))] : null,
          why.left ? [text.bold("Sudah keluar:"), " ", text.code(String(why.left))] : null,
          why.forbidden ? [text.bold("Pesan dilarang:"), " ", text.code(String(why.forbidden))] : null,
          why.channelNoPost
            ? [text.bold("Channel tanpa izin posting:"), " ", text.code(String(why.channelNoPost))]
            : null,
        ].filter(Boolean),
        footer: "Tambahkan chat tertentu dengan .bcall add bila perlu.",
      }),
    );
    return;
  }

  // Snapshot for the card labels only. The queue itself re-reads `.delay` on
  // every iteration, so `delayMs` is deliberately NOT passed to `runQueue`.
  const delayMs = store.getDelay();
  const metaInfo = {
    delayMs,
    targetCount: prepared.targets.length,
    scanned: resolved.scanned || 0,
    source: resolved.source,
    truncated: Boolean(resolved.truncated),
    curated: resolved.curated || 0,
    kinds: resolved.kinds || {},
  };

  // Reuse the scanning card as the progress card (avoids a second message).
  let placeholder = scanning;
  try {
    const card = progressCard({
      total: prepared.targets.length,
      processed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      floodWaits: 0,
      cancelled: false,
      current: null,
    }, metaInfo);
    if (placeholder) await editMarkdown(placeholder, card);
    else placeholder = await respondMarkdown(client, event, card);
  } catch {
    placeholder = placeholder || null;
  }

  // Throttle progress edits: editing too often is itself a flood risk.
  let lastEdit = 0;
  let lastState = null;
  const onProgress = async (state) => {
    lastState = state;
    const now = Date.now();
    if (now - lastEdit < PROGRESS_UPDATE_INTERVAL * 1000) return;
    lastEdit = now;
    if (!placeholder) return;
    try {
      await editMarkdown(placeholder, progressCard(state, metaInfo));
    } catch {
      /* a failed progress edit must never abort the broadcast */
    }
  };

  let result;
  try {
    result = await queue.runQueue({
      client,
      targets: prepared.targets,
      payload,
      fp: meta.fingerprint,
      onProgress,
    });
  } catch (err) {
    markActivityFailed(err.message);
    await editMarkdown(
      placeholder || event,
      errorMessage(err.message, "Broadcast Gagal", {
        example: text.example(
          "Cek status: ",
          text.button(richButton(".bcall", { copy_text: ".bcall" }, "primary")),
        ),
      }),
    );
    return;
  }

  const final = summaryCard(result, metaInfo);
  if (result.failed && !result.sent) markActivityFailed("Semua tujuan gagal");

  // Exactly one summary message. Editing the progress card is the normal path;
  // sending a fresh message is only a fallback when there was no card to edit.
  // The old code fell back on *any* edit error, which duplicated the summary.
  if (placeholder) {
    try {
      await editMarkdown(placeholder, final);
      void lastState;
      return;
    } catch (err) {
      // A failed edit must not swallow the result, but it also must not spam:
      // report the failure once and try a single fresh message.
      console.warn(`⚠️  Ringkasan broadcast tidak dapat mengedit kartu: ${err.message}`);
    }
  }
  await respondMarkdown(client, event, final);
  void lastState;
}

/* ------------------------------------------------------------------ *
 * Registration                                                        *
 * ------------------------------------------------------------------ */
function register(client) {
  /* ---------------------------- .bcall ---------------------------- */
  command(client, /^\.bcall(?:\s+([\s\S]*))?$/, async (event) => {
    const raw = String(event.patternMatch.group(1) || "").trim();
    const sub = raw.toLowerCase();

    // Sub-commands (strict match, so ordinary text like "add film" still sends).
    if (sub === "" || sub === "help") {
      const reply = await repliedMessage(event);
      if (sub === "" && reply) {
        await broadcastReply(client, event, reply);
        return;
      }
      await editMarkdown(event, statusCard());
      return;
    }

    if (sub === "list") {
      await editMarkdown(event, targetListCard());
      return;
    }

    if (sub === "stop") {
      const stopped = queue.cancel("Dibatalkan oleh owner.");
      await editMarkdown(
        event,
        formatRichMessage({
          title: stopped ? "🛑 Sinyal Hentikan Terkirim" : "ℹ️ Tidak Ada Proses",
          body: stopped
            ? "Broadcast akan berhenti setelah pesan yang sedang diproses selesai."
            : "Saat ini tidak ada broadcast yang berjalan.",
          buttons: [richButton("Status", { copy_text: ".bcall" }, "primary")],
        }),
      );
      return;
    }

    // Sub-commands are only recognised when their argument looks like a chat
    // reference, so ordinary text such as ".bcall add film baru" still sends.
    const looksLikeChat = (value) => {
      const v = String(value || "").trim();
      return v === "" || /^-?\d+$/.test(v) || /^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v);
    };

    if (sub === "add" || (sub.startsWith("add ") && looksLikeChat(raw.slice(3)))) {
      const arg = raw.slice(3).trim();
      try {
        const chat = await resolveChatRef(client, arg, event);
        if (store.isBlacklisted(chat.id)) {
          await editMarkdown(
            event,
            formatRichMessage({
              title: "🚫 Chat Dalam Blacklist",
              body: `Chat ${inlineCode(chat.id)} ada di blacklist. Hapus dulu dari blacklist sebelum dijadikan tujuan.`,
              buttons: [richButton("Lihat Daftar", { copy_text: ".bcall list" }, "link")],
            }),
          );
          return;
        }
        const { added, entry } = store.addTarget(chat.id, chat.title);
        await editMarkdown(
          event,
          formatRichMessage({
            title: added ? "✅ Chat Tujuan Ditambahkan" : "ℹ️ Chat Sudah Terdaftar",
            details: [`<b>Chat:</b> ${label(entry)}`, `<b>Total tujuan:</b> ${inlineCode(store.targets().length)}`],
            buttons: [richButton("Lihat Daftar", { copy_text: ".bcall list" }, "primary")],
          }),
        );
      } catch (err) {
        await editMarkdown(event, errorMessage(err.message, "Gagal Menambah Tujuan"));
      }
      return;
    }

    if (sub === "del" || sub === "delete" || sub.startsWith("del ")) {
      const arg = raw.replace(/^del(?:ete)?\s*/i, "").trim();
      const id = store.normalizeId(arg);
      // Not a chat id → treat the whole text as the broadcast body.
      if (id != null) {
        const removed = store.removeTarget(id);
        await editMarkdown(
          event,
          formatRichMessage({
            title: removed ? "🗑 Tujuan Dihapus" : "ℹ️ Tujuan Tidak Ditemukan",
            details: [`<b>Chat ID:</b> ${inlineCode(id)}`, `<b>Sisa tujuan:</b> ${inlineCode(store.targets().length)}`],
          }),
        );
        return;
      }
      // Fall through: "del …" was plain text, broadcast it instead.
    }

    // Anything else is the broadcast body.
    const body = raw;
    if (!body) {
      await editMarkdown(event, statusCard());
      return;
    }
    if (body.length > 4000) {
      await editMarkdown(
        event,
        errorMessage("Teks broadcast maksimal 4000 karakter.", "Teks Terlalu Panjang"),
      );
      return;
    }
    await runBroadcast(client, event, { kind: "text", text: body }, {
      fingerprint: queue.fingerprint({ kind: "text", text: body }),
    });
  });

  /* ---------------------------- .delay ---------------------------- */
  command(client, /^\.delay(?:\s+([\s\S]*))?$/, async (event) => {
    const raw = String(event.patternMatch.group(1) || "").trim();

    if (!raw) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "⏱ Pengaturan Delay",
          details: [
            [text.bold("Delay aktif:"), " ", text.code(`${store.getDelay()} ms`)],
            [text.bold("Minimum:"), " ", text.code(`${store.MIN_DELAY_MS} ms`)],
            [text.bold("Maksimum:"), " ", text.code(`${store.MAX_DELAY_MS} ms`)],
          ],
          note:
            "Delay adalah jeda antar pesan pada .bcall, dalam milidetik. Perubahan langsung " +
            "berlaku, termasuk untuk broadcast yang sedang berjalan.",
          example: text.example(
            "Ubah: ",
            text.button(richButton(".delay 1000", { copy_text: ".delay 1000" }, "primary")),
          ),
        }),
      );
      return;
    }

    if (!/^\d+$/.test(raw)) {
      await editMarkdown(
        event,
        errorMessage("Delay harus berupa angka bulat dalam milidetik (contoh: .delay 1500).", "Input Tidak Valid"),
      );
      return;
    }

    try {
      const { requested, applied, clamped } = store.setDelay(Number(raw));
      await editMarkdown(
        event,
        formatRichMessage({
          title: "✅ Delay Diperbarui",
          details: [
            [text.bold("Diminta:"), " ", text.code(`${requested} ms`)],
            [text.bold("Diterapkan:"), " ", text.code(`${applied} ms`)],
          ],
          note: clamped
            ? `Nilai dinaikkan otomatis ke batas aman ${store.MIN_DELAY_MS} ms agar tidak memicu flood wait.`
            : undefined,
          buttons: [richButton("Status", { copy_text: ".bcall" }, "primary")],
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Delay Tidak Valid"));
    }
  });

  /* ---------------------------- .addbl ---------------------------- */
  command(client, /^\.addbl(?:\s+([\s\S]*))?$/, async (event) => {
    const arg = String(event.patternMatch.group(1) || "").trim();

    try {
      const chat = await resolveChatRef(client, arg, event);
      const { added, entry } = store.addBlacklist(chat.id, chat.title);
      const removedFromTargets = store.removeTarget(chat.id);

      await editMarkdown(
        event,
        formatRichMessage({
          title: added ? "🚫 Chat Masuk Blacklist" : "ℹ️ Chat Sudah Di Blacklist",
          details: [
            `<b>Chat:</b> ${label(entry)}`,
            `<b>Total blacklist:</b> ${inlineCode(store.blacklist().length)}`,
          ],
          note: removedFromTargets
            ? "Chat ini juga dihapus dari daftar tujuan broadcast."
            : "Chat ini akan selalu dilewati oleh .bcall.",
          buttons: [richButton("Lihat Daftar", { copy_text: ".bcall list" }, "primary")],
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Gagal Menambah Blacklist"));
    }
  });
}

/* ------------------------------------------------------------------ *
 * Reply handling                                                      *
 * ------------------------------------------------------------------ */
async function repliedMessage(event) {
  if (!event?.isReply && event?.replyToMsgId == null) return null;
  try {
    return await event.message.getReplyMessage();
  } catch {
    return null;
  }
}

/** Broadcast the replied message: text is re-sent, media is copied. */
async function broadcastReply(client, event, reply) {
  const bodyText = String(reply.message || reply.text || "").trim();
  const hasMedia = Boolean(reply.media);

  if (!hasMedia && !bodyText) {
    await editMarkdown(
      event,
      errorMessage("Pesan yang di-reply tidak memiliki teks atau media.", "Konten Kosong"),
    );
    return;
  }

  if (hasMedia) {
    const sourceChat = store.normalizeId(chatId(event));
    if (sourceChat == null) {
      await editMarkdown(event, errorMessage("Chat sumber tidak dapat diidentifikasi.", "Gagal"));
      return;
    }
    await runBroadcast(
      client,
      event,
      { kind: "copy", sourceChat, messageId: reply.id },
      { fingerprint: queue.fingerprint({ kind: "copy", messageId: reply.id, fileId: sourceChat }) },
    );
    return;
  }

  await runBroadcast(client, event, { kind: "text", text: bodyText }, {
    fingerprint: queue.fingerprint({ kind: "text", text: bodyText }),
  });
}

module.exports = {
  register,
  statusCard,
  targetListCard,
  resolveChatRef,
  resolveTargets,
  runBroadcast,
  broadcastReply,
  MAX_TARGETS_PER_RUN: queue.MAX_TARGETS_PER_RUN,
};

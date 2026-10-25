"use strict";
/**
 * Owner & premium management: `.addowner`, `.delowner`, `.addprem`, `.delprem`.
 *
 * Rules enforced here (not only in the UI):
 *   - only the PRIMARY owner may manage the lists;
 *   - the primary owner can never be removed, even by itself;
 *   - a bot can never be an owner/premium;
 *   - references accept an id, `@username`, `username`, or a `t.me` link.
 */
const {
  editMarkdown,
  formatRichMessage,
  errorMessage,
  text,
} = require("../utils/formatting");
const { richButton } = require("../utils/rich_message");
const { command } = require("../utils/telegram");
const { ownerIds, loadConfig } = require("../config");
const access = require("../utils/access_store");
const permissions = require("../utils/permissions");

/** The primary owner: the account itself / the configured owner id. */
function primaryOwnerId(client) {
  const me = client && client.__me;
  if (me && me.id != null) return Number(me.id);
  const configured = ownerIds();
  return configured.length ? Number(configured[0]) : null;
}

/** Human label for a resolved user. */
function userLabel(user) {
  const handle = user.username ? `@${user.username}` : user.name || "tanpa username";
  return `${handle} · ${user.id}`;
}

/** Format remaining premium time as `X hari Y jam`. */
function remainingLabel(ms) {
  if (!(ms > 0)) return "kedaluwarsa";
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days) return `${days} hari${rest ? ` ${rest} jam` : ""}`;
  if (hours) return `${hours} jam`;
  return "kurang dari 1 jam";
}

/** `2026-11-24 16:15 WIB` */
function expiryLabel(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "-";
  return new Date(time).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Rows helper: bold label + inline code value. */
const row = (label, value) => [text.bold(label), " ", text.code(String(value))];

/**
 * Only the primary owner may manage lists.
 * @returns {Promise<boolean>} true when the sender is the primary owner
 */
async function requirePrimary(client, event) {
  const primary = primaryOwnerId(client);
  const sender = Number(event.senderId ?? event.message?.senderId ?? 0);
  if (primary == null) {
    await editMarkdown(event, errorMessage("Owner utama belum terdaftar.", "Akses Ditolak"));
    return false;
  }
  // Outgoing messages are authored by the account itself.
  const isSelf = event.message && event.message.out === true;
  if (sender !== primary && !isSelf) {
    await editMarkdown(
      event,
      errorMessage(
        `Hanya owner utama (${primary}) yang dapat mengelola owner dan premium.`,
        "Akses Ditolak",
      ),
    );
    return false;
  }
  return true;
}

/** Resolve a reference and surface a clean error when it fails. */
async function resolveOrFail(client, event, ref) {
  try {
    return await access.resolveUserRef(client, ref);
  } catch (err) {
    await editMarkdown(event, errorMessage(err.message, "Referensi Tidak Valid"));
    return null;
  }
}

function register(client) {
  /* --------------------------- .addowner --------------------------- */
  command(client, /^\.addowner(?:\s+([\s\S]+))?$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;
    const ref = String(event.patternMatch.group(1) || "").trim();
    if (!ref) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ ID/Username Diperlukan",
          body: "Tambahkan owner dengan ID, @username, atau tautan t.me.",
          example: text.example(
            "Contoh: ",
            text.button(richButton(".addowner @username", { copy_text: ".addowner @username" }, "primary")),
          ),
        }),
      );
      return;
    }

    const user = await resolveOrFail(client, event, ref);
    if (!user) return;

    const primary = primaryOwnerId(client);
    if (user.id === primary) {
      await editMarkdown(
        event,
        errorMessage("Pengguna tersebut sudah menjadi owner utama.", "Tidak Perlu Ditambahkan"),
      );
      return;
    }

    try {
      const { added } = access.addOwner(user.id, { by: primary });
      permissions.refreshOwners(client);
      await editMarkdown(
        event,
        formatRichMessage({
          title: added ? "✅ Owner Ditambahkan" : "ℹ️ Sudah Menjadi Owner",
          details: [
            row("Pengguna:", userLabel(user)),
            row("Total owner:", ownerIds().length + access.extraOwnerIds().length),
          ],
          note: added
            ? "Owner baru langsung memiliki seluruh akses fitur dan kontrol bot."
            : "Tidak ada perubahan; pengguna ini sudah ada di daftar owner.",
          footer: "Dikelola oleh owner utama",
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Gagal Menambah Owner"));
    }
  });

  /* --------------------------- .delowner --------------------------- */
  command(client, /^\.delowner(?:\s+([\s\S]+))?$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;
    const ref = String(event.patternMatch.group(1) || "").trim();
    if (!ref) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ ID/Username Diperlukan",
          example: text.example(
            "Contoh: ",
            text.button(richButton(".delowner @username", { copy_text: ".delowner @username" }, "primary")),
          ),
        }),
      );
      return;
    }

    const user = await resolveOrFail(client, event, ref);
    if (!user) return;

    // Guard: the primary owner can never be removed.
    const primary = primaryOwnerId(client);
    if (user.id === primary) {
      await editMarkdown(
        event,
        errorMessage(
          "Owner utama tidak dapat dihapus. Fitur ini hanya menghapus owner tambahan.",
          "Ditolak",
        ),
      );
      return;
    }

    try {
      const { removed } = access.removeOwner(user.id);
      permissions.refreshOwners(client);
      await editMarkdown(
        event,
        formatRichMessage({
          title: removed ? "✅ Owner Dihapus" : "ℹ️ Bukan Owner Tambahan",
          details: [
            row("Pengguna:", userLabel(user)),
            row("Owner tambahan:", access.extraOwnerIds().length),
          ],
          note: removed
            ? "Akses owner pengguna ini sudah dicabut."
            : "Pengguna ini tidak ada di daftar owner tambahan.",
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Gagal Menghapus Owner"));
    }
  });

  /* --------------------------- .addprem ---------------------------- */
  command(client, /^\.addprem(?:\s+([\s\S]+))?$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;
    const raw = String(event.patternMatch.group(1) || "").trim();
    const parts = raw.split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ Format Belum Lengkap",
          body: "Butuh ID/username dan jumlah hari.",
          example: text.example(
            "Contoh: ",
            text.button(
              richButton(".addprem @username 30", { copy_text: ".addprem @username 30" }, "primary"),
            ),
          ),
          footer: "Premium memberi akses fitur premium; fitur owner tetap terbatas.",
        }),
      );
      return;
    }

    const daysRaw = parts[parts.length - 1];
    const ref = parts.slice(0, -1).join(" ");
    if (!/^\d+$/.test(daysRaw)) {
      await editMarkdown(
        event,
        errorMessage(`Durasi "${daysRaw}" bukan angka hari yang valid.`, "Durasi Tidak Valid"),
      );
      return;
    }

    const user = await resolveOrFail(client, event, ref);
    if (!user) return;

    try {
      const result = access.addPremium(user.id, Number(daysRaw), { by: primaryOwnerId(client) });
      await editMarkdown(
        event,
        formatRichMessage({
          title: result.extended ? "✅ Premium Diperpanjang" : "✅ Premium Ditambahkan",
          details: [
            row("Pengguna:", userLabel(user)),
            row("Tambahan:", `${Number(daysRaw)} hari`),
            row("Total hari:", result.days),
            row("Kedaluwarsa:", expiryLabel(result.expiresAt)),
            row("Sisa waktu:", remainingLabel(Date.parse(result.expiresAt) - Date.now())),
          ],
          note: "Akses premium dicabut otomatis saat masa aktif berakhir.",
          footer: "Tersimpan permanen di session/access.json",
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Gagal Menambah Premium"));
    }
  });

  /* --------------------------- .delprem ---------------------------- */
  command(client, /^\.delprem(?:\s+([\s\S]+))?$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;
    const ref = String(event.patternMatch.group(1) || "").trim();
    if (!ref) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ ID/Username Diperlukan",
          example: text.example(
            "Contoh: ",
            text.button(richButton(".delprem @username", { copy_text: ".delprem @username" }, "primary")),
          ),
        }),
      );
      return;
    }

    const user = await resolveOrFail(client, event, ref);
    if (!user) return;

    try {
      const { removed } = access.removePremium(user.id);
      await editMarkdown(
        event,
        formatRichMessage({
          title: removed ? "✅ Premium Dicabut" : "ℹ️ Bukan Pengguna Premium",
          details: [
            row("Pengguna:", userLabel(user)),
            row("Pengguna premium aktif:", access.premiumList().length),
          ],
          note: removed
            ? "Akses premium pengguna ini sudah dicabut."
            : "Pengguna ini tidak memiliki premium aktif.",
        }),
      );
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Gagal Menghapus Premium"));
    }
  });

  /* -------------------------- .listowner -------------------------- */
  // Owner list: primary owner + every extra owner, with source and date.
  command(client, /^\.(?:listowner|ownerlist)$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;

    const primary = primaryOwnerId(client);
    const extras = access.extraOwners();
    const rows = [];

    if (primary != null) {
      rows.push([String(primary), "utama", "akun ini", "—"]);
    }
    for (const entry of extras) {
      rows.push([
        String(entry.id),
        "tambahan",
        entry.added_by ? String(entry.added_by) : "—",
        entry.added_at ? expiryLabel(entry.added_at) : "—",
      ]);
    }

    if (!rows.length) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "📋 Daftar Owner",
          body: "Belum ada owner terdaftar.",
          example: text.example(
            "Tambah: ",
            text.button(
              richButton(".addowner @username", { copy_text: ".addowner @username" }, "primary"),
            ),
          ),
        }),
      );
      return;
    }

    await editMarkdown(
      event,
      formatRichMessage({
        title: `📋 Daftar Owner (${rows.length})`,
        table: {
          headers: ["ID", "Peran", "Ditambahkan oleh", "Tanggal"],
          rows,
          caption: "Owner utama tidak dapat dihapus",
        },
        note: "Owner tambahan memiliki akses penuh seperti owner utama.",
        footer: "Kelola dengan .addowner / .delowner",
        buttons: [
          richButton("Tambah Owner", { copy_text: ".addowner " }, "primary"),
          richButton("Hapus Owner", { copy_text: ".delowner " }, "danger"),
        ],
      }),
    );
  });

  /* --------------------------- .listprem -------------------------- */
  // Premium list: id, remaining days, expiry, and whether it is still active.
  command(client, /^\.(?:listprem|premlist)$/, async (event) => {
    if (!(await requirePrimary(client, event))) return;

    const active = access.premiumList();
    if (!active.length) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "📋 Daftar Premium",
          body: "Belum ada pengguna premium aktif.",
          example: text.example(
            "Tambah: ",
            text.button(
              richButton(".addprem <id> 30", { copy_text: ".addprem 123456789 30" }, "primary"),
            ),
          ),
          footer: "Premium kedaluwarsa otomatis dicabut",
        }),
      );
      return;
    }

    const rows = active.map((entry) => [
      String(entry.id),
      `${entry.days} hari`,
      expiryLabel(entry.expires_at),
      remainingLabel(entry.remainingMs),
    ]);

    await editMarkdown(
      event,
      formatRichMessage({
        title: `📋 Daftar Premium (${active.length})`,
        table: {
          headers: ["ID", "Total", "Kedaluwarsa", "Sisa"],
          rows,
          caption: "Hanya premium aktif yang ditampilkan",
        },
        note: "Pengguna yang masa aktifnya habis otomatis kehilangan akses dan tidak lagi tampil di sini.",
        footer: "Kelola dengan .addprem / .delprem",
        buttons: [
          richButton("Tambah Premium", { copy_text: ".addprem " }, "primary"),
          richButton("Cabut Premium", { copy_text: ".delprem " }, "danger"),
        ],
      }),
    );
  });

}

module.exports = {
  register,
  primaryOwnerId,
  userLabel,
  remainingLabel,
  expiryLabel,
};

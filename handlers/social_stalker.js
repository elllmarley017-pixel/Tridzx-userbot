"use strict";

const {
  editMarkdown,
  errorMessage,
  escapeMarkdown,
  formatRichMessage,
  inlineCode,
  markdownLink,
  statusMessage,
  text,
  block,
} = require("../utils/formatting");
const { buildRichMessage, richButton } = require("../utils/rich_message");
const {
  ProfileNotFound,
  StalkerError,
  extraStalker,
  githubProfile,
  robloxProfile,
  tiktokProfile,
  instagramProfile,
  normalizeUsername,
  xProfile,
  facebookProfile,
} = require("../downloaders/social_stalker");
const { command } = require("../utils/telegram");

const NATIVE_COMMANDS = {
  igstalker: ["Instagram", instagramProfile],
  fbstalker: ["Facebook", facebookProfile],
  ttstalker: ["TikTok", tiktokProfile],
  githubstalker: ["GitHub", githubProfile],
  robloxstalker: ["Roblox", robloxProfile],
  xstalker: ["X/Twitter", xProfile],
};

function number(value) {
  if (value == null || value === "N/A") return "N/A";
  if (typeof value !== "number") return String(value);
  for (const [size, suffix] of [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ]) {
    if (value >= size) return `${(value / size).toFixed(1)}${suffix}`;
  }
  return String(value);
}

function status(privateFlag) {
  if (privateFlag === true) return "Private";
  if (privateFlag === false) return "Public";
  return "N/A";
}

function value(input, fallback = "N/A") {
  if (input == null || input === "") return fallback;
  return String(input);
}

function field(label, text) {
  return `<b>${escapeMarkdown(label)}:</b> ${text}`;
}

function fieldLink(label, text, url) {
  return `<b>${escapeMarkdown(label)}:</b> ${markdownLink(text, url)}`;
}

function booleanish(input) {
  if (input === true || input === false) return input ? "Ya" : "Tidak";
  return "N/A";
}

function profileMessage(profile) {
  const avatar =
    profile.avatar !== "N/A" ? markdownLink("Profile Picture", profile.avatar) : "N/A";
  const details = [
    field("👤 Username", inlineCode("@" + profile.username)),
    field("📛 Nama", escapeMarkdown(profile.name)),
    field("🖼️ Foto Profil", avatar),
    field("👥 Followers", inlineCode(number(profile.followers))),
    field("➡️ Following", inlineCode(number(profile.following))),
    field("📝 Bio", escapeMarkdown(profile.bio)),
    field("🔐 Status", inlineCode(status(profile.private))),
    field("📊 Postingan", inlineCode(number(profile.posts))),
    field("🔗 URL", markdownLink("Buka Profil", profile.url)),
  ];
  if (profile.platform === "GitHub") {
    details.push(
      field("📧 Email publik", escapeMarkdown(profile.email || "N/A")),
      field("📦 Repository", inlineCode(number(profile.repositories))),
    );
  }
  for (const [key, val] of Object.entries(profile.extras || {})) {
    details.push(field(escapeMarkdown(key), escapeMarkdown(val)));
  }
  details.push(
    text.example(
      "🔗 Aksi: ",
      text.button(richButton("Buka Profil", { url: profile.url }, "link")),
      " ",
      text.button(richButton("Salin", { copy_text: "@" + profile.username }, "primary")),
    ),
  );
  return formatRichMessage({
    title: `🔎 ${profile.platform} Stalker`,
    details,
    note: "Data publik saja; field yang tidak tersedia ditampilkan sebagai N/A.",
    footer: "Tombol di dalam teks membuka profil atau menyalin username.",
  });
}

function handleStalkerError(event, err, platform) {
  if (err instanceof ProfileNotFound) {
    editMarkdown(event, errorMessage(err.message, `Akun ${platform} Tidak Ditemukan`));
  } else if (err instanceof StalkerError) {
    editMarkdown(event, errorMessage(err.message, `${platform} Stalker Gagal`));
  } else {
    editMarkdown(
      event,
      errorMessage(`Layanan ${platform} tidak tersedia atau timeout`, `${platform} Stalker Gagal`),
    );
  }
}

function register(client) {
  const pattern = /^\.(ttstalker|githubstalker|robloxstalker|igstalker|xstalker|fbstalker)(?:\s+(.+))?$/;

  command(client, pattern, async (event) => {
    const cmd = String(event.patternMatch.group(1)).toLowerCase();
    const raw = event.patternMatch.group(2) || "";

    let username;
    try {
      username = normalizeUsername(raw);
    } catch (err) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ Username Tidak Valid",
          body: escapeMarkdown(err.message),
          example: text.example(
            "Contoh: ",
            text.button(richButton(`.${cmd} @username`, { copy_text: `.${cmd} @username` }, "primary")),
          ),
        }),
      );
      return;
    }

    const native = NATIVE_COMMANDS[cmd];
    if (!native) {
      await editMarkdown(
        event,
        errorMessage(`Perintah stalker tidak tersedia: .${cmd}`, "Perintah Tidak Valid"),
      );
      return;
    }

    const [platform, fetcher] = native;

    await editMarkdown(event, statusMessage(`Mencari akun ${platform}: ${inlineCode("@" + username)}...`));

    try {
      const profile = await fetcher(username);
      await editMarkdown(event, profileMessage(profile), { linkPreview: true });
    } catch (err) {
      handleStalkerError(event, err, platform);
    }
  });

  command(client, /^\.extrastalker(?:\s+(.+))?$/, async (event) => {
    const raw = event.patternMatch.group(1) || "";
    let username;
    try {
      username = normalizeUsername(raw);
    } catch (err) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ Query Tidak Valid",
          body: escapeMarkdown(err.message),
          example: text.example(
            "Contoh: ",
            text.button(richButton(".extrastalker username", { copy_text: ".extrastalker username" }, "primary")),
          ),
        }),
      );
      return;
    }

    await editMarkdown(event, statusMessage(`Mencari ${inlineCode(username)} pada ${inlineCode("38")} platform...`));
    try {
      const results = await extraStalker(username);
      const found = results.filter((r) => r.status === "found");
      const notFound = results.filter((r) => r.status === "not_found");
      const errors = results.filter((r) => r.status === "error");

      const lines = results.map((result) => {
        const icon = result.status === "found" ? "✅" : result.status === "not_found" ? "❌" : "⚠️";
        const label =
          result.status === "found"
            ? "Found"
            : result.status === "not_found"
              ? "Not Found"
              : "Error / Unavailable";
        let line;
        if (result.status === "found") {
          let prefix = `${icon} <b>${escapeMarkdown(result.platform)}</b> — ${markdownLink(label, result.url)}`;
          const profile = result.profile;
          if (profile && profile.followers != null) {
            prefix += ` · Followers ${inlineCode(number(profile.followers))}`;
          }
          if (profile && profile.repositories != null) {
            prefix += ` · Repos ${inlineCode(profile.repositories)}`;
          }
          return text.example(
            `${prefix} `,
            text.button(richButton("Buka", { url: result.url }, "link")),
          );
        }
        return `${icon} <b>${escapeMarkdown(result.platform)}</b> — ${label}`;
      });

      const message = formatRichMessage({
        title: "🔎 EXTRA STALKER",
        body: `Query: ${inlineCode(username)}`,
        details: lines,
        note:
          "Pemeriksaan exact public profile URL; bukan pencarian berdasarkan kemiripan nama. " +
          "Status Found pada platform tanpa API hanya berarti URL publik merespons tanpa indikator not-found.",
        footer: `Found: ${found.length}/38 · Not Found: ${notFound.length}/38 · Error: ${errors.length}/38`,
        buttons: [
          richButton("Salin Username", { copy_text: username }, "primary"),
          richButton("Cek Ulang", { callback_data: `extrastalker:${username}` }, "link"),
        ],
      });
      await editMarkdown(event, message, { linkPreview: false });
    } catch {
      await editMarkdown(
        event,
        errorMessage("Pencarian lintas platform gagal atau timeout", "Extra Stalker Gagal"),
      );
    }
  });
}

module.exports = { register, COMMANDS: NATIVE_COMMANDS };

"use strict";
/**
 * `.ghupload` — push the project to GitHub.
 *
 * Owner-only. The PAT comes from `GITHUB_TOKEN`; nothing is hard-coded and the
 * token is never echoed back into the chat.
 */
const {
  editMarkdown,
  formatRichMessage,
  errorMessage,
  text,
} = require("../utils/formatting");
const { richButton } = require("../utils/rich_message");
const { command } = require("../utils/telegram");
const { GitUploadError, uploadToGithub, DEFAULT_REMOTE } = require("../utils/git_upload");

const ROOT = require("node:path").join(__dirname, "..");

/** Repository name for display (`owner/repo`). */
function repoLabel(url = DEFAULT_REMOTE) {
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(String(url));
  return match ? `${match[1]}/${match[2]}` : String(url);
}

function resultCard(result) {
  const rows = [
    [text.bold("Repository:"), " ", text.code(repoLabel())],
    [text.bold("Branch:"), " ", text.code(result.branch)],
    [text.bold("Remote:"), " ", result.remote === "updated" ? "diperbarui" : "ditambahkan"],
    [
      text.bold("Commit:"),
      " ",
      result.committed
        ? text.code(`${result.committed.hash} · ${result.committed.files} file`)
        : "tidak ada perubahan baru",
    ],
  ];
  if (result.untracked && result.untracked.length) {
    rows.push([
      text.bold("Rahasia di-untrack:"),
      " ",
      text.code(String(result.untracked.length)),
    ]);
  }
  return formatRichMessage({
    title: "✅ Upload GitHub Berhasil",
    details: rows,
    note: result.committed
      ? `Pesan commit: ${result.committed.message}`
      : "Tidak ada commit kosong yang dibuat; HEAD sudah sama dengan remote.",
    footer: `HEAD ${result.head} · ${result.subject || "-"}`,
    buttons: [richButton("Status", { copy_text: ".ghupload" }, "primary")],
  });
}

function failureCard(err) {
  const stage = err instanceof GitUploadError ? err.stage : "internal";
  const hints = {
    config: "Set GITHUB_TOKEN (PAT dengan izin Contents: Read and write) di environment userbot.",
    auth: "Token tidak valid atau tidak punya izin Contents. Buat ulang PAT lalu restart userbot.",
    conflict: "Branch remote punya commit yang belum ada di lokal. Jalankan git pull --rebase.",
    network: "Periksa koneksi internet Termux lalu coba lagi.",
    secret: "Hapus/ubah file yang terdeteksi, lalu ulangi. Token tidak boleh masuk repository.",
  };
  return errorMessage(
    err.message,
    "Upload GitHub Gagal",
    {
      example: hints[stage]
        ? text.example(
            "Saran: ",
            text.button(richButton(hints[stage], { copy_text: hints[stage] }, "primary")),
          )
        : undefined,
    },
  );
}

function register(client) {
  command(client, /^\.ghupload$/, async (event) => {
    await editMarkdown(
      event,
      formatRichMessage({
        title: "⏳ Mengunggah ke GitHub",
        body: "Menyiapkan file, membuat commit, dan push ke branch main…",
        footer: `Repo ${repoLabel()} · token dari GITHUB_TOKEN`,
      }),
    );

    try {
      const result = await uploadToGithub({ cwd: ROOT });
      await editMarkdown(event, resultCard(result));
    } catch (err) {
      // The message is already redacted by `git_upload`; never print the token.
      await editMarkdown(event, failureCard(err));
    }
  });
}

module.exports = { register, repoLabel, resultCard, failureCard };

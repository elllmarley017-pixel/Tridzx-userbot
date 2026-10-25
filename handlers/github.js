"use strict";

const {
  copyField,
  Api } = require("telegram");
const fs = require("node:fs");
const path = require("node:path");

const {
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  formatRichMessage,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  inlineCode,
  statusMessage,
  successMessage,
  text,
} = require("../utils/formatting");
const { richButton } = require("../utils/rich_message");
const { downloadGithub } = require("../downloaders/github");
const { sanitizeFilename, mediaCaption } = require("../utils/helpers");
const { progressCallback, clearProgress } = require("../utils/progress");
const { cleanupFile } = require("../utils/cleanup");
const { command, chatId } = require("../utils/telegram");
const { TEMP_DIR } = require("../config");

function register(client) {
  command(client, /^\.github(?:\s+(.+))?$/, async (event) => {
    const url = String(event.patternMatch.group(1) || "").trim();
    if (!url) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: "❌ URL GitHub Diperlukan",
          example: text.example(
            "Contoh: ",
            text.button(
              richButton(".github https://github.com/username/repository", {
                copy_text: ".github https://github.com/username/repository",
              }, "primary"),
            ),
          ),
        }),
      );
      return;
    }

    await editMarkdown(event, statusMessage("Sedang mengambil repository..."));

    let filepath = null;
    try {
      const progress = async (current, total) => {
        await progressCallback(event, current, total, "Mengambil repository");
      };
      const status = async (stage) => {
        if (stage === "zip") await editMarkdown(event, statusMessage("Sedang membuat ZIP...", "📦"));
      };

      const native = await downloadGithub(url, { progressCb: progress, statusCb: status });
      filepath = native.filepath;

      const sizeMb = native.size / 1024 / 1024;
      const details = [
        `<b>Repository:</b> ${escapeMarkdown(`${native.owner}/${native.repo}`)}`,
        `<b>Branch:</b> ${inlineCode(escapeMarkdown(native.branch))}`,
        `<b>Ukuran:</b> ${inlineCode(`${sizeMb.toFixed(2)} MB`)}`,
      ];
      if (native.folder) {
        details.splice(2, 0, `<b>Path:</b> ${inlineCode(escapeMarkdown(native.folder))}`);
      }

      await editMarkdown(event, statusMessage("Sedang mengirim ZIP...", "📤"));
      const caption = formatRichMessage({
        title: "📦 GitHub Repository",
        details,
        blocks: [
          exampleButton("Aksi: ", "Buka Repo", { url }, "link"),
          copyField("Repository", `${native.owner}/${native.repo}`),
        ],
        // RichBlockDocument — the upstream archive is referenced inside the
        // message; the actual file is still uploaded as a document.
        document: {
          url: `https://github.com/${encodeURIComponent(native.owner)}/${encodeURIComponent(
            native.repo,
          )}/archive/refs/heads/${encodeURIComponent(native.branch)}.zip`,
          caption: `${native.filename} · ${sizeMb.toFixed(2)} MB`,
        },
      });
      await sendFileMarkdown(client, chatId(event), native.filepath, {
        caption,
        attributes: [new Api.DocumentAttributeFilename({ fileName: native.filename })],
        forceDocument: true,
      });
      await editMarkdown(event, successMessage("GitHub berhasil diproses."));
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "GitHub Gagal Diproses"));
    } finally {
      clearProgress(event.id);
      cleanupFile(filepath);
    }
  });
}

module.exports = { register };

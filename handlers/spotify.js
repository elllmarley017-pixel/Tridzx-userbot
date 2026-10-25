"use strict";

const { Api } = require("telegram");
const fs = require("node:fs");
const path = require("node:path");

const {
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  errorMessage,
  escapeMarkdown,
  statusMessage,
  successMessage,
} = require("../utils/formatting");
const { downloadSpotify } = require("../downloaders/spotify");
const { isSpotifyUrl, mediaCaption } = require("../utils/helpers");
const { progressCallback, clearProgress } = require("../utils/progress");
const { cleanupFile } = require("../utils/cleanup");
const { command, chatId } = require("../utils/telegram");
const { TEMP_DIR } = require("../config");

function register(client) {
  command(client, /^\.spotify\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isSpotifyUrl(url)) {
      await editMarkdown(
        event,
        errorMessage("URL tidak valid. Masukkan URL Spotify track.", "Input Tidak Valid"),
      );
      return;
    }

    await editMarkdown(event, statusMessage("Memproses download Spotify... 0%"));
    let filepath = null;
    let thumbPath = null;

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, "Memproses download");
      };
      const retryStatus = async (stage, attempt, attempts) => {
        await editMarkdown(
          event,
          formatMessage({
            title: "🔄 Mencoba Ulang",
            body: `Tahap: \`${stage}\`\nPercobaan: \`${attempt}/${attempts}\``,
          }),
        );
      };

      const native = await downloadSpotify(url, { progressCb: prog, statusCb: retryStatus });
      filepath = native.filepath;

      const { title, artist, album } = native;
      const details = [
        `<b>Judul:</b> ${escapeMarkdown(title)}`,
        `<b>Artis:</b> ${escapeMarkdown(artist || "Tidak diketahui")}`,
      ];
      if (album) details.push(`<b>Album:</b> ${escapeMarkdown(album)}`);
      const caption = mediaCaption("🎧 Spotify Audio", details);

      // Download thumbnail for Telegram thumb.
      let thumbFile = undefined;
      try {
        thumbPath = path.join(TEMP_DIR, `sthumb_${process.pid}.jpg`);
        const s = new (require("../utils/http").ClientSession)();
        const tr = await s.get(native.thumbnail || "", { timeout: 15 });
        if (tr.status === 200) {
          fs.writeFileSync(thumbPath, await tr.read());
          thumbFile = thumbPath;
        }
        await s.close();
      } catch {
        thumbPath = null;
      }

      const attrs = [
        new Api.DocumentAttributeAudio({
          duration: native.duration || 0,
          title,
          performer: artist || "Tidak diketahui",
        }),
      ];

      await editMarkdown(event, statusMessage("Mengirim audio...", "📤"));
      try {
        await sendFileMarkdown(client, chatId(event), filepath, {
          caption,
          voiceNote: false,
          attributes: attrs,
          thumb: thumbFile,
        });
      } finally {
        if (thumbFile) cleanupFile(thumbFile);
      }

      await editMarkdown(event, successMessage("Download selesai!"));
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Spotify Gagal"));
    } finally {
      clearProgress(event.id);
      if (filepath) cleanupFile(filepath);
    }
  });
}

module.exports = { register };

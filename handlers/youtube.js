"use strict";
/** YouTube commands — native download only. */
const fs = require("node:fs");

const {
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  formatRichMessage,
  statusMessage,
  errorMessage,
  escapeMarkdown,
  inlineCode,
  markdownLink,
  successMessage,
  text,
  block,
} = require("../utils/formatting");
const { buildRichMessage, richButton } = require("../utils/rich_message");
const { yt_search, yt_download } = require("../downloaders/youtube");
const youtubeEngine = require("../downloaders/youtube_engine");
const { prewarm } = require("../downloaders/youtube_engine");
const { DownloadError, validateDownload } = require("../downloaders/engine");
const { isYouTubeUrl, mediaCaption, formatDuration } = require("../utils/helpers");
const { progressCallback, clearProgress } = require("../utils/progress");
const { cleanupFile } = require("../utils/cleanup");
const { markActivityFailed } = require("../utils/activity_logging");
const { logDownload } = require("../utils/download_logging");
const { failureMessage, userLabel, fileSize } = require("../utils/downloader_common");
const { command, Api } = require("../utils/telegram");

function register(client) {
  // Warm the YouTube client in the background: the first search otherwise pays
  // a 30-45s player-script download and looks like a hang.
  youtubeEngine.prewarm();
  command(client, /^\.ytsearch\s+(.+)/, async (event) => {
    const query = (event.patternMatch.group(1) || "").trim();
    if (!query) {
      await editMarkdown(event, errorMessage("Masukkan kata kunci pencarian.", "Input Kosong"));
      return;
    }

    await editMarkdown(event, statusMessage(`Mencari ${inlineCode(query)}`));

    let results;
    try {
      results = await yt_search(query, { limit: 7 });
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, "Pencarian Gagal"));
      return;
    }

    if (!results.length) {
      await editMarkdown(event, errorMessage("Tidak ditemukan hasil.", "Hasil Kosong"));
      return;
    }

    // Every result carries inline Rich Message buttons (`RichTextButton`) that
    // copy the ready-to-use download command — never an InlineKeyboardButton.
    const lines = results.map((r, index) =>
      text.join(
        text.raw(
          `<b>${index + 1}. ${markdownLink(r.title, r.url)}</b>\n` +
            `　👤 ${escapeMarkdown(r.channel)}\n` +
            `　⏱ ${inlineCode(r.duration)} · 👁 ${inlineCode(r.views)} `,
        ),
        text.button(richButton("MP4", { copy_text: `.ytmp4 ${r.url}` }, "primary")),
        " ",
        text.button(richButton("MP3", { copy_text: `.ytmp3 ${r.url}` }, "success")),
      ),
    );

    const message = formatRichMessage({
      title: "🔎 Hasil Pencarian YouTube",
      body: `Kata kunci: ${inlineCode(query)}`,
      details: lines,
      footer: "Tombol di dalam teks menyalin command siap pakai.",
    });

    await editMarkdown(event, message, { linkPreview: false });
  });

  async function handleDownload(event, fmt) {
    const url = (event.patternMatch.group(1) || "").trim();
    const feature = fmt === "mp3" ? ".ytmp3" : ".ytmp4";
    if (!isYouTubeUrl(url)) {
      await editMarkdown(event, errorMessage("URL tidak valid. Masukkan URL YouTube.", "Input Tidak Valid"));
      return;
    }

    const user = await userLabel(event);
    let filepath = null;
    let thumbPath = null;
    let stage = "EXTRACTION";
    let lastProgress = -1;

    await editMarkdown(event, statusMessage("Mengunduh media YouTube... 0%"));
    logDownload(user, feature, "DOWNLOADING", { url, stage, progress: "0%" });

    try {
      const prog = async (current, total) => {
        const pct = total ? Math.trunc((current / total) * 100) : 0;
        await progressCallback(event, current, total, "Downloading");
        if (Math.trunc(pct / 10) !== Math.trunc(lastProgress / 10)) {
          lastProgress = pct;
          logDownload(user, feature, "DOWNLOADING", { url, stage: "DOWNLOAD", progress: `${pct}%` });
        }
      };

      const retryStatus = async (retryStage, attempt, attempts, detail) => {
        logDownload(user, feature, "RETRYING", {
          url,
          stage: retryStage,
          progress: `attempt ${attempt}/${attempts}`,
          error: detail,
        });
        await editMarkdown(
          event,
          formatMessage({
            title: "🔄 Mencoba Ulang",
            body: `Tahap: \`${retryStage}\`\nPercobaan: \`${attempt}/${attempts}\``,
          }),
        );
      };

      const native = await yt_download(url, { fmt, progress_cb: prog, status_cb: retryStatus });
      const result = {
        filepath: native.filepath,
        title: native.title,
        artist: native.artist || "Tidak diketahui",
        duration: native.duration || 0,
        quality: null,
        _nativeThumb: native.thumbnail || null,
      };

      filepath = validateDownload(result.filepath, { expectedExt: fmt });
      thumbPath = result._nativeThumb || null;
      const size = fileSize(filepath);
      stage = "TELEGRAM_UPLOAD";
      logDownload(user, feature, "DOWNLOADED", {
        url,
        stage: "FILE_VALIDATION",
        progress: "100%",
        file: filepath,
        size,
      });

      try {
        if (fmt === "mp3") {
          const title = result.title;
          const artist = result.artist || "Tidak diketahui";
          const caption = mediaCaption("🎵 YouTube Audio", [
            `<b>Judul:</b> ${escapeMarkdown(title)}`,
            `<b>Artis:</b> ${escapeMarkdown(artist)}`,
            `<b>Durasi:</b> ${inlineCode(formatDuration(result.duration || 0))}`,
          ]);
          const attrs = [
            new Api.DocumentAttributeAudio({
              duration: result.duration || 0,
              title,
              performer: artist,
            }),
          ];
          await sendFileMarkdown(client, event.chatId, filepath, {
            caption,
            voiceNote: false,
            attributes: attrs,
          });
        } else {
          const details = [`<b>Judul:</b> ${escapeMarkdown(result.title)}`];
          if (result.quality) details.push(`<b>Kualitas:</b> ${inlineCode(escapeMarkdown(result.quality))}`);
          if (result.duration) details.push(`<b>Durasi:</b> ${inlineCode(formatDuration(result.duration))}`);
          await sendFileMarkdown(client, event.chatId, filepath, {
            caption: mediaCaption("🎬 YouTube Video", details),
            supportsStreaming: true,
            attributes: [new Api.DocumentAttributeVideo({ duration: result.duration || 0, supportsStreaming: true })],
          });
        }
      } catch (err) {
        throw new DownloadError("TELEGRAM_UPLOAD", err.message);
      }

      logDownload(user, feature, "SUCCESS", {
        url,
        stage: "TELEGRAM_UPLOAD",
        progress: "100%",
        file: filepath,
        size,
      });
      await editMarkdown(event, successMessage("Download Selesai"));
    } catch (err) {
      if (err instanceof DownloadError) {
        markActivityFailed(`${err.stage}: ${err.detail}`);
        logDownload(user, feature, "FAILED", {
          url,
          stage: err.stage,
          error: err.detail,
          file: filepath || "-",
          size: fileSize(filepath),
        });
        await editMarkdown(event, failureMessage(err.stage, err.detail));
      } else {
        const detail = err.message || err.name || "Unknown error";
        markActivityFailed(`${stage}: ${detail}`);
        logDownload(user, feature, "FAILED", {
          url,
          stage,
          error: detail,
          file: filepath || "-",
          size: fileSize(filepath),
        });
        await editMarkdown(event, failureMessage(stage, detail));
      }
    } finally {
      clearProgress(event.id);
      cleanupFile(filepath, thumbPath);
    }
  }

  command(client, /^\.ytmp3\s+(.+)/, async (event) => handleDownload(event, "mp3"));
  command(client, /^\.ytmp4(?:\s+(\S+))?(?:\s+(\S+))?$/, async (event) => handleDownload(event, "mp4"));
}

module.exports = { register };

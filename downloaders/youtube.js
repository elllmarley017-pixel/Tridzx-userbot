"use strict";
/**
 * High-level YouTube downloader — replaces `downloaders/youtube.py`
 * and the yt-dlp orchestration the handler relied on.
 */
const fs = require("node:fs");
const path = require("node:path");

const { TEMP_DIR, MAX_FILE_SIZE } = require("../config");
const {
  DownloadError,
  validateDownload,
  downloadUrl,
  mergeMedia,
  convertToMp3,
  withRetries,
  cleanupCandidates,
} = require("./engine");
const youtubeEngine = require("./youtube_engine");
const { sanitizeFilename } = require("../utils/helpers");

const MEDIA_HEADERS = {
  "User-Agent": youtubeEngine.VISIONOS_UA,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.youtube.com",
  Referer: "https://www.youtube.com/",
};

function uniqueBase(title) {
  const safe = sanitizeFilename(title, 60) || "youtube";
  return path.join(TEMP_DIR, `${Date.now()}_${safe}`);
}

/**
 * Extract metadata only.
 * @returns {Promise<{title:string, author:string, lengthSeconds:number, ...}>}
 */
async function getInfo(url) {
  try {
    return await youtubeEngine.extractInfo(url);
  } catch (err) {
    throw new DownloadError("EXTRACTION", err.message);
  }
}

/**
 * Download a YouTube video as a Telegram-ready MP4 (video+audio muxed).
 * @returns {Promise<{filepath:string, info:object, size:number}>}
 */
async function downloadVideo(url, options = {}) {
  const { progressCallback = null, statusCallback = null, attempts = 3 } = options;

  return withRetries(
    async () => {
      let info;
      try {
        info = await youtubeEngine.extractInfo(url, { timeout: 60_000 });
      } catch (err) {
        throw new DownloadError("EXTRACTION", err.message);
      }

      const choice = youtubeEngine.chooseFormats(info.formats, "video", {
        maxSize: MAX_FILE_SIZE,
        duration: info.lengthSeconds,
      });

      const base = uniqueBase(info.title);
      const target = `${base}.mp4`;
      const videoPart = `${base}.video.${choice.video.container}`;
      const audioPart = choice.audio ? `${base}.audio.${choice.audio.container}` : null;

      try {
        if (choice.combined) {
          await downloadUrl(choice.video.url, videoPart, {
            headers: MEDIA_HEADERS,
            maxSize: MAX_FILE_SIZE,
            progressCallback,
          });
          fs.renameSync(videoPart, target);
        } else {
          await downloadUrl(choice.video.url, videoPart, {
            headers: MEDIA_HEADERS,
            maxSize: MAX_FILE_SIZE,
            progressCallback,
          });
          if (audioPart) {
            await downloadUrl(choice.audio.url, audioPart, {
              headers: MEDIA_HEADERS,
              maxSize: MAX_FILE_SIZE,
              progressCallback,
            });
            await mergeMedia(videoPart, audioPart, target);
          } else {
            fs.renameSync(videoPart, target);
          }
        }
      } finally {
        cleanupCandidates(`${base}.video.*`);
        cleanupCandidates(`${base}.audio.*`);
      }

      const filepath = validateDownload(target, { expectedExt: "mp4" });
      return { filepath, info, size: fs.statSync(filepath).size };
    },
    { attempts, statusCallback, glob: `${TEMP_DIR}/*.mp4` },
  );
}

/**
 * Download a YouTube video's audio as an MP3.
 * @returns {Promise<{filepath:string, info:object, size:number}>}
 */
async function downloadAudio(url, options = {}) {
  const { progressCallback = null, statusCallback = null, attempts = 3 } = options;

  return withRetries(
    async () => {
      let info;
      try {
        info = await youtubeEngine.extractInfo(url, { timeout: 60_000 });
      } catch (err) {
        throw new DownloadError("EXTRACTION", err.message);
      }

      const choice = youtubeEngine.chooseFormats(info.formats, "audio", {
        maxSize: MAX_FILE_SIZE,
      });

      const base = uniqueBase(info.title);
      const rawPart = `${base}.raw.${choice.audio.container}`;
      const target = `${base}.mp3`;

      try {
        await downloadUrl(choice.audio.url, rawPart, {
          headers: MEDIA_HEADERS,
          maxSize: MAX_FILE_SIZE,
          progressCallback,
        });
        await convertToMp3(rawPart, target, { bitrate: "192k" });
      } finally {
        cleanupCandidates(`${base}.raw.*`);
      }

      const filepath = validateDownload(target, { expectedExt: "mp3" });
      return { filepath, info, size: fs.statSync(filepath).size };
    },
    { attempts, statusCallback, glob: `${TEMP_DIR}/*.mp3` },
  );
}

/** Search helper re-exported for the handler. */
const search = (query, options) => youtubeEngine.search(query, options);

/**
 * Compatibility entry point mirroring `downloaders.youtube.yt_search`.
 * Maps the engine result fields to the names the handler expects.
 */
async function yt_search(query, options = {}) {
  const { limit = 7 } = options;
  const results = await youtubeEngine.search(query, { limit });
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    channel: r.author,
    duration: r.duration || "N/A",
    views: r.views || "N/A",
    id: r.id,
    thumbnail: r.thumbnail,
  }));
}

/**
 * Compatibility entry point mirroring `downloaders.youtube.yt_download`.
 *
 * @param {string} url
 * @param {object} options
 * @param {"mp3"|"mp4"} [options.fmt="mp4"]
 * @param {(current:number,total:number)=>Promise<void>} [options.progress_cb]
 * @param {(stage:string,attempt:number,attempts:number,detail:string)=>Promise<void>} [options.status_cb]
 * @returns {Promise<{filepath:string,title:string,artist:string,thumbnail:string|null,info:object,size:number}>}
 */
async function yt_download(url, options = {}) {
  const { fmt = "mp4", progress_cb = null, status_cb = null } = options;
  const result =
    fmt === "mp3"
      ? await downloadAudio(url, { progressCallback: progress_cb, statusCallback: status_cb })
      : await downloadVideo(url, { progressCallback: progress_cb, statusCallback: status_cb });

  const info = result.info;
  let thumbnail = null;
  if (Array.isArray(info.thumbnails) && info.thumbnails.length) {
    const best = [...info.thumbnails].sort(
      (a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0),
    )[0];
    thumbnail = best?.url || null;
  }

  // Return the duration so the caller can stamp audio metadata.
  return {
    filepath: result.filepath,
    title: info.title,
    artist: info.author || "Tidak diketahui",
    channel: info.author || "Tidak diketahui",
    duration: info.lengthSeconds,
    thumbnail,
    info,
    size: result.size,
  };
}

module.exports = {
  getInfo,
  downloadVideo,
  downloadAudio,
  search,
  yt_search,
  yt_download,
  videoIdFromUrl: youtubeEngine.videoIdFromUrl,
};

"use strict";
/**
 * Download orchestration — Node.js replacement for `downloaders/ytdlp_engine.py`.
 *
 * Provides the same staged, retrying, size-validated pipeline the Python code
 * exposed (`run_ytdlp` / `YTDLPDownloadError`), but performs the transfer with
 * `fetch` streaming instead of shelling out to yt-dlp.
 */
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { MAX_FILE_SIZE, REQUEST_TIMEOUT } = require("../config");
const { runFfmpeg } = require("../utils/process");

const TRANSIENT_MARKERS = [
  "contentlengtherror",
  "connection reset",
  "connection aborted",
  "timed out",
  "timeout",
  "remote end closed",
  "incomplete read",
  "temporary failure",
  "http error 429",
  "http error 500",
  "http error 502",
  "http error 503",
  "http error 504",
  "unable to download",
  "network is unreachable",
  "fragment",
  "fetch failed",
  "socket hang up",
];

/** Deterministic, staged download failure. Mirrors `YTDLPDownloadError`. */
class DownloadError extends Error {
  constructor(stage, detail) {
    super(`${stage}: ${detail}`);
    this.name = "DownloadError";
    this.stage = stage;
    this.detail = String(detail || "Unknown error").slice(0, 4000);
  }
}

const STAGES = [
  "EXTRACTION",
  "DOWNLOAD",
  "POSTPROCESS",
  "FILE_OUTPUT",
  "FILE_VALIDATION",
  "TELEGRAM_UPLOAD",
];

/**
 * Validate a produced file exactly like the Python `validate_download`:
 * existence, extension, read-ability, minimum size, max size, temp suffixes.
 */
function validateDownload(filePath, options = {}) {
  const { expectedExt = null, minimumSize = 1024 } = options;
  const absolute = filePath ? path.resolve(filePath) : "";
  if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new DownloadError("FILE_OUTPUT", `File tidak ditemukan: ${absolute || "-"}`);
  }
  if (expectedExt) {
    const wanted = `.${String(expectedExt).toLowerCase().replace(/^\./, "")}`;
    if (path.extname(absolute).toLowerCase() !== wanted) {
      throw new DownloadError("FILE_VALIDATION", `Ekstensi tidak sesuai: ${absolute}`);
    }
  }
  let size;
  try {
    size = fs.statSync(absolute).size;
    const fd = fs.openSync(absolute, "r");
    const header = Buffer.alloc(16);
    const read = fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (read === 0) throw new Error("file kosong");
  } catch (err) {
    throw new DownloadError("FILE_VALIDATION", `File tidak dapat dibaca: ${err.message}`);
  }
  if (size < minimumSize) {
    throw new DownloadError("FILE_VALIDATION", `Ukuran file tidak valid: ${size} byte`);
  }
  if (size > MAX_FILE_SIZE) {
    throw new DownloadError(
      "FILE_VALIDATION",
      `File terlalu besar (${(size / 1024 / 1024).toFixed(2)} MB), batas ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB`,
    );
  }
  if (absolute.endsWith(".part") || absolute.endsWith(".ytdl") || absolute.endsWith(".temp")) {
    throw new DownloadError("FILE_VALIDATION", `File masih sementara: ${absolute}`);
  }
  return absolute;
}

function isTransient(detail) {
  const text = String(detail).toLowerCase();
  return TRANSIENT_MARKERS.some((marker) => text.includes(marker));
}

function cleanupCandidates(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  // Simple glob: translate "name*.ext" into a prefix/suffix match.
  const match = base.match(/^(.*?)\*(.*)$/);
  if (!match) {
    if (fs.existsSync(pattern)) {
      try {
        fs.rmSync(pattern, { force: true });
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const [, prefix, suffix] = match;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Stream a direct media URL to `destination`, reporting progress and enforcing
 * the Telegram size ceiling.
 */
async function downloadUrl(url, destination, options = {}) {
  const {
    headers = {},
    timeout = REQUEST_TIMEOUT * 1000,
    stallTimeout = 60_000,
    maxSize = MAX_FILE_SIZE,
    progressCallback = null,
  } = options;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partPath = `${destination}.part`;

  // A total-request timeout is wrong for large media: a slow-but-healthy
  // transfer can legitimately take longer than the configured limit. Abort
  // only when the connection *stalls* (no bytes for `stallTimeout` ms).
  const controller = new AbortController();
  let stallTimer = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error('stalled')), stallTimeout);
  };
  const clearStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };

  // Time-to-first-byte guard: if the server doesn't answer the request at all
  // within `timeout`, abort early instead of hanging forever.
  const connectTimer = setTimeout(() => controller.abort(new Error('connect-timeout')), timeout);

  let response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(connectTimer);
    clearStallTimer();
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /aborted|abort/i.test(err.message || ''))) {
      throw new DownloadError('DOWNLOAD', `Timeout mengunduh media setelah ${timeout} ms`);
    }
    throw new DownloadError('DOWNLOAD', `Gagal menghubungi server media: ${err.message}`);
  }
  clearTimeout(connectTimer);

  if (!response.ok) {
    throw new DownloadError('DOWNLOAD', `Server media merespons status ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total && total > maxSize) {
    throw new DownloadError(
      'FILE_VALIDATION',
      `Media terlalu besar (${(total / 1024 / 1024).toFixed(2)} MB), batas ${(maxSize / 1024 / 1024).toFixed(0)} MB`,
    );
  }

  let downloaded = 0;
  const handle = fs.openSync(partPath, 'w');
  try {
    const reader = response.body.getReader();
    resetStallTimer();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStallTimer();
      downloaded += value.length;
      if (downloaded > maxSize) {
        throw new DownloadError(
          'FILE_VALIDATION',
          `Media melebihi batas ${(maxSize / 1024 / 1024).toFixed(0)} MB saat mengunduh`,
        );
      }
      fs.writeSync(handle, value);
      if (progressCallback) {
        try {
          await progressCallback(downloaded, total || downloaded);
        } catch {
          /* progress reporting must never break the transfer */
        }
      }
    }
  } catch (err) {
    fs.closeSync(handle);
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    if (err instanceof DownloadError) throw err;
    if (/stalled|aborted|abort/i.test(err.message || '')) {
      throw new DownloadError('DOWNLOAD', `Transfer terhenti (stall) melebihi ${stallTimeout} ms`);
    }
    throw new DownloadError('DOWNLOAD', `Transfer terputus: ${err.message}`);
  } finally {
    clearStallTimer();
  }
  fs.closeSync(handle);

  if (downloaded < 1) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    throw new DownloadError('DOWNLOAD', 'Server media tidak mengirimkan data (0 byte)');
  }

  fs.renameSync(partPath, destination);
  return destination;
}

/**
 * Merge separate audio + video streams into a single MP4.
 * Mirrors yt-dlp's `--merge-output-format mp4` post-processing step.
 */
async function mergeMedia(videoPath, audioPath, outputPath) {
  try {
    await runFfmpeg(
      [
        "-i",
        videoPath,
        "-i",
        audioPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { timeout: 600_000 },
    );
  } catch (err) {
    throw new DownloadError("POSTPROCESS", `Gagal menggabungkan video & audio: ${err.message}`);
  }
  return outputPath;
}

/** Extract an MP3 from any media file. */
async function convertToMp3(inputPath, outputPath, options = {}) {
  const args = [
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    options.bitrate || "192k",
    outputPath,
  ];
  try {
    await runFfmpeg(args, { timeout: 600_000 });
  } catch (err) {
    throw new DownloadError("POSTPROCESS", `Gagal mengubah ke MP3: ${err.message}`);
  }
  return outputPath;
}

/**
 * Generic retrying runner mirroring `run_ytdlp`'s retry/backoff semantics.
 * `attempt` receives the 1-based attempt number and must resolve to a file path.
 */
async function withRetries(attempt, options = {}) {
  const { attempts = 3, statusCallback = null, glob = null } = options;
  let lastError = new DownloadError("DOWNLOAD", "Unduhan tidak dijalankan");

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt(index + 1);
    } catch (err) {
      lastError = err instanceof DownloadError ? err : new DownloadError("DOWNLOAD", err.message);
      if (index + 1 < attempts) {
        if (statusCallback) {
          try {
            await statusCallback(lastError.stage, index + 2, attempts, lastError.detail);
          } catch {
            /* ignore */
          }
        }
        const waitMs = isTransient(lastError.detail) ? Math.min(2 ** index, 8) * 1000 : (index + 1) * 1000;
        await delay(waitMs);
      }
    }
  }
  if (glob) cleanupCandidates(glob);
  throw lastError;
}

module.exports = {
  DownloadError,
  STAGES,
  TRANSIENT_MARKERS,
  validateDownload,
  isTransient,
  cleanupCandidates,
  downloadUrl,
  mergeMedia,
  convertToMp3,
  withRetries,
};

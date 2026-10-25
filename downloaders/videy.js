'use strict';

/**
 * Videy downloader — handles CDN direct .mp4 and scraper pages.
 *
 * Replaces the yt-dlp fallback with the bundled YouTube-style generic HTTP
 * downloader and ffmpeg (no Python dependency).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { TEMP_DIR, MAX_FILE_SIZE } = require('../config');
const { ensureTempDir, cleanupFile } = require('../utils/cleanup');
const { ClientSession } = require('../utils/http');
const { validateDownload } = require('./engine');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function resolveDirectUrl(url) {
  const clean = url.includes('streamrizz.com') ? url : url.split('?')[0];

  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: url,
  };

  const session = new ClientSession();
  try {
    try {
      const head = await session.head(clean, { headers, allowRedirects: true, timeout: 30 });
      const ct = head.headers.get('content-type') || '';
      if (ct.startsWith('video/')) return head.url;
    } catch {
      /* fall through to GET */
    }

    const resp = await session.get(url, { headers, allowRedirects: true, timeout: 30 });
    const finalUrl = resp.url;
    const ct = resp.headers.get('content-type') || '';
    if (ct.startsWith('video/')) return finalUrl;

    const html = await resp.text();

    const patterns = [
      /<source[^>]+src="(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /src="(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /src='(https?:\/\/[^']+\.mp4[^']*)'/i,
      /file:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /source:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
      /"(https?:\/\/[^"]+\.mp4(?:\?[^"]*)?)"/i,
    ];
    for (const pat of patterns) {
      const m = pat.exec(html);
      if (m) return m[1];
    }
  } finally {
    await session.close();
  }

  return clean;
}

/** Stream-download a video URL via HTTP. Returns filepath or "" if HTML. */
async function downloadWithHttp(url, filepath, progressCb) {
  const headers = { 'User-Agent': UA, Referer: url };
  const session = new ClientSession();
  try {
    const resp = await session.get(url, { headers, allowRedirects: true, timeout: 300 });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status} saat download video`);

    const ct = resp.headers.get('content-type') || '';
    const total = Number(resp.headers.get('content-length') || 0);

    if (total > MAX_FILE_SIZE) {
      throw new Error(
        `File terlalu besar: ${(total / (1024 * 1024)).toFixed(1)}MB (maks ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB)`,
      );
    }
    if (ct.includes('text/html')) return '';

    const out = fs.createWriteStream(filepath);
    let downloaded = 0;
    try {
      for await (const chunk of resp.iterChunked(1024 * 1024)) {
        out.write(chunk);
        downloaded += chunk.length;
        if (progressCb && total) await progressCb(downloaded, total);
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  } finally {
    await session.close();
  }
  return filepath;
}

/** Fallback for pages that only expose a playable stream — use the engine. */
async function downloadWithEngine(url, filepath, progressCb) {
  const engine = require('./engine');
  const youtubeEngine = require('./youtube_engine');

  // Try a direct HTTP fetch of the resolved media first.
  const direct = await resolveDirectUrl(url);
  try {
    const result = await downloadWithHttp(direct, filepath, progressCb);
    if (result && fs.existsSync(result)) {
      return validateDownload(result, { expectedExt: 'mp4' });
    }
  } catch {
    /* fall through to yt-dlp-style extraction */
  }

  const info = await youtubeEngine.extractInfo(url, { timeout: 60_000 });
  const choice = youtubeEngine.chooseFormats(info.formats, 'video', {
    maxSize: MAX_FILE_SIZE,
    duration: info.lengthSeconds,
  });
  const headers = {
    'User-Agent': youtubeEngine.VISIONOS_UA,
    Referer: 'https://www.youtube.com/',
  };
  await engine.downloadUrl(choice.video.url, filepath, {
    headers,
    maxSize: MAX_FILE_SIZE,
    progressCallback: progressCb,
  });
  return validateDownload(filepath, { expectedExt: 'mp4' });
}

async function downloadVidey(url, { progressCb = null } = {}) {
  ensureTempDir();
  const filename = path.join(TEMP_DIR, `videy_${crypto.randomBytes(4).toString('hex')}.mp4`);

  let directUrl;
  try {
    directUrl = await resolveDirectUrl(url);
  } catch {
    directUrl = url;
  }

  try {
    const result = await downloadWithHttp(directUrl, filename, progressCb);
    if (result && fs.existsSync(result) && fs.statSync(result).size > 0) {
      return validateDownload(result, { expectedExt: 'mp4' });
    }
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }

  if (fs.existsSync(filename)) cleanupFile(filename);
  return downloadWithEngine(url, filename, progressCb);
}

module.exports = { downloadVidey, resolveDirectUrl };

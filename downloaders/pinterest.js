'use strict';

/** Pinterest downloader — resolve pin.it short links, extract media. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { TEMP_DIR, MAX_FILE_SIZE } = require('../config');
const { ensureTempDir } = require('../utils/cleanup');
const { ClientSession } = require('../utils/http');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const PINTEREST_RE =
  /https?:\/\/(www\.)?(pinterest\.(com|co\.\w+|ca|fr|de|it|es|co\.uk)|pin\.it)\//i;

function isPinterestUrl(url) {
  return PINTEREST_RE.test(String(url || '').trim());
}

async function resolveShort(url) {
  const session = new ClientSession();
  try {
    const r = await session.head(url, {
      allowRedirects: true,
      headers: { 'User-Agent': UA },
      timeout: 15,
    });
    return r.url;
  } finally {
    await session.close();
  }
}

async function downloadPinterest(url, { progressCb = null } = {}) {
  ensureTempDir();

  let target = url;
  if (target.includes('pin.it/')) {
    target = await resolveShort(target);
  }

  if (progressCb) await progressCb(10, 100);

  const headers = { 'User-Agent': UA };
  const session = new ClientSession();
  let filepath = null;
  let isVideo = false;

  try {
    const resp = await session.get(target, { headers, timeout: 30 });
    if (resp.status !== 200) {
      throw new Error(`Gagal memuat halaman Pinterest: HTTP ${resp.status}`);
    }
    const html = await resp.text();

    if (progressCb) await progressCb(30, 100);

    let videoUrl = null;
    const videoPatterns = [
      /"url":"(https:\/\/v1?\.pinimg\.com\/videos\/[^"]+\.mp4)"/,
      /"video_url":"(https?:\/\/[^"]+\.mp4[^"]*)"/,
      /<video[^>]+src="(https?:\/\/[^"]+\.mp4[^"]*)"/,
    ];
    for (const pat of videoPatterns) {
      const m = pat.exec(html);
      if (m) {
        videoUrl = m[1].replaceAll('\\u002F', '/').replaceAll('\\/', '/');
        break;
      }
    }

    let imageUrl = null;
    const imgPatterns = [
      /"url":"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/,
      /"url":"(https:\/\/i\.pinimg\.com\/736x\/[^"]+)"/,
      /<img[^>]+src="(https:\/\/i\.pinimg\.com\/[^"]+)"/,
      /"image_url":"(https?:\/\/[^"]+)"/,
    ];
    for (const pat of imgPatterns) {
      const m = pat.exec(html);
      if (m) {
        imageUrl = m[1].replaceAll('\\u002F', '/').replaceAll('\\/', '/');
        break;
      }
    }

    const mediaUrl = videoUrl || imageUrl;
    if (!mediaUrl) {
      throw new Error('Media tidak ditemukan di halaman Pinterest');
    }

    isVideo = videoUrl != null;
    const ext = isVideo ? '.mp4' : '.jpg';
    filepath = path.join(TEMP_DIR, `pin_${crypto.randomBytes(4).toString('hex')}${ext}`);

    if (progressCb) await progressCb(50, 100);

    const media = await session.get(mediaUrl, { headers, timeout: 120 });
    if (media.status !== 200) {
      throw new Error(`Gagal download media: HTTP ${media.status}`);
    }
    const total = Number(media.headers.get('content-length') || 0);
    if (total > MAX_FILE_SIZE) {
      throw new Error(`File terlalu besar: ${(total / (1024 * 1024)).toFixed(1)}MB`);
    }

    const out = fs.createWriteStream(filepath);
    let downloaded = 0;
    try {
      for await (const chunk of media.iterChunked(512 * 1024)) {
        out.write(chunk);
        downloaded += chunk.length;
        if (progressCb && total) {
          await progressCb(50 + Math.floor((downloaded / total) * 45), 100);
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  } finally {
    await session.close();
  }

  return { filepath, isVideo };
}

module.exports = { isPinterestUrl, downloadPinterest };

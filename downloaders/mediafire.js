'use strict';

/** MediaFire downloader — scrape direct download link from page. */

const fs = require('node:fs');
const path = require('node:path');

const { TEMP_DIR, MAX_FILE_SIZE } = require('../config');
const { ensureTempDir } = require('../utils/cleanup');
const { ClientSession } = require('../utils/http');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const MEDIAFIRE_RE = /https?:\/\/(www\.)?mediafire\.com\/file\//i;

function isMediafireUrl(url) {
  return MEDIAFIRE_RE.test(String(url || '').trim());
}

async function downloadMediafire(url, { progressCb = null } = {}) {
  ensureTempDir();

  const headers = { 'User-Agent': UA };
  const session = new ClientSession();

  try {
    if (progressCb) await progressCb(5, 100);

    const resp = await session.get(url, { headers, timeout: 30 });
    if (resp.status !== 200) {
      throw new Error(`Gagal memuat halaman MediaFire: HTTP ${resp.status}`);
    }
    const html = await resp.text();

    if (html.includes('This file has been removed') || html.includes('Invalid or Deleted File')) {
      throw new Error('File telah dihapus atau tidak valid');
    }

    let directUrl = null;
    let m = /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/.exec(html);
    if (m) {
      directUrl = m[1];
    } else {
      m = /aria-label="Download file"\s*href="(https?:\/\/[^"]+)"/.exec(html);
      if (m) {
        directUrl = m[1];
      } else {
        m = /id="downloadButton"[^>]*href="(https?:\/\/[^"]+)"/.exec(html);
        if (m) directUrl = m[1];
      }
    }

    if (!directUrl) {
      throw new Error('Direct download URL tidak ditemukan');
    }

    let originalName = null;
    const filenameMatch = /<div class="filename">([^<]+)<\/div>/.exec(html);
    if (filenameMatch) originalName = filenameMatch[1].trim();
    if (!originalName) {
      const parts = url.replace(/\/+$/, '').split('/');
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        if (p.includes('.') && p !== 'file') {
          originalName = decodeURIComponent(p.replaceAll('+', ' '));
          break;
        }
      }
    }
    if (!originalName) originalName = 'mediafire_download';

    if (progressCb) await progressCb(15, 100);

    const filepath = path.join(TEMP_DIR, originalName);

    const dl = await session.get(directUrl, { headers, allowRedirects: true, timeout: 600 });
    if (dl.status !== 200) {
      throw new Error(`Download gagal: HTTP ${dl.status}`);
    }

    const total = Number(dl.headers.get('content-length') || 0);
    if (total > MAX_FILE_SIZE) {
      throw new Error(
        `File terlalu besar: ${(total / (1024 * 1024)).toFixed(1)}MB (maks Telegram: ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB)`,
      );
    }

    const out = fs.createWriteStream(filepath);
    let downloaded = 0;
    try {
      for await (const chunk of dl.iterChunked(1024 * 1024)) {
        out.write(chunk);
        downloaded += chunk.length;
        if (progressCb && total) {
          await progressCb(15 + Math.floor((downloaded / total) * 80), 100);
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }

    if (!fs.existsSync(filepath) || fs.statSync(filepath).size === 0) {
      throw new Error('File hasil download kosong atau tidak ditemukan');
    }

    return { filepath, filename: originalName, size: fs.statSync(filepath).size };
  } finally {
    await session.close();
  }
}

module.exports = { isMediafireUrl, downloadMediafire };

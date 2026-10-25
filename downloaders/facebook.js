"use strict";

/**
 * Facebook downloader — scrape langsung dari halaman Facebook.
 * Tanpa fdownloader.net API.
 */

const fs = require("node:fs");
const path = require("node:path");

const { TEMP_DIR, MAX_FILE_SIZE } = require("../config");
const { sanitizeFilename } = require("../utils/helpers");
const { ensureTempDir } = require("../utils/cleanup");
const { ClientSession, ClientError, TimeoutError } = require("../utils/http");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const FB_RE =
  /https?:\/\/(www\.)?(facebook\.com|fb\.watch|fb\.com|m\.facebook\.com|fb\.gg)\/\S+/i;

function isFacebookUrl(text) {
  return FB_RE.test(String(text || "").trim());
}

function extractFbUrl(text) {
  const m = FB_RE.exec(String(text || ""));
  return m ? m[0] : null;
}

/**
 * Scrape Facebook video page for download URL.
 */
async function scrapeFacebookPage(url) {
  const headers = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://www.facebook.com/",
  };

  const session = new ClientSession({ headers, timeout: 30 });
  let html;
  try {
    const resp = await session.get(url, { allowRedirects: true });
    if (resp.status !== 200) {
      throw new Error(`Gagal memuat halaman Facebook: HTTP ${resp.status}`);
    }
    html = await resp.text();
  } finally {
    await session.close();
  }

  // Try __NEXT_DATA__ / JSON blob first.
  const jsonPatterns = [
    /"sd_src"\s*:\s*"([^"]+)/i,
    /"hd_src"\s*:\s*"([^"]+)/i,
    /"download_url"\s*:\s*"([^"]+)/i,
    /"playable_url"\s*:\s*"([^"]+)/i,
    /"sd_url"\s*:\s*"([^"]+)/i,
    /"hd_url"\s*:\s*"([^"]+)/i,
    /"video_data"\s*:\s*(\{[^}]*"url"\s*:\s*"[^"]+)/i,
  ];
  for (const pat of jsonPatterns) {
    const m = pat.exec(html);
    if (m) {
      let videoUrl = m[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
      // If it's a JSON object, try to extract the url field.
      try {
        const obj = JSON.parse("{" + m[1] + "}");
        if (obj.url) videoUrl = obj.url;
      } catch {
        /* use raw match */
      }
      if (videoUrl && videoUrl.startsWith("http")) {
        return { video: videoUrl, title: "Facebook Video" };
      }
    }
  }

  // Regex for download links.
  const downloadPatterns = [
    /<a[^>]*href="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*>/i,
    /"content_url"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
    /"src"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
    /source\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
  ];
  for (const pat of downloadPatterns) {
    const m = pat.exec(html);
    if (m) {
      return { video: m[1].replace(/\\u002F/g, "/").replace(/\\/g, ""), title: "Facebook Video" };
    }
  }

  throw new Error("Tidak ditemukan link download Facebook");
}

async function getFacebook(url) {
  return scrapeFacebookPage(url);
}

async function fbDownload(url, { progressCb = null } = {}) {
  ensureTempDir();

  const info = await getFacebook(url);
  const videoUrl = info.video;
  const title = info.title || "Facebook Video";

  const safeTitle = sanitizeFilename(title) || "fb_video";
  const filepath = path.join(TEMP_DIR, `${safeTitle}_${process.pid}.mp4`);

  const session = new ClientSession();
  try {
    const resp = await session.get(videoUrl, {
      headers: { "User-Agent": UA },
      timeout: 300,
      allowRedirects: true,
    });
    if (resp.status !== 200) {
      throw new Error(`Download gagal: HTTP ${resp.status}`);
    }

    const total = Number(resp.headers.get("content-length")) || 0;
    if (total > MAX_FILE_SIZE) {
      throw new Error(
        `File terlalu besar (${Math.floor(total / (1024 * 1024))}MB), batas ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB`,
      );
    }

    const out = fs.createWriteStream(filepath);
    let downloaded = 0;
    try {
      for await (const chunk of resp.iterChunked(64 * 1024)) {
        out.write(chunk);
        downloaded += chunk.length;
        if (progressCb && total > 0) await progressCb(downloaded, total);
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  } finally {
    await session.close();
  }

  return { filepath, title };
}

module.exports = { isFacebookUrl, extractFbUrl, getFacebook, fbDownload };

"use strict";

/**
 * TikTok downloader — video & photo slide.
 *
 * Scrape langsung dari halaman TikTok public, tanpa tikwm API.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { TEMP_DIR, MAX_FILE_SIZE } = require("../config");
const { cleanupFile, ensureTempDir } = require("../utils/cleanup");
const { ClientSession, ClientError, TimeoutError, delay } = require("../utils/http");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const TIKTOK_RE = /https?:\/\/(www\.|vm\.|vt\.)?(tiktok\.com)\//i;
const SHORT_TIKTOK_HOSTS = new Set(["vt.tiktok.com", "vm.tiktok.com"]);
const RESOLVE_TIMEOUT = 12;
const RESOLVE_RETRIES = 3;

class TikTokResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = "TikTokResolveError";
  }
}

function normalizeTikTokUrl(url) {
  return String(url).replaceAll("/photo/", "/video/");
}

function isTikTokUrl(url) {
  return TIKTOK_RE.test(String(url || "").trim());
}

function isShortTikTokUrl(url) {
  try {
    return SHORT_TIKTOK_HOSTS.has(new URL(String(url).trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolvedTikTokUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set(["tiktok.com", "www.tiktok.com", ...SHORT_TIKTOK_HOSTS]);
  if (!allowed.has(host)) return null;
  if (SHORT_TIKTOK_HOSTS.has(host)) return null;
  return url;
}

async function resolveUrl(url) {
  const original = String(url).trim();
  if (!isTikTokUrl(original)) throw new TikTokResolveError("URL TikTok tidak valid");
  if (!isShortTikTokUrl(original)) return original;

  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
    Referer: "https://www.tiktok.com/",
  };
  let lastError = null;

  const session = new ClientSession({ headers, timeout: RESOLVE_TIMEOUT });
  try {
    for (let attempt = 0; attempt < RESOLVE_RETRIES; attempt += 1) {
      for (const method of ["HEAD", "GET"]) {
        try {
          const requestHeaders = method === "GET" ? { Range: "bytes=0-0" } : undefined;
          const response = await session.request(method, original, {
            headers: requestHeaders,
            allowRedirects: true,
          }).__aenter__();
          const resolved = resolvedTikTokUrl(response.url);
          if (resolved && response.status < 500) return resolved;
          lastError = new Error(`HTTP ${response.status}`);
        } catch (err) {
          lastError = err;
        }
      }
      if (attempt + 1 < RESOLVE_RETRIES) await delay(750 * (attempt + 1));
    }
  } finally {
    await session.close();
  }

  throw new TikTokResolveError("Gagal mengakses link TikTok");
}

/**
 * Extract TikTok video/photo data from the public web page.
 * Looks for __NEXT_DATA__ JSON blob and CDN URLs.
 */
async function scrapeTikTokPage(url) {
  const session = new ClientSession({ headers: { "User-Agent": UA }, timeout: 30 });
  let html;
  try {
    const resp = await session.get(url, { allowRedirects: true });
    if (resp.status !== 200) {
      throw new Error(`Gagal memuat halaman TikTok: HTTP ${resp.status}`);
    }
    html = await resp.text();
  } finally {
    await session.close();
  }

  // Try __NEXT_DATA__ first (most reliable).
  const nextDataMatch = /<script\s+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const item = nextData?.props?.pageProps?.itemInfo?.itemStruct || {};
      const author = item.author || {};
      const video = item.video || {};
      const images = item.images || [];

      if (images.length) {
        return {
          type: "photo",
          uploader: author.uniqueId || "",
          uploader_id: author.id || "",
          description: item.desc || "",
          duration: video.duration || 0,
          images: images.map((img) => img.imageURL || img.url || "").filter(Boolean),
        };
      }

      const playAddr = video.playAddr || video.downloadAddr || "";
      if (playAddr) {
        return {
          type: "video",
          uploader: author.uniqueId || "",
          uploader_id: author.id || "",
          description: item.desc || "",
          duration: video.duration || 0,
          play: playAddr,
          cover: video.cover || "",
          music: video.music || { cover: "", title: "" },
        };
      }
    } catch {
      /* fallback to regex below */
    }
  }

  // Fallback: regex extraction from HTML.
  const result = { type: "unknown", uploader: "", uploader_id: "", description: "", duration: 0 };

  const descMatch = /"desc"\s*:\s*"([^"]*)"/.exec(html);
  if (descMatch) result.description = descMatch[1];

  const authorMatch = /"uniqueId"\s*:\s*"([^"]*)"/.exec(html);
  if (authorMatch) result.uploader = authorMatch[1];

  const musicMatch = /"music"\s*:\s*\{[^}]*"title"\s*:\s*"([^"]*)"/.exec(html);
  if (musicMatch) result.musicTitle = musicMatch[1];

  // Video URL patterns
  const videoPatterns = [
    /"playAddr"\s*:\s*"([^"]+)/,
    /"downloadAddr"\s*:\s*"([^"]+)/,
    /"videoUrl"\s*:\s*"([^"]+)/,
    /src:"(https:\/\/v1?\.tiktokcdn\.com\/[^"]+\.mp4)"/,
    /https:\/\/v16m\.tiktokcdn\.com\/[^"\s]+\.mp4/,
  ];
  for (const pat of videoPatterns) {
    const m = pat.exec(html);
    if (m) {
      result.play = m[1].replace(/\\u002F/g, "/").replace(/\\/, "");
      result.type = "video";
      break;
    }
  }

  // Image URL patterns
  const imagePatterns = [
    /"imageURL"\s*:\s*"([^"]+)/,
    /"url"\s*:\s*"(https:\/\/p16-sign[^"]+\.(?:jpg|png|webp))"/,
    /"previewImageURL"\s*:\s*"([^"]+)/,
  ];
  const images = [];
  for (const pat of imagePatterns) {
    let match;
    while ((match = pat.exec(html)) !== null) {
      const imgUrl = match[1].replace(/\\u002F/g, "/").replace(/\\/, "");
      if (!images.includes(imgUrl)) images.push(imgUrl);
    }
  }
  if (images.length) {
    result.images = images;
    result.type = "photo";
  }

  return result;
}

async function downloadFile(url, filepath, { headers = {}, progressCb = null } = {}) {
  const session = new ClientSession();
  try {
    const resp = await session.get(url, { headers, timeout: 120 });
    if (resp.status !== 200) throw new Error(`Download gagal: HTTP ${resp.status}`);
    const total = Number(resp.headers.get("content-length")) || 0;
    if (total > MAX_FILE_SIZE) throw new Error("File TikTok terlalu besar");

    const out = fs.createWriteStream(filepath);
    let downloaded = 0;
    try {
      for await (const chunk of resp.iterChunked(256 * 1024)) {
        downloaded += chunk.length;
        if (downloaded > MAX_FILE_SIZE) throw new Error("File TikTok terlalu besar");
        out.write(chunk);
        if (progressCb && total) await progressCb(downloaded, total);
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (total && downloaded !== total) {
      throw new Error("Response download TikTok tidak lengkap");
    }
  } finally {
    await session.close();
  }
}

async function downloadTiktokVideo(url, { progressCb = null } = {}) {
  ensureTempDir();

  let target = url;
  if (target.includes("vt.tiktok") || target.includes("vm.tiktok")) {
    target = await resolveUrl(target);
  }

  if (progressCb) await progressCb(10, 100);
  const info = await scrapeTikTokPage(target);
  if (progressCb) await progressCb(30, 100);

  if (info.type === "photo") {
    return { type: "photo", info };
  }

  if (!info.play) {
    throw new Error("Tidak dapat menemukan URL video TikTok");
  }

  const creator = info.uploader || "Unknown";
  const caption = info.description || "";
  const duration = info.duration || 0;

  const filename = path.join(TEMP_DIR, `tt_${crypto.randomBytes(4).toString("hex")}.mp4`);

  try {
    await downloadFile(info.play, filename, {
      headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" },
      progressCb: progressCb
        ? async (c, t) => progressCb(30 + Math.floor((c / t) * 55), 100)
        : null,
    });
  } catch (err) {
    cleanupFile(filename);
    throw err;
  }

  if (progressCb) await progressCb(85, 100);

  return {
    type: "video",
    filepath: filename,
    creator,
    caption,
    duration: Number(duration) ? parseInt(duration, 10) : 0,
  };
}

async function downloadTiktokPhotos(url, { progressCb = null } = {}) {
  ensureTempDir();

  let target = url;
  if (isShortTikTokUrl(target)) {
    target = await resolveUrl(target);
  }

  if (progressCb) await progressCb(10, 100);
  const info = await scrapeTikTokPage(target);
  if (progressCb) await progressCb(30, 100);

  const imageUrls = Array.isArray(info.images) ? info.images.slice() : [];
  if (!imageUrls.length) {
    // Do not pretend this was a video: `unknown` means TikTok returned no
    // usable payload (login wall / changed markup), which is a real failure.
    if (info.type === "video" || info.play) return { type: "video", play: info.play || "" };
    throw new TikTokResolveError(
      "TikTok tidak mengembalikan data foto. Halaman mungkin memerlukan login atau markup berubah.",
    );
  }

  const creator = info.uploader || "Unknown";
  const caption = info.description || "";

  const filepaths = [];
  const headers = { "User-Agent": UA, Referer: "https://www.tiktok.com/" };
  const session = new ClientSession({ timeout: 30 });

  try {
    for (let i = 0; i < imageUrls.length; i += 1) {
      const imgUrl = imageUrls[i];
      let ext = ".jpg";
      if (imgUrl.includes(".png")) ext = ".png";
      else if (imgUrl.includes(".webp")) ext = ".webp";

      const fp = path.join(TEMP_DIR, `ttpic_${crypto.randomBytes(3).toString("hex")}_${i}${ext}`);
      try {
        const resp = await session.get(imgUrl, { headers, timeout: 30 });
        if (resp.status === 200) {
          fs.writeFileSync(fp, await resp.read());
          filepaths.push(fp);
        }
      } catch {
        /* skip individual failures */
      }
      if (progressCb) {
        await progressCb(30 + Math.floor(((i + 1) / imageUrls.length) * 60), 100);
      }
    }
  } finally {
    await session.close();
  }

  if (!filepaths.length) {
    throw new Error("Tidak ada foto yang berhasil didownload");
  }

  return { type: "photo", filepaths, creator, caption };
}

module.exports = {
  TikTokResolveError,
  isTikTokUrl,
  normalizeTikTokUrl,
  downloadTiktokVideo,
  downloadTiktokPhotos,
  scrapeTikTokPage,
};

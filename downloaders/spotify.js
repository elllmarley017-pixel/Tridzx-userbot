"use strict";

/**
 * Spotify downloader — audio via YouTube engine.
 *
 * Tidak menggunakan Spotify API, REST API pihak ketiga, atau API key.
 * Mengambil metadata dari halaman Spotify public,
 * lalu mencari audio di YouTube dengan fallback bertingkat.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { TEMP_DIR } = require("../config");
const { sanitizeFilename } = require("../utils/helpers");
const { ensureTempDir } = require("../utils/cleanup");
const youtubeEngine = require("./youtube_engine");
const { DownloadError, downloadUrl, convertToMp3, validateDownload } = require("./engine");

const { ClientSession } = require("../utils/http");

const SPOTIFY_TRACK_RE = /https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
const SPOTIFY_PAGE_TIMEOUT = 15;

/**
 * Scrape Spotify track page for metadata.
 * Looks for meta tags and JSON-LD data.
 */
async function scrapeSpotifyMetadata(trackId) {
  const url = `https://open.spotify.com/track/${trackId}`;
  const session = new ClientSession({ timeout: SPOTIFY_PAGE_TIMEOUT });
  let html;
  try {
    const resp = await session.get(url, { allowRedirects: true });
    if (resp.status !== 200) {
      throw new Error(`Spotify halaman tidak dapat diakses: HTTP ${resp.status}`);
    }
    html = await resp.text();
  } finally {
    await session.close();
  }

  // Try JSON-LD first.
  const jsonLdMatch = /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/s.exec(html);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      const name = jsonLd.name || jsonLd.title || "";
      const artist = Array.isArray(jsonLd.byArtist)
        ? jsonLd.byArtist.map((a) => a.name).join(", ")
        : jsonLd.byArtist?.name || "";
      const duration = jsonLd.duration ? Math.round(jsonLd.duration / 1000) : 0;
      if (name) return { title: name, artist, duration, album: jsonLd.album?.name || "" };
    } catch {
      /* fallback to meta tags */
    }
  }

  // Try meta tags.
  const meta = (property) => {
    const m = new RegExp(`<meta\\s+property="og:${property}"\\s+content="([^"]*)"`).exec(html);
    return m ? m[1] : "";
  };

  const title = meta("title");
  const description = meta("description");

  // Extract artist from description or title.
  let artist = "";
  if (description) {
    const artistMatch = /by\s+([^·|]+)/i.exec(description);
    if (artistMatch) artist = artistMatch[1].trim();
  }
  if (!artist && title) {
    const dashMatch = /^\s*([^–\-]+)\s*[-–]\s*(.+)$/.exec(title);
    if (dashMatch) artist = dashMatch[1].trim();
  }

  // Extract duration from HTML.
  let duration = 0;
  const durationMatch = /"duration_ms":\s*(\d+)/.exec(html);
  if (durationMatch) duration = Math.round(Number(durationMatch[1]) / 1000);

  return {
    title: title || `Spotify ${trackId}`,
    artist,
    duration,
    album: "",
  };
}

function extractTrackId(url) {
  const cleaned = String(url).split("?")[0];
  const m = SPOTIFY_TRACK_RE.exec(cleaned.trim());
  if (!m) throw new Error("Bukan URL Spotify track yang valid");
  return m[1];
}

/**
 * Search YouTube with fallback queries.
 * Returns the best match based on title similarity and duration.
 */
async function searchWithFallback(title, artist, duration, options = {}) {
  const queries = [];

  // Primary: "Title - Artist"
  if (title && artist) queries.push(`${title} - ${artist}`);
  // Fallback 1: "Artist - Title"
  if (artist && title) queries.push(`${artist} - ${title}`);
  // Fallback 2: Title only
  if (title) queries.push(title);
  // Fallback 3: Artist only
  if (artist) queries.push(artist);
  // Fallback 4: Title + "official audio"
  if (title) queries.push(`${title} official audio`);
  // Fallback 5: Title + "lyrics"
  if (title) queries.push(`${title} lyrics`);

  const limit = options.limit ?? 5;

  let allResults = [];
  let lastError = null;
  // Stop at the first query that yields results. Running every fallback query
  // took ~5 x 12s and made `.spotify` hang until the client gave up.
  for (const query of queries) {
    try {
      const results = await youtubeEngine.search(query, { limit });
      if (results.length) {
        allResults = results;
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!allResults.length) {
    if (lastError) throw lastError;
    throw new Error("Audio tidak ditemukan setelah seluruh metode pencarian internal dicoba");
  }

  // Score results by duration similarity and title relevance.
  const scored = allResults.map((r) => {
    let score = 0;
    if (duration && r.duration) {
      const videoDuration = parseDuration(r.duration);
      if (videoDuration > 0) {
        const diff = Math.abs(videoDuration - duration);
        score += Math.max(0, 100 - diff * 10);
      }
    }
    // Boost if title keywords match.
    const titleWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const matchCount = titleWords.filter((w) => r.title.toLowerCase().includes(w)).length;
    score += matchCount * 20;
    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const parts = String(durationStr).split(":");
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  }
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  return 0;
}

/**
 * Download Spotify track via YouTube search + MP3 conversion.
 */
async function downloadSpotify(url, { progressCb = null, statusCb = null } = {}) {
  ensureTempDir();

  const trackId = extractTrackId(url);
  if (progressCb) await progressCb(5, 100);

  // 1. Scrape metadata from Spotify page.
  let metadata;
  try {
    metadata = await scrapeSpotifyMetadata(trackId);
  } catch (err) {
    throw new DownloadError("EXTRACTION", `Gagal mengambil metadata Spotify: ${err.message}`);
  }
  if (progressCb) await progressCb(15, 100);

  const { title, artist, duration } = metadata;

  // 2. Search YouTube with fallback queries.
  let video;
  try {
    video = await searchWithFallback(title, artist, duration, { limit: 5 });
  } catch (err) {
    throw new DownloadError("EXTRACTION", err.message);
  }
  if (progressCb) await progressCb(30, 100);

  if (statusCb) await statusCb("DOWNLOAD", 1, 1, `Mengunduh ${video.title}`);

  const safeName = sanitizeFilename(`spotify_${trackId}`) || `spotify_${trackId}`;
  const prefix = path.join(TEMP_DIR, `${safeName}_${crypto.randomBytes(4).toString("hex")}`);

  const rawPart = `${prefix}.raw.webm`;
  const target = `${prefix}.mp3`;

  try {
    // 3. Extract video info and choose audio format.
    const info = await youtubeEngine.extractInfo(video.url, { timeout: 60_000 });
    const choice = youtubeEngine.chooseFormats(info.formats, "audio", {});

    // 4. Download audio.
    await downloadUrl(choice.audio.url, rawPart, {
      headers: {
        "User-Agent": youtubeEngine.VISIONOS_UA,
        Referer: "https://www.youtube.com/",
      },
      progressCallback: progressCb
        ? async (cur, total) => progressCb(35 + Math.floor((cur / total) * 40), 100)
        : null,
    });

    // 5. Convert to MP3.
    await convertToMp3(rawPart, target, { bitrate: "192k" });
  } finally {
    for (const f of [rawPart]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  const filepath = validateDownload(target, { expectedExt: "mp3" });

  // 6. Write ID3 tags.
  try {
    const NodeID3 = require("node-id3");
    const tags = {
      title: title || video.title || `Spotify ${trackId}`,
      artist: artist || "Spotify",
    };
    if (metadata.album) tags.album = metadata.album;
    if (duration) tags.sec = String(duration);
    NodeID3.write(tags, filepath);
  } catch {
    /* tagging is best-effort */
  }

  if (progressCb) await progressCb(95, 100);

  return {
    filepath,
    title: title || video.title || `Spotify ${trackId}`,
    artist: artist || "Tidak diketahui",
    album: metadata.album || "",
    duration: duration || 0,
    thumbnail: "",
  };
}

module.exports = { extractTrackId, downloadSpotify, scrapeSpotifyMetadata, searchWithFallback };

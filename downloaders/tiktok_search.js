"use strict";

/**
 * TikTok search — scraping langsung dari halaman pencarian TikTok.
 * Tanpa tikwm API.
 */

const { ClientSession, ClientError, TimeoutError } = require("../utils/http");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const TIMEOUT = 45;
const HEADERS = {
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "User-Agent": UA,
};

class TikTokSearchError extends Error {
  constructor(message) {
    super(message);
    this.name = "TikTokSearchError";
  }
}

/**
 * Extract TikTok video data from a page HTML.
 */
function extractVideoFromHtml(html) {
  const results = [];
  const seen = new Set();

  // Try __NEXT_DATA__ first.
  const nextDataMatch = /<script\s+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const items =
        nextData?.props?.pageProps?.itemList ||
        nextData?.props?.pageProps?.search?.itemList ||
        [];
      for (const item of items) {
        const video = item.video || {};
        const author = item.author || {};
        const videoId = item.id || video.id || "";
        if (!videoId) continue;
        const url = `https://www.tiktok.com/@${author.uniqueId || author.username || "unknown"}/video/${videoId}`;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({
          caption: item.desc || item.text || "Tanpa caption",
          username: author.uniqueId || author.username || "Tidak diketahui",
          url,
          thumbnail: video.cover || video.coverURL || "",
          views: item.stats?.playCount || video.playCount || 0,
          likes: item.stats?.diggCount || video.diggCount || 0,
          comments: item.stats?.commentCount || video.commentCount || 0,
        });
      }
    } catch {
      /* fallback to regex */
    }
  }

  if (!results.length) {
    // Regex fallback.
    const pattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let redirectUrl = decodeHtml(match[1]);
      if (redirectUrl.startsWith("//")) redirectUrl = `https:${redirectUrl}`;

      let target = redirectUrl;
      try {
        const params = new URL(redirectUrl).searchParams;
        if (params.get("uddg")) target = decodeURIComponent(params.get("uddg"));
      } catch {
        /* keep redirectUrl */
      }

      if (!target.includes("tiktok.com/@") || !target.includes("/video/")) continue;
      target = target.split("?")[0];
      if (seen.has(target)) continue;
      seen.add(target);

      const m = /tiktok\.com\/@([^/]+)\/video\/(\d+)/.exec(target);
      const username = m ? m[1] : "Tidak diketahui";
      let title = stripTags(decodeHtml(match[2])).trim();
      results.push({
        caption: title && title !== "TikTok - Make Your Day" ? title : "",
        username,
        url: target,
        thumbnail: null,
        views: null,
        likes: null,
        comments: null,
      });
    }
  }

  return results;
}

/**
 * Search TikTok users/accounts by scraping the search page.
 */
async function searchAccounts(query, limit = 5) {
  const searchUrl = `https://www.tiktok.com/search/user?q=${encodeURIComponent(query)}`;
  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  let html;
  try {
    const resp = await session.get(searchUrl, { timeout: TIMEOUT });
    if (resp.status === 429) {
      throw new TikTokSearchError("Rate limit TikTok search tercapai; coba lagi nanti");
    }
    if (resp.status >= 400) {
      throw new TikTokSearchError(`Pencarian TikTok gagal: HTTP ${resp.status}`);
    }
    html = await resp.text();
  } catch (err) {
    if (err instanceof TikTokSearchError) throw err;
    if (err instanceof TimeoutError) throw new TikTokSearchError("TikTok search timeout");
    if (err instanceof ClientError) throw new TikTokSearchError("Koneksi pencarian TikTok gagal");
    throw err;
  } finally {
    await session.close();
  }

  const results = [];
  const seen = new Set();

  // Try __NEXT_DATA__ first.
  const nextDataMatch = /<script\s+id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(html);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const items = nextData?.props?.pageProps?.itemList || [];
      for (const item of items) {
        const user = item.author || item.user || {};
        const username = user.uniqueId || user.username || "";
        if (!username || seen.has(username)) continue;
        seen.add(username);
        results.push({
          username,
          name: user.nickname || username,
          url: `https://www.tiktok.com/@${username}`,
          avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || "",
          followers: user.followerCount || 0,
          following: user.followingCount || 0,
          posts: user.videoCount || 0,
          bio: user.signature || "N/A",
          private: user.privateAccount || false,
          verified: Boolean(user.verified),
        });
      }
    } catch {
      /* fallback to regex */
    }
  }

  // Regex fallback for user search.
  if (!results.length) {
    const userPattern = /href="(\/@[^/]+)"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = userPattern.exec(html)) !== null) {
      const username = match[1].replace(/^\/@/, "");
      if (!username || seen.has(username)) continue;
      seen.add(username);
      results.push({
        username,
        name: stripTags(decodeHtml(match[2])).trim() || username,
        url: `https://www.tiktok.com/@${username}`,
        avatar: "",
        followers: 0,
        following: 0,
        posts: 0,
        bio: "N/A",
        private: false,
        verified: false,
      });
    }
  }

  return results.slice(0, limit);
}

async function searchVideos(query, limit = 5) {
  const searchUrl = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  let html;
  try {
    const resp = await session.get(searchUrl, { timeout: TIMEOUT });
    if (resp.status === 429) {
      throw new TikTokSearchError("Rate limit TikTok search tercapai; coba lagi nanti");
    }
    if (resp.status >= 400) {
      throw new TikTokSearchError(`Pencarian video TikTok gagal: HTTP ${resp.status}`);
    }
    html = await resp.text();
  } catch (err) {
    if (err instanceof TikTokSearchError) throw err;
    if (err instanceof TimeoutError) throw new TikTokSearchError("Pencarian video TikTok timeout");
    if (err instanceof ClientError) throw new TikTokSearchError("Koneksi pencarian video TikTok gagal");
    throw err;
  } finally {
    await session.close();
  }

  const results = extractVideoFromHtml(html);
  return results.slice(0, limit);
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'");
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, "");
}

module.exports = {
  TikTokSearchError,
  searchAccounts,
  searchVideos,
};

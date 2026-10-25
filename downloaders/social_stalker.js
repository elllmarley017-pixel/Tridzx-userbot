"use strict";

/**
 * Social profile stalker — scraping langsung dari halaman publik.
 *
 * Tidak menggunakan GitHub API, Roblox API, atau API pihak ketiga.
 * Semua data diambil dari halaman web publik platform.
 */

const { ClientSession, ClientError, TimeoutError, delay } = require("../utils/http");
const { searchAccounts } = require("./tiktok_search");

const TIMEOUT = 18;
const HEADERS = {
  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
};
const CACHE_TTL = 300;
const RETRIES = 2;
const cache = new Map();

class StalkerError extends Error {
  constructor(message) {
    super(message);
    this.name = "StalkerError";
  }
}

class ProfileNotFound extends StalkerError {
  constructor(message) {
    super(message);
    this.name = "ProfileNotFound";
  }
}

function makeProfile(platform, username, fields = {}) {
  return {
    platform,
    username,
    name: "N/A",
    avatar: "N/A",
    followers: null,
    following: null,
    bio: "N/A",
    private: null,
    posts: null,
    url: "N/A",
    email: null,
    repositories: null,
    extras: {},
    ...fields,
  };
}

function normalizeUsername(value) {
  const username = String(value).trim().replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(username)) {
    throw new StalkerError(
      "Username tidak valid; gunakan huruf, angka, titik, underscore, atau tanda minus",
    );
  }
  return username;
}

function cached(key) {
  const item = cache.get(key);
  if (item && Date.now() / 1000 - item[0] < CACHE_TTL) return item[1];
  cache.delete(key);
  return null;
}

function store(key, value) {
  cache.set(key, [Date.now() / 1000, value]);
  return value;
}

async function requestJson(session, method, url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await session.request(method, url, options).__aenter__();
      if (response.status === 404) throw new ProfileNotFound("Akun tidak ditemukan");
      if (response.status === 429) throw new StalkerError("Rate limit platform tercapai");
      if (response.status === 401 || response.status === 403) {
        throw new StalkerError("Platform menolak akses publik saat ini");
      }
      if (response.status >= 400) {
        throw new StalkerError(`Platform mengembalikan HTTP ${response.status}`);
      }
      const data = await response.json();
      if (typeof data !== "object" || data == null || Array.isArray(data)) {
        throw new StalkerError("Response platform tidak valid");
      }
      return data;
    } catch (err) {
      if (err instanceof ProfileNotFound) throw err;
      lastError = err;
      if (err instanceof StalkerError && String(err.message).includes("Rate limit")) throw err;
      if (attempt + 1 < RETRIES) await delay(600);
    }
  }
  throw new StalkerError(lastError ? String(lastError.message) : "Request platform gagal");
}

/* ------------------------------------------------------------------ *
 * Native scrapers (public page scraping, no API)  *
 * ------------------------------------------------------------------ */

async function githubProfile(username) {
  username = normalizeUsername(username);
  const key = `github:${username.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  let html;
  try {
    const resp = await session.get(`https://github.com/${username}`, { allowRedirects: true });
    if (resp.status === 404) throw new ProfileNotFound("Akun GitHub tidak ditemukan");
    if (resp.status >= 400) throw new StalkerError(`GitHub mengembalikan HTTP ${resp.status}`);
    html = await resp.text();
  } finally {
    await session.close();
  }

  // Extract profile info from GitHub page HTML.
  const nameMatch = /<meta\s+property="og:title"\s+content="([^"]*)"/.exec(html);
  const imageMatch = /<meta\s+property="og:image"\s+content="([^"]*)"/.exec(html);
  const descMatch = /<meta\s+property="og:description"\s+content="([^"]*)"/.exec(html);

  const name = nameMatch ? nameMatch[1].replace(/\s*—\s*@.+/, "").trim() : username;
  const avatar = imageMatch ? imageMatch[1] : "N/A";
  const bio = descMatch ? descMatch[1] : "N/A";

  // Extract follower/following counts.
  const followerMatch = /<a[^>]*href=["']\/[^"']*\/followers["'][^>]*>[\s\S]*?<span[^>]*class="[^"]*Counter[^"]*"[^>]*>([\d,]+)/.exec(html);
  const followingMatch = /<a[^>]*href=["']\/[^"']*\/following["'][^>]*>[\s\S]*?<span[^>]*class="[^"]*Counter[^"]*"[^>]*>([\d,]+)/.exec(html);
  const repoMatch = /<a[^>]*href=["']\/[^"']*\/repositories["'][^>]*>[\s\S]*?<span[^>]*class="[^"]*Counter[^"]*"[^>]*>([\d,]+)/.exec(html);

  return store(
    key,
    makeProfile("GitHub", username, {
      name,
      avatar,
      bio,
      followers: followerMatch ? parseInt(followerMatch[1].replace(/,/g, ""), 10) : null,
      following: followingMatch ? parseInt(followingMatch[1].replace(/,/g, ""), 10) : null,
      repositories: repoMatch ? parseInt(repoMatch[1].replace(/,/g, ""), 10) : null,
      url: `https://github.com/${username}`,
    }),
  );
}

async function robloxProfile(username) {
  username = normalizeUsername(username);
  const key = `roblox:${username.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  try {
    const resp = await session.get(
      `https://www.roblox.com/users/profile?username=${encodeURIComponent(username)}`,
      { allowRedirects: true },
    );
    if (resp.status === 404) throw new ProfileNotFound("Akun Roblox tidak ditemukan");
    if (resp.status >= 400) throw new StalkerError(`Roblox mengembalikan HTTP ${resp.status}`);
    const html = await resp.text();

    const nameMatch = /<title>([^<]+)<\/title>/.exec(html);
    const displayName = nameMatch ? nameMatch[1].replace(/\s*\|\s*Roblox/, "").trim() : username;

    const imageMatch = /<meta\s+property="og:image"\s+content="([^"]*)"/.exec(html);
    const avatar = imageMatch ? imageMatch[1] : "N/A";

    const descMatch = /<meta\s+property="og:description"\s+content="([^"]*)"/.exec(html);
    const bio = descMatch ? descMatch[1] : "N/A";

    return store(
      key,
      makeProfile("Roblox", username, {
        name: displayName,
        avatar,
        bio,
        url: `https://www.roblox.com/users/profile?username=${username}`,
      }),
    );
  } finally {
    await session.close();
  }
}

async function tiktokProfile(username) {
  username = normalizeUsername(username);
  const key = `tiktok:${username.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  const results = await searchAccounts(username, 10);
  const item = results.find((x) => String(x.username).toLowerCase() === username.toLowerCase());
  if (!item) throw new ProfileNotFound("Akun TikTok tidak ditemukan");

  return store(
    key,
    makeProfile("TikTok", item.username, {
      name: item.name || "N/A",
      avatar: item.avatar || "N/A",
      followers: item.followers,
      following: item.following,
      bio: item.bio || "N/A",
      private: item.private,
      posts: item.posts,
      url: item.url,
    }),
  );
}

function meta(page, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(page);
    if (m) return decodeHtml(m[1]).trim();
  }
  return null;
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

async function publicPageProfile(platform, username, url, notFound) {
  username = normalizeUsername(username);
  const key = `${platform.toLowerCase()}:${username.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit;

  let lastError = null;
  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  try {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const response = await session.get(url, { allowRedirects: true });
        const page = await response.text();
        const lower = page.toLowerCase();
        if (
          response.status === 404 ||
          notFound.some((marker) => lower.includes(marker.toLowerCase()))
        ) {
          throw new ProfileNotFound(`Akun ${platform} tidak ditemukan`);
        }
        if (response.status === 429) throw new StalkerError(`Rate limit ${platform} tercapai`);
        if (response.status >= 400 && !page) {
          throw new StalkerError(`${platform} mengembalikan HTTP ${response.status}`);
        }

        const title = meta(page, "og:title") || "N/A";
        const image = meta(page, "og:image") || "N/A";
        const bio = meta(page, "og:description") || "N/A";
        if (title === "N/A" && image === "N/A" && bio === "N/A") {
          throw new StalkerError(`Data publik ${platform} tidak tersedia tanpa autentikasi`);
        }

        return store(
          key,
          makeProfile(platform, username, { name: title, avatar: image, bio, url }),
        );
      } catch (err) {
        if (err instanceof ProfileNotFound) throw err;
        lastError = err;
        if (attempt + 1 < RETRIES) await delay(600);
      }
    }
  } finally {
    await session.close();
  }
  throw new StalkerError(lastError ? String(lastError.message) : `${platform} tidak tersedia`);
}

async function instagramProfile(username) {
  username = normalizeUsername(username);
  return publicPageProfile("Instagram", username, `https://www.instagram.com/${username}/`, [
    "sorry, this page isn't available",
    "page isn't available",
  ]);
}

async function xProfile(username) {
  username = normalizeUsername(username);
  return publicPageProfile("X/Twitter", username, `https://x.com/${username}`, [
    "this account doesn\u2019t exist",
    "this account doesn't exist",
  ]);
}

async function facebookProfile(username) {
  username = normalizeUsername(username);
  return publicPageProfile("Facebook", username, `https://www.facebook.com/${username}`, [
    "this content isn't available",
    "konten ini tidak tersedia",
    "page not found",
  ]);
}

const DETAILED_FETCHERS = {
  TikTok: tiktokProfile,
  GitHub: githubProfile,
  Roblox: robloxProfile,
  Instagram: instagramProfile,
  "X/Twitter": xProfile,
  Facebook: facebookProfile,
};

const PLATFORMS = {
  TikTok: "https://www.tiktok.com/@{u}",
  GitHub: "https://github.com/{u}",
  Roblox: "https://www.roblox.com/users/profile?username={u}",
  Instagram: "https://www.instagram.com/{u}/",
  "X/Twitter": "https://x.com/{u}",
  Facebook: "https://www.facebook.com/{u}",
  YouTube: "https://www.youtube.com/@{u}",
  Twitch: "https://www.twitch.tv/{u}",
  Reddit: "https://www.reddit.com/user/{u}/",
  Pinterest: "https://www.pinterest.com/{u}/",
  Threads: "https://www.threads.net/@{u}",
  Telegram: "https://t.me/{u}",
  Medium: "https://medium.com/@{u}",
  SoundCloud: "https://soundcloud.com/{u}",
  Spotify: "https://open.spotify.com/user/{u}",
  Steam: "https://steamcommunity.com/id/{u}",
  GitLab: "https://gitlab.com/{u}",
  Bitbucket: "https://bitbucket.org/{u}/",
  Codeberg: "https://codeberg.org/{u}",
  Replit: "https://replit.com/@{u}",
  "Dev.to": "https://dev.to/{u}",
  "Hacker News": "https://news.ycombinator.com/user?id={u}",
  "Stack Overflow": "https://stackoverflow.com/users/{u}",
  Keybase: "https://keybase.io/{u}",
  Flickr: "https://www.flickr.com/people/{u}/",
  Vimeo: "https://vimeo.com/{u}",
  Dailymotion: "https://www.dailymotion.com/{u}",
  Behance: "https://www.behance.net/{u}",
  Dribbble: "https://dribbble.com/{u}",
  DeviantArt: "https://www.deviantart.com/{u}",
  "Mastodon.social": "https://mastodon.social/@{u}",
  Patreon: "https://www.patreon.com/{u}",
  "Ko-fi": "https://ko-fi.com/{u}",
  "Buy Me a Coffee": "https://www.buymeacoffee.com/{u}",
  Linktree: "https://linktr.ee/{u}",
  Gravatar: "https://gravatar.com/{u}",
  "About.me": "https://about.me/{u}",
  Quora: "https://www.quora.com/profile/{u}",
};

function makePlatformResult(platform, status, url, profile = null, error = "-") {
  return { platform, status, url, profile, error };
}

async function genericCheck(session, semaphore, platform, template, username) {
  const url = template.replace("{u}", encodeURIComponent(username).replace(/%2E/gi, ".").replace(/%2D/gi, "-").replace(/%5F/gi, "_"));
  await semaphore.acquire();
  try {
    const response = await session.get(url, { allowRedirects: true });
    const sample = (await response.text()).slice(0, 300_000).toLowerCase();
    if (response.status === 404) return makePlatformResult(platform, "not_found", url);
    if (response.status === 429) return makePlatformResult(platform, "error", url, null, "Rate limit");
    if (response.status >= 400) {
      return makePlatformResult(platform, "error", url, null, `HTTP ${response.status}`);
    }
    const markers = [
      "page not found",
      "profile not found",
      "user not found",
      "doesn't exist",
      "does not exist",
    ];
    if (markers.some((m) => sample.includes(m))) {
      return makePlatformResult(platform, "not_found", url);
    }
    return makePlatformResult(platform, "found", url, makeProfile(platform, username, { url }));
  } catch (err) {
    return makePlatformResult(platform, "error", url, null, err.constructor.name);
  } finally {
    semaphore.release();
  }
}

async function extraStalker(username) {
  username = normalizeUsername(username);
  const semaphore = { count: 0, queue: [], async acquire() {
    if (this.count < 8) { this.count += 1; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.count += 1;
  }, release() { this.count -= 1; const next = this.queue.shift(); if (next) next(); } };

  const session = new ClientSession({ headers: HEADERS, timeout: TIMEOUT });
  try {
    const tasks = Object.entries(PLATFORMS).map(async ([platform, template]) => {
      const fetcher = DETAILED_FETCHERS[platform];
      if (fetcher) {
        try {
          const profile = await fetcher(username);
          return makePlatformResult(platform, "found", profile.url, profile);
        } catch (err) {
          if (err instanceof ProfileNotFound) {
            return makePlatformResult(platform, "not_found", template.replace("{u}", username));
          }
          return makePlatformResult(
            platform,
            "error",
            template.replace("{u}", username),
            null,
            String(err.message).slice(0, 160),
          );
        }
      }
      return genericCheck(session, semaphore, platform, template, username);
    });
    return Promise.all(tasks);
  } finally {
    await session.close();
  }
}

module.exports = {
  StalkerError,
  ProfileNotFound,
  normalizeUsername,
  githubProfile,
  robloxProfile,
  tiktokProfile,
  instagramProfile,
  xProfile,
  facebookProfile,
  extraStalker,
  PLATFORMS,
};

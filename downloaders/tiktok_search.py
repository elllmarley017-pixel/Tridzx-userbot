"""Async TikTok account/video search using TikWM's public search endpoints."""
import asyncio
import html
import re
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

import aiohttp

API_BASE = "https://www.tikwm.com/api"
TIMEOUT = aiohttp.ClientTimeout(total=45, connect=15, sock_read=30)
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
}


class TikTokSearchError(RuntimeError):
    pass


async def _request(path: str, query: str, limit: int) -> dict:
    payload = {"keywords": query, "count": str(limit), "cursor": "0"}
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=TIMEOUT) as session:
            async with session.post(f"{API_BASE}/{path}", data=payload) as response:
                if response.status == 429:
                    raise TikTokSearchError("Rate limit TikTok search tercapai; coba lagi nanti")
                if response.status in {401, 403}:
                    raise TikTokSearchError("Layanan TikTok search sedang menolak akses")
                if response.status >= 400:
                    raise TikTokSearchError(f"TikTok search gagal: HTTP {response.status}")
                try:
                    data = await response.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError) as exc:
                    raise TikTokSearchError("Response TikTok search tidak valid") from exc
    except asyncio.TimeoutError as exc:
        raise TikTokSearchError("TikTok search timeout") from exc
    except aiohttp.ClientError as exc:
        raise TikTokSearchError("Koneksi ke layanan TikTok search gagal") from exc

    if data.get("code") != 0:
        message = str(data.get("msg") or "TikTok search gagal")
        raise TikTokSearchError(message[:200])
    result = data.get("data")
    if not isinstance(result, dict):
        raise TikTokSearchError("Response TikTok search tidak valid")
    return result


async def search_accounts(query: str, limit: int = 5) -> list[dict[str, Any]]:
    data = await _request("user/search", query, limit)
    results = []
    for item in data.get("user_list") or []:
        user = item.get("user") or {}
        stats = item.get("stats") or {}
        username = user.get("uniqueId")
        if not username:
            continue
        results.append({
            "username": username,
            "name": user.get("nickname") or username,
            "url": f"https://www.tiktok.com/@{username}",
            "avatar": user.get("avatarLarger") or user.get("avatarMedium") or user.get("avatarThumb"),
            "followers": stats.get("followerCount"),
            "following": stats.get("followingCount"),
            "posts": stats.get("videoCount"),
            "bio": user.get("signature") or "N/A",
            "private": user.get("privateAccount"),
            "verified": bool(user.get("verified")),
        })
    return results[:limit]


async def _search_videos_fallback(query: str, limit: int) -> list[dict[str, Any]]:
    search_url = "https://html.duckduckgo.com/html/?q=" + quote(
        f"site:tiktok.com/@ inurl:/video/ {query}"
    )
    try:
        async with aiohttp.ClientSession(headers=HEADERS, timeout=TIMEOUT) as session:
            async with session.get(search_url) as response:
                if response.status == 429:
                    raise TikTokSearchError("Rate limit pencarian video tercapai; coba lagi nanti")
                if response.status >= 400:
                    raise TikTokSearchError(f"Pencarian video gagal: HTTP {response.status}")
                page = await response.text()
    except asyncio.TimeoutError as exc:
        raise TikTokSearchError("Pencarian video TikTok timeout") from exc
    except aiohttp.ClientError as exc:
        raise TikTokSearchError("Koneksi pencarian video TikTok gagal") from exc

    results = []
    seen = set()
    pattern = re.compile(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.DOTALL)
    for raw_url, raw_title in pattern.findall(page):
        redirect_url = html.unescape(raw_url)
        if redirect_url.startswith("//"):
            redirect_url = "https:" + redirect_url
        params = parse_qs(urlparse(redirect_url).query)
        target = unquote(params.get("uddg", [redirect_url])[0])
        if "tiktok.com/@" not in target or "/video/" not in target:
            continue
        target = target.split("?", 1)[0]
        if target in seen:
            continue
        seen.add(target)
        match = re.search(r"tiktok\.com/@([^/]+)/video/(\d+)", target)
        username = match.group(1) if match else "Tidak diketahui"
        title = re.sub(r"<[^>]+>", "", html.unescape(raw_title)).strip()
        results.append({
            "caption": title if title and title != "TikTok - Make Your Day" else query,
            "username": username,
            "url": target,
            "thumbnail": None,
            "views": None,
            "likes": None,
            "comments": None,
        })
        if len(results) >= limit:
            break
    return results


async def search_videos(query: str, limit: int = 5) -> list[dict[str, Any]]:
    try:
        data = await _request("feed/search", query, limit)
    except TikTokSearchError as exc:
        if "menolak akses" not in str(exc) and "HTTP 403" not in str(exc):
            raise
        return await _search_videos_fallback(query, limit)

    videos = data.get("videos") or data.get("video_list") or []
    results = []
    for item in videos:
        author = item.get("author") or {}
        username = author.get("unique_id") or author.get("uniqueId") or item.get("author_name") or ""
        video_id = str(item.get("video_id") or item.get("id") or "")
        url = item.get("share_url") or item.get("url")
        if not url and username and video_id:
            url = f"https://www.tiktok.com/@{username}/video/{video_id}"
        if not url:
            continue
        results.append({
            "caption": item.get("title") or item.get("desc") or "Tanpa caption",
            "username": username or "Tidak diketahui",
            "url": url,
            "thumbnail": item.get("cover") or item.get("origin_cover") or item.get("dynamic_cover"),
            "views": item.get("play_count") or item.get("playCount"),
            "likes": item.get("digg_count") or item.get("like_count") or item.get("diggCount"),
            "comments": item.get("comment_count") or item.get("commentCount"),
        })
    return results[:limit] or await _search_videos_fallback(query, limit)


if __name__ == "__main__":
    async def _check():
        accounts = await search_accounts("tiktok", 1)
        assert accounts and accounts[0]["username"]

    asyncio.run(_check())

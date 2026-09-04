"""Public-only social profile lookups with bounded retries and caching."""
import asyncio
import html
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import quote

import aiohttp

from downloaders.tiktok_search import search_accounts

TIMEOUT = aiohttp.ClientTimeout(total=18, connect=6, sock_connect=6, sock_read=10)
HEADERS = {
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
}
CACHE_TTL = 300
_RETRIES = 2
_cache: dict[tuple[str, str], tuple[float, Any]] = {}


class StalkerError(RuntimeError):
    pass


class ProfileNotFound(StalkerError):
    pass


@dataclass
class Profile:
    platform: str
    username: str
    name: str = "N/A"
    avatar: str = "N/A"
    followers: int | str | None = None
    following: int | str | None = None
    bio: str = "N/A"
    private: bool | None = None
    posts: int | str | None = None
    url: str = "N/A"
    email: str | None = None
    repositories: int | None = None
    extras: dict[str, Any] = field(default_factory=dict)


@dataclass
class PlatformResult:
    platform: str
    status: str  # found, not_found, error
    url: str
    profile: Profile | None = None
    error: str = "-"


def normalize_username(value: str) -> str:
    username = value.strip().lstrip("@").strip()
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})", username):
        raise StalkerError("Username tidak valid; gunakan huruf, angka, titik, underscore, atau tanda minus")
    return username


def _cached(key):
    item = _cache.get(key)
    if item and time.monotonic() - item[0] < CACHE_TTL:
        return item[1]
    _cache.pop(key, None)
    return None


def _store(key, value):
    _cache[key] = (time.monotonic(), value)
    return value


async def _request_json(session, method: str, url: str, **kwargs) -> dict:
    last_error = None
    for attempt in range(_RETRIES):
        try:
            async with session.request(method, url, **kwargs) as response:
                if response.status == 404:
                    raise ProfileNotFound("Akun tidak ditemukan")
                if response.status == 429:
                    raise StalkerError("Rate limit platform tercapai")
                if response.status in {401, 403}:
                    raise StalkerError("Platform menolak akses publik saat ini")
                if response.status >= 400:
                    raise StalkerError(f"Platform mengembalikan HTTP {response.status}")
                data = await response.json(content_type=None)
                if not isinstance(data, dict):
                    raise StalkerError("Response platform tidak valid")
                return data
        except ProfileNotFound:
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError, ValueError, StalkerError) as exc:
            last_error = exc
            if isinstance(exc, StalkerError) and "Rate limit" in str(exc):
                raise
            if attempt + 1 < _RETRIES:
                await asyncio.sleep(0.6)
    raise StalkerError(str(last_error) or "Request platform gagal")


async def github_profile(username: str) -> Profile:
    username = normalize_username(username)
    key = ("github", username.casefold())
    if (result := _cached(key)) is not None:
        return result
    headers = dict(HEADERS)
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with aiohttp.ClientSession(headers=headers, timeout=TIMEOUT) as session:
        data = await _request_json(session, "GET", f"https://api.github.com/users/{quote(username)}")
    if data.get("login", "").casefold() != username.casefold():
        raise ProfileNotFound("Akun GitHub tidak ditemukan")
    return _store(key, Profile(
        platform="GitHub", username=data["login"], name=data.get("name") or "N/A",
        avatar=data.get("avatar_url") or "N/A", followers=data.get("followers"),
        following=data.get("following"), bio=data.get("bio") or "N/A", private=False,
        posts=None, url=data.get("html_url") or f"https://github.com/{username}",
        email=data.get("email") or None, repositories=data.get("public_repos"),
    ))


async def roblox_profile(username: str) -> Profile:
    username = normalize_username(username)
    key = ("roblox", username.casefold())
    if (result := _cached(key)) is not None:
        return result
    async with aiohttp.ClientSession(headers=HEADERS, timeout=TIMEOUT) as session:
        lookup = await _request_json(
            session, "POST", "https://users.roblox.com/v1/usernames/users",
            json={"usernames": [username], "excludeBannedUsers": False},
        )
        users = lookup.get("data") or []
        if not users or users[0].get("name", "").casefold() != username.casefold():
            raise ProfileNotFound("Akun Roblox tidak ditemukan")
        user_id = users[0]["id"]
        profile, followers, following, avatar = await asyncio.gather(
            _request_json(session, "GET", f"https://users.roblox.com/v1/users/{user_id}"),
            _request_json(session, "GET", f"https://friends.roblox.com/v1/users/{user_id}/followers/count"),
            _request_json(session, "GET", f"https://friends.roblox.com/v1/users/{user_id}/followings/count"),
            _request_json(session, "GET", f"https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds={user_id}&size=420x420&format=Png&isCircular=false"),
        )
    images = avatar.get("data") or []
    return _store(key, Profile(
        platform="Roblox", username=profile.get("name") or username,
        name=profile.get("displayName") or profile.get("name") or "N/A",
        avatar=(images[0].get("imageUrl") if images else None) or "N/A",
        followers=followers.get("count"), following=following.get("count"),
        bio=profile.get("description") or "N/A", private=None, posts=None,
        url=f"https://www.roblox.com/users/{user_id}/profile",
        extras={"Banned": "Ya" if profile.get("isBanned") else "Tidak"},
    ))


async def tiktok_profile(username: str) -> Profile:
    username = normalize_username(username)
    key = ("tiktok", username.casefold())
    if (result := _cached(key)) is not None:
        return result
    results = await search_accounts(username, 10)
    item = next((x for x in results if x["username"].casefold() == username.casefold()), None)
    if not item:
        raise ProfileNotFound("Akun TikTok tidak ditemukan")
    # Existing public search endpoint does not expose every field reliably.
    return _store(key, Profile(
        platform="TikTok", username=item["username"], name=item.get("name") or "N/A",
        avatar=item.get("avatar") or "N/A", followers=item.get("followers"),
        following=item.get("following"), bio=item.get("bio") or "N/A",
        private=item.get("private"), posts=item.get("posts"), url=item["url"],
    ))


def _meta(page: str, property_name: str) -> str | None:
    patterns = [
        rf'<meta[^>]+(?:property|name)=["\']{re.escape(property_name)}["\'][^>]+content=["\']([^"\']*)',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']{re.escape(property_name)}["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, page, re.IGNORECASE)
        if match:
            return html.unescape(match.group(1)).strip()
    return None


async def _public_page_profile(platform: str, username: str, url: str, not_found: tuple[str, ...]) -> Profile:
    username = normalize_username(username)
    key = (platform.casefold(), username.casefold())
    if (result := _cached(key)) is not None:
        return result
    last_error = None
    async with aiohttp.ClientSession(headers=HEADERS, timeout=TIMEOUT) as session:
        for attempt in range(_RETRIES):
            try:
                async with session.get(url, allow_redirects=True) as response:
                    page = await response.text(errors="replace")
                    lower = page.casefold()
                    if response.status == 404 or any(marker.casefold() in lower for marker in not_found):
                        raise ProfileNotFound(f"Akun {platform} tidak ditemukan")
                    if response.status == 429:
                        raise StalkerError(f"Rate limit {platform} tercapai")
                    if response.status >= 400 and not page:
                        raise StalkerError(f"{platform} mengembalikan HTTP {response.status}")
                    title = _meta(page, "og:title") or "N/A"
                    image = _meta(page, "og:image") or "N/A"
                    bio = _meta(page, "og:description") or "N/A"
                    if title == "N/A" and image == "N/A" and bio == "N/A":
                        raise StalkerError(f"Data publik {platform} tidak tersedia tanpa autentikasi")
                    return _store(key, Profile(
                        platform=platform, username=username, name=title, avatar=image,
                        bio=bio, private=None, url=url,
                    ))
            except ProfileNotFound:
                raise
            except (asyncio.TimeoutError, aiohttp.ClientError, StalkerError) as exc:
                last_error = exc
                if attempt + 1 < _RETRIES:
                    await asyncio.sleep(0.6)
    raise StalkerError(str(last_error) or f"{platform} tidak tersedia")


async def instagram_profile(username: str) -> Profile:
    username = normalize_username(username)
    return await _public_page_profile(
        "Instagram", username, f"https://www.instagram.com/{username}/",
        ("sorry, this page isn't available", "page isn't available"),
    )


async def x_profile(username: str) -> Profile:
    username = normalize_username(username)
    return await _public_page_profile(
        "X/Twitter", username, f"https://x.com/{username}",
        ("this account doesn’t exist", "this account doesn't exist"),
    )


async def facebook_profile(username: str) -> Profile:
    username = normalize_username(username)
    return await _public_page_profile(
        "Facebook", username, f"https://www.facebook.com/{username}",
        ("this content isn't available", "konten ini tidak tersedia", "page not found"),
    )


DETAILED_FETCHERS: dict[str, Callable[[str], Awaitable[Profile]]] = {
    "TikTok": tiktok_profile,
    "GitHub": github_profile,
    "Roblox": roblox_profile,
    "Instagram": instagram_profile,
    "X/Twitter": x_profile,
    "Facebook": facebook_profile,
}

# Exact public profile routes. Generic checks only classify an exact route; they
# never infer identity from similar display names.
PLATFORMS: dict[str, str] = {
    "TikTok": "https://www.tiktok.com/@{u}", "GitHub": "https://github.com/{u}",
    "Roblox": "https://www.roblox.com/users/profile?username={u}", "Instagram": "https://www.instagram.com/{u}/",
    "X/Twitter": "https://x.com/{u}", "Facebook": "https://www.facebook.com/{u}",
    "YouTube": "https://www.youtube.com/@{u}", "Twitch": "https://www.twitch.tv/{u}",
    "Reddit": "https://www.reddit.com/user/{u}/", "Pinterest": "https://www.pinterest.com/{u}/",
    "Threads": "https://www.threads.net/@{u}", "Telegram": "https://t.me/{u}",
    "Medium": "https://medium.com/@{u}", "SoundCloud": "https://soundcloud.com/{u}",
    "Spotify": "https://open.spotify.com/user/{u}", "Steam": "https://steamcommunity.com/id/{u}",
    "GitLab": "https://gitlab.com/{u}", "Bitbucket": "https://bitbucket.org/{u}/",
    "Codeberg": "https://codeberg.org/{u}", "Replit": "https://replit.com/@{u}",
    "Dev.to": "https://dev.to/{u}", "Hacker News": "https://news.ycombinator.com/user?id={u}",
    "Stack Overflow": "https://stackoverflow.com/users/{u}", "Keybase": "https://keybase.io/{u}",
    "Flickr": "https://www.flickr.com/people/{u}/", "Vimeo": "https://vimeo.com/{u}",
    "Dailymotion": "https://www.dailymotion.com/{u}", "Behance": "https://www.behance.net/{u}",
    "Dribbble": "https://dribbble.com/{u}", "DeviantArt": "https://www.deviantart.com/{u}",
    "Mastodon.social": "https://mastodon.social/@{u}", "Patreon": "https://www.patreon.com/{u}",
    "Ko-fi": "https://ko-fi.com/{u}", "Buy Me a Coffee": "https://www.buymeacoffee.com/{u}",
    "Linktree": "https://linktr.ee/{u}", "Gravatar": "https://gravatar.com/{u}",
    "About.me": "https://about.me/{u}", "Quora": "https://www.quora.com/profile/{u}",
}
assert len(PLATFORMS) == 38


async def _generic_check(session, semaphore, platform: str, template: str, username: str) -> PlatformResult:
    url = template.format(u=quote(username, safe="._-"))
    async with semaphore:
        try:
            async with session.get(url, allow_redirects=True) as response:
                sample = (await response.text(errors="replace"))[:300_000].casefold()
                if response.status == 404:
                    return PlatformResult(platform, "not_found", url)
                if response.status == 429:
                    return PlatformResult(platform, "error", url, error="Rate limit")
                if response.status >= 400:
                    return PlatformResult(platform, "error", url, error=f"HTTP {response.status}")
                markers = ("page not found", "profile not found", "user not found", "doesn't exist", "does not exist")
                if any(marker in sample for marker in markers):
                    return PlatformResult(platform, "not_found", url)
                return PlatformResult(platform, "found", url, profile=Profile(platform, username, url=url))
        except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
            return PlatformResult(platform, "error", url, error=type(exc).__name__)


async def extra_stalker(username: str) -> list[PlatformResult]:
    username = normalize_username(username)
    semaphore = asyncio.Semaphore(8)
    async with aiohttp.ClientSession(headers=HEADERS, timeout=TIMEOUT) as session:
        async def check(platform: str, template: str):
            fetcher = DETAILED_FETCHERS.get(platform)
            if fetcher:
                try:
                    profile = await fetcher(username)
                    return PlatformResult(platform, "found", profile.url, profile=profile)
                except ProfileNotFound:
                    return PlatformResult(platform, "not_found", template.format(u=username))
                except Exception as exc:
                    return PlatformResult(platform, "error", template.format(u=username), error=str(exc)[:160])
            return await _generic_check(session, semaphore, platform, template, username)

        return await asyncio.gather(*(check(platform, template) for platform, template in PLATFORMS.items()))

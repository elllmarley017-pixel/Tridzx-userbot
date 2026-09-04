"""TikTok downloader — video & photo slide via scraping."""
import re
import os
import uuid
import asyncio
import aiohttp
import json
from config import TEMP_DIR, MAX_FILE_SIZE
from downloaders.ytdlp_engine import run_ytdlp, validate_download
from utils.cleanup import cleanup_file, ensure_temp_dir

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

def _normalize_tiktok_url(url: str) -> str:
    """Convert /photo/ to /video/ — yt-dlp doesn't support /photo/ URLs."""
    return re.sub(r'/photo/', '/video/', url)

TIKTOK_RE = re.compile(
    r'https?://(www\.|vm\.|vt\.)?(tiktok\.com)/', re.IGNORECASE
)
SHORT_TIKTOK_HOSTS = {"vt.tiktok.com", "vm.tiktok.com"}
RESOLVE_TIMEOUT = aiohttp.ClientTimeout(total=12, connect=4, sock_connect=4, sock_read=6)
RESOLVE_RETRIES = 3


class TikTokResolveError(RuntimeError):
    """Short TikTok URL could not be resolved safely."""


# Ensure node visible to yt-dlp
_ENV = os.environ.copy()
_ENV["PATH"] = "/data/data/com.termux/files/usr/bin:" + _ENV.get("PATH", "")


def is_tiktok_url(url: str) -> bool:
    return bool(TIKTOK_RE.match(url.strip()))


def _is_short_tiktok_url(url: str) -> bool:
    from urllib.parse import urlparse
    return (urlparse(url.strip()).hostname or "").lower() in SHORT_TIKTOK_HOSTS


def _resolved_tiktok_url(url: str) -> str | None:
    """Return a usable non-short TikTok URL, otherwise None."""
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in {"tiktok.com", "www.tiktok.com", *SHORT_TIKTOK_HOSTS}:
        return None
    if host in SHORT_TIKTOK_HOSTS:
        return None
    return url


async def _resolve_url(url: str) -> str:
    """Resolve TikTok short URLs via HEAD, GET fallback, bounded retries."""
    original = url.strip()
    if not is_tiktok_url(original):
        raise TikTokResolveError("URL TikTok tidak valid")
    if not _is_short_tiktok_url(original):
        return original

    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://www.tiktok.com/",
    }
    last_error = None

    async with aiohttp.ClientSession(headers=headers, timeout=RESOLVE_TIMEOUT) as session:
        for attempt in range(RESOLVE_RETRIES):
            for method in ("HEAD", "GET"):
                try:
                    request_headers = {"Range": "bytes=0-0"} if method == "GET" else None
                    async with session.request(
                        method,
                        original,
                        headers=request_headers,
                        allow_redirects=True,
                    ) as response:
                        resolved = _resolved_tiktok_url(str(response.url))
                        if resolved and response.status < 500:
                            return resolved
                        last_error = RuntimeError(f"HTTP {response.status}")
                except (asyncio.TimeoutError, aiohttp.ClientError, OSError) as exc:
                    last_error = exc

            if attempt + 1 < RESOLVE_RETRIES:
                await asyncio.sleep(0.75 * (attempt + 1))

    raise TikTokResolveError("Gagal mengakses link TikTok") from last_error


async def _get_tiktok_info(url: str) -> dict:
    """Use yt-dlp --dump-json with retry, fallback to tikwm API."""
    url = _normalize_tiktok_url(url)
    last_err = ""
    for attempt in range(3):
        cmd = [
            "yt-dlp", "--js-runtimes", "node",
            "--dump-json", "--no-warnings", "--quiet",
            "--socket-timeout", "20", "--extractor-retries", "3",
            "--retry-sleep", "extractor:exp=1:8", url,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=_ENV,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            last_err = "timeout"
            await asyncio.sleep(2)
            continue
        if proc.returncode == 0 and stdout.strip():
            return json.loads(stdout.decode())
        last_err = stderr.decode(errors="replace").strip()
        await asyncio.sleep(2)
    # Fallback: tikwm API
    try:
        return await _tikwm_info(url)
    except Exception:
        pass
    raise RuntimeError(f"Gagal mendapatkan info TikTok: {last_err[:200]}")


async def _tikwm_info(url: str) -> dict:
    """Fallback: use tikwm.com API for TikTok metadata + images."""
    api = "https://www.tikwm.com/api/"
    async with aiohttp.ClientSession() as s:
        async with s.post(api, data={"url": url, "hd": "1"},
                          timeout=aiohttp.ClientTimeout(total=20)) as r:
            data = await r.json()
    if data.get("code") != 0:
        raise RuntimeError(data.get("msg", "tikwm error"))
    d = data["data"]
    author = d.get("author", {})
    result = {
        "_source": "tikwm",
        "uploader": author.get("unique_id", ""),
        "uploader_id": author.get("id", ""),
        "description": d.get("title", ""),
        "duration": d.get("duration", 0),
    }
    if d.get("images"):
        result["images"] = d["images"]
    else:
        result["play"] = d.get("hdplay") or d.get("play", "")
    return result


async def download_tiktok_video(url: str, progress_cb=None) -> dict:
    """Download TikTok video. Returns metadata dict."""
    ensure_temp_dir()

    if "vt.tiktok" in url or "vm.tiktok" in url:
        url = await _resolve_url(url)
    url = _normalize_tiktok_url(url)

    if progress_cb:
        await progress_cb(10, 100)

    info = await _get_tiktok_info(url)

    if progress_cb:
        await progress_cb(30, 100)

    # Detect photo slide
    if (info.get("_type") == "playlist"
            or "imagePost" in str(info.get("format_id", ""))
            or info.get("images")
            or info.get("vcodec") == "none"):
        return {"type": "photo", "info": info}

    creator = info.get("uploader", "") or info.get("creator", "") or ""
    # Don't use platform name as creator
    if creator.lower() in ("tiktok", ""):
        creator = info.get("uploader_id", "") or "Unknown"
    caption = info.get("description", "") or ""
    duration = info.get("duration", 0)

    # tikwm fallback: direct download via play URL
    if info.get("_source") == "tikwm" and info.get("play"):
        filename = os.path.join(TEMP_DIR, f"tt_{uuid.uuid4().hex[:8]}.mp4")
        headers = {"User-Agent": UA, "Referer": "https://www.tiktok.com/"}
        async with aiohttp.ClientSession() as session:
            async with session.get(info["play"], headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Download gagal: HTTP {resp.status}")
                total = int(resp.headers.get("Content-Length", 0) or 0)
                if total > MAX_FILE_SIZE:
                    raise RuntimeError("File TikTok terlalu besar")
                downloaded = 0
                try:
                    with open(filename, "wb") as f:
                        async for chunk in resp.content.iter_chunked(256 * 1024):
                            downloaded += len(chunk)
                            if downloaded > MAX_FILE_SIZE:
                                raise RuntimeError("File TikTok terlalu besar")
                            f.write(chunk)
                    if total and downloaded != total:
                        raise RuntimeError("Response download TikTok tidak lengkap")
                except BaseException:
                    cleanup_file(filename)
                    raise
        validate_download(filename, expected_ext="mp4")
        if progress_cb:
            await progress_cb(85, 100)
    else:
        filename = os.path.join(TEMP_DIR, f"tt_{uuid.uuid4().hex[:8]}.mp4")
        info = await run_ytdlp(
            url,
            filename,
            f"{filename}*",
            timeout=240,
            attempts=3,
            progress_cb=progress_cb,
            expected_ext="mp4",
        )
        filename = info["filepath"]

        if progress_cb:
            await progress_cb(85, 100)

    validate_download(filename, expected_ext="mp4")

    return {
        "type": "video",
        "filepath": filename,
        "creator": creator,
        "caption": caption,
        "duration": int(duration) if duration else 0,
    }


async def download_tiktok_photos(url: str, progress_cb=None) -> dict:
    """Download TikTok photo slides."""
    ensure_temp_dir()

    if _is_short_tiktok_url(url):
        url = await _resolve_url(url)
    url = _normalize_tiktok_url(url)

    if progress_cb:
        await progress_cb(10, 100)

    info = await _get_tiktok_info(url)

    if progress_cb:
        await progress_cb(30, 100)

    is_photo = (
        info.get("_type") == "playlist"
        or "imagePost" in str(info.get("format_id", ""))
        or bool(info.get("images"))
        or info.get("vcodec") == "none"
    )
    if not is_photo:
        return {"type": "video"}

    creator = info.get("uploader", "") or info.get("creator", "") or ""
    if creator.lower() in ("tiktok", ""):
        creator = info.get("uploader_id", "") or "Unknown"
    caption = info.get("description", "") or ""

    images = []

    # tikwm fallback: images list directly available
    if info.get("images"):
        images = info["images"]

    # Method 1: entries in playlist-like structure
    if not images:
        entries = info.get("entries", [])
        if entries:
            for entry in entries:
                img_url = entry.get("url") or entry.get("webpage_url")
                if img_url:
                    images.append(img_url)

    # Method 2: thumbnails / image fields
    if not images:
        for key in ("thumbnails", "images"):
            for t in info.get(key, []):
                u = t.get("url", "") if isinstance(t, dict) else t
                if u and not u.endswith(".webp"):
                    images.append(u)

    # Method 3: fallback — use yt-dlp to download directly
    if not images:
        prefix = os.path.join(TEMP_DIR, f"ttpic_{uuid.uuid4().hex[:6]}")
        cmd = [
            "yt-dlp", "--js-runtimes", "node",
            "-o", f"{prefix}_%(autonumber)s.%(ext)s",
            "--socket-timeout", "20", "--retries", "5", "--fragment-retries", "5",
            "--retry-sleep", "http:exp=1:8", "--concurrent-fragments", "4",
            "--continue", "--part", "--no-warnings", "--quiet",
            url,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=_ENV,
        )
        import glob
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            for partial in glob.glob(f"{prefix}_*"):
                try:
                    os.remove(partial)
                except OSError:
                    pass
            raise RuntimeError("Ekstraksi TikTok Photo/Slide timeout")
        if proc.returncode != 0:
            err = stderr.decode(errors="replace").strip()
            for partial in glob.glob(f"{prefix}_*"):
                try:
                    os.remove(partial)
                except OSError:
                    pass
            # Check if it's actually a video
            if "video" in err.lower():
                return {"type": "video"}
            raise RuntimeError(f"Download gagal: {err[:200]}")

        files = sorted(glob.glob(f"{prefix}_*"))
        if not files:
            raise RuntimeError("Tidak ada foto yang berhasil didownload")
        return {
            "type": "photo",
            "filepaths": files,
            "creator": creator,
            "caption": caption,
        }

    # Download image URLs
    filepaths = []
    headers = {"User-Agent": UA, "Referer": "https://www.tiktok.com/"}
    image_timeout = aiohttp.ClientTimeout(total=30, connect=8, sock_connect=8, sock_read=15)
    async with aiohttp.ClientSession(timeout=image_timeout) as session:
        for i, img_url in enumerate(images):
            ext = ".jpg"
            if ".png" in img_url:
                ext = ".png"
            elif ".webp" in img_url:
                ext = ".webp"
            fp = os.path.join(TEMP_DIR, f"ttpic_{uuid.uuid4().hex[:6]}_{i}{ext}")
            try:
                async with session.get(img_url, headers=headers) as resp:
                    if resp.status == 200:
                        with open(fp, "wb") as f:
                            f.write(await resp.read())
                        filepaths.append(fp)
            except Exception:
                continue
            if progress_cb:
                await progress_cb(30 + int((i + 1) / len(images) * 60), 100)

    if not filepaths:
        raise RuntimeError("Tidak ada foto yang berhasil didownload")

    return {
        "type": "photo",
        "filepaths": filepaths,
        "creator": creator,
        "caption": caption,
    }

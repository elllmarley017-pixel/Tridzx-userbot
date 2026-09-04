"""Videy downloader — handles CDN direct .mp4 and scraper pages."""
import re
import os
import uuid
import asyncio
import aiohttp
from config import TEMP_DIR, MAX_FILE_SIZE
from downloaders.ytdlp_engine import run_ytdlp, validate_download
from utils.cleanup import cleanup_file, ensure_temp_dir

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# Domains that host direct video files (may still redirect to HTML)
DIRECT_DOMAINS = [
    "cdn.slicefile.id", "cdeyy.de", "cdn2.viyey.co",
    "gofilee.co", "streamrizz.com",
]


async def _resolve_direct_url(url: str) -> str:
    """Try to get a real video URL from the page / redirects."""
    clean = url.split("?")[0] if "streamrizz.com" not in url else url

    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": url,
    }

    async with aiohttp.ClientSession() as session:
        # HEAD first to check if it's already a video
        try:
            async with session.head(clean, headers=headers, allow_redirects=True,
                                    timeout=aiohttp.ClientTimeout(total=30)) as resp:
                ct = resp.headers.get("Content-Type", "")
                if ct.startswith("video/"):
                    return str(resp.url)
        except Exception:
            pass

        # GET the page and scrape for video source
        async with session.get(url, headers=headers, allow_redirects=True,
                               timeout=aiohttp.ClientTimeout(total=30)) as resp:
            final_url = str(resp.url)
            ct = resp.headers.get("Content-Type", "")

            if ct.startswith("video/"):
                return final_url

            html = await resp.text()

        # Try various patterns to find video URL in HTML
        patterns = [
            r'<source[^>]+src="(https?://[^"]+\.mp4[^"]*)"',
            r'src="(https?://[^"]+\.mp4[^"]*)"',
            r"src='(https?://[^']+\.mp4[^']*)'",
            r'file:\s*"(https?://[^"]+\.mp4[^"]*)"',
            r'source:\s*"(https?://[^"]+\.mp4[^"]*)"',
            r'"(https?://[^"]+\.mp4(?:\?[^"]*)?)"',
        ]
        for pat in patterns:
            m = re.search(pat, html, re.IGNORECASE)
            if m:
                return m.group(1)

    return clean  # last resort: return cleaned URL


async def _download_with_aiohttp(url: str, filepath: str, progress_cb=None) -> str:
    """Stream-download a video URL."""
    headers = {
        "User-Agent": UA,
        "Referer": url,
    }
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, allow_redirects=True,
                               timeout=aiohttp.ClientTimeout(total=300)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status} saat download video")

            ct = resp.headers.get("Content-Type", "")
            total = int(resp.headers.get("Content-Length", 0))

            if total > MAX_FILE_SIZE:
                raise RuntimeError(f"File terlalu besar: {total / (1024*1024):.1f}MB (maks {MAX_FILE_SIZE // (1024*1024)}MB)")

            # If still HTML, fall through to yt-dlp
            if "text/html" in ct:
                return ""

            with open(filepath, "wb") as f:
                downloaded = 0
                async for chunk in resp.content.iter_chunked(1024 * 1024):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_cb and total:
                        await progress_cb(downloaded, total)

    return filepath


async def _download_with_ytdlp(url: str, filepath: str, progress_cb=None) -> str:
    """Fallback through the shared retry, timeout, cleanup, validation engine."""
    try:
        info = await run_ytdlp(
            url, filepath, f"{filepath}*", expected_ext="mp4", timeout=300, attempts=3, progress_cb=progress_cb,
        )
        return validate_download(info["filepath"], expected_ext="mp4")
    except BaseException:
        for candidate in __import__("glob").glob(f"{filepath}*"):
            cleanup_file(candidate)
        raise


async def download_videy(url: str, progress_cb=None) -> str:
    ensure_temp_dir()
    filename = os.path.join(TEMP_DIR, f"videy_{uuid.uuid4().hex[:8]}.mp4")

    # Step 1: resolve real video URL
    direct_url = await _resolve_direct_url(url)

    # Step 2: try aiohttp streaming download
    result = await _download_with_aiohttp(direct_url, filename, progress_cb)
    if result and os.path.exists(result):
        return validate_download(result, expected_ext="mp4")

    # Step 3: aiohttp got HTML or empty — fallback to yt-dlp on original URL
    if os.path.exists(filename):
        os.remove(filename)

    return await _download_with_ytdlp(url, filename, progress_cb)

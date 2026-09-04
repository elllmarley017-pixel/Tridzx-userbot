"""MediaFire downloader — scrape direct download link from page."""
import re
import os
import aiohttp
from urllib.parse import unquote
from config import TEMP_DIR, MAX_FILE_SIZE
from utils.cleanup import ensure_temp_dir

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

MEDIAFIRE_RE = re.compile(r'https?://(www\.)?mediafire\.com/file/', re.IGNORECASE)


def is_mediafire_url(url: str) -> bool:
    return bool(MEDIAFIRE_RE.match(url.strip()))


async def download_mediafire(url: str, progress_cb=None) -> dict:
    ensure_temp_dir()

    headers = {"User-Agent": UA}

    if progress_cb:
        await progress_cb(5, 100)

    # Scrape the page for direct download link
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Gagal memuat halaman MediaFire: HTTP {resp.status}")
            html = await resp.text()

    # Check file removed
    if "This file has been removed" in html or "Invalid or Deleted File" in html:
        raise RuntimeError("File telah dihapus atau tidak valid")

    # Extract direct download URL
    direct_url = None
    m = re.search(r'href="(https?://download\d*\.mediafire\.com/[^"]+)"', html)
    if m:
        direct_url = m.group(1)
    else:
        m = re.search(r'aria-label="Download file"\s*href="(https?://[^"]+)"', html)
        if m:
            direct_url = m.group(1)
        else:
            m = re.search(r'id="downloadButton"[^>]*href="(https?://[^"]+)"', html)
            if m:
                direct_url = m.group(1)

    if not direct_url:
        raise RuntimeError("Direct download URL tidak ditemukan")

    # Extract original filename
    filename_match = re.search(r'<div class="filename">([^<]+)</div>', html)
    original_name = filename_match.group(1).strip() if filename_match else None
    if not original_name:
        # Try from URL
        parts = url.rstrip("/").split("/")
        for p in reversed(parts):
            if "." in p and p != "file":
                original_name = unquote(p.replace("+", " "))
                break
    if not original_name:
        original_name = "mediafire_download"

    # Extract file size from page
    size_match = re.search(r'<span class="dl-info">\((\d+[\.,]?\d*\s*[KMGT]?B)\)', html, re.IGNORECASE)
    page_size = size_match.group(1) if size_match else None

    if progress_cb:
        await progress_cb(15, 100)

    filepath = os.path.join(TEMP_DIR, original_name)

    # Download with streaming
    async with aiohttp.ClientSession() as session:
        async with session.get(direct_url, headers=headers, allow_redirects=True,
                               timeout=aiohttp.ClientTimeout(total=600)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Download gagal: HTTP {resp.status}")

            total = int(resp.headers.get("Content-Length", 0))
            if total > MAX_FILE_SIZE:
                raise RuntimeError(
                    f"File terlalu besar: {total/(1024*1024):.1f}MB "
                    f"(maks Telegram: {MAX_FILE_SIZE//(1024*1024)}MB)"
                )

            with open(filepath, "wb") as f:
                dl = 0
                async for chunk in resp.content.iter_chunked(1024 * 1024):
                    f.write(chunk)
                    dl += len(chunk)
                    if progress_cb and total:
                        await progress_cb(15 + int(dl / total * 80), 100)

    if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
        raise RuntimeError("File hasil download kosong atau tidak ditemukan")

    return {
        "filepath": filepath,
        "filename": original_name,
        "size": os.path.getsize(filepath),
    }

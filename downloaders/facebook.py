"""Facebook downloader - ported from facebook.js (fb.js)"""
import re
import os
import aiohttp
from config import TEMP_DIR, REQUEST_TIMEOUT, MAX_FILE_SIZE
from utils.helpers import sanitize_filename
from utils.cleanup import ensure_temp_dir

API = "https://v3.fdownloader.net/api/ajaxSearch"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

FB_RE = re.compile(
    r'https?://(www\.)?(facebook\.com|fb\.watch|fb\.com|m\.facebook\.com|fb\.gg)/\S+',
    re.IGNORECASE
)


def is_facebook_url(text: str) -> bool:
    return bool(FB_RE.match(text.strip()))


def extract_fb_url(text: str) -> str | None:
    m = FB_RE.search(text)
    return m.group(0) if m else None


async def get_facebook(url: str) -> dict:
    """
    Get Facebook video download link.
    Returns: {"video": str, "title": str}
    """
    headers = {
        "User-Agent": UA,
        "Referer": "https://fdownloader.net/en",
        "Origin": "https://fdownloader.net",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {"q": url, "lang": "en"}

    async with aiohttp.ClientSession() as session:
        async with session.post(API, headers=headers, data=data,
                                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)) as resp:
            result = await resp.json(content_type=None)

    data_html = result.get("data", "")
    if not data_html:
        raise RuntimeError("Tidak ada data dari server Facebook downloader")

    # Try to find best quality download link (HD first, then SD)
    # Pattern 1: specific download button
    dl = re.search(
        r'<a[^>]*href="(https://dl\.snapcdn\.app/download\?token=[^"]+)"[^>]*class="[^"]*download-link-fb[^"]*"[^>]*>',
        data_html
    )
    if dl:
        video_url = dl.group(1).replace("&amp;", "&")
        return {"video": video_url, "title": "Facebook Video"}

    # Pattern 2: any snapcdn download link
    any_dl = re.search(
        r'<a[^>]*href="(https://dl\.snapcdn\.app/download\?token=[^"]+)"[^>]*>',
        data_html
    )
    if any_dl:
        video_url = any_dl.group(1).replace("&amp;", "&")
        return {"video": video_url, "title": "Facebook Video"}

    # Pattern 3: any direct video URL
    direct = re.search(r'href="(https?://[^"]+\.mp4[^"]*)"', data_html)
    if direct:
        video_url = direct.group(1).replace("&amp;", "&")
        return {"video": video_url, "title": "Facebook Video"}

    raise RuntimeError("Tidak ditemukan link download Facebook")


async def fb_download(url: str, progress_cb=None) -> dict:
    """
    Download Facebook video.
    Returns: {"filepath": str, "title": str}
    """
    ensure_temp_dir()

    info = await get_facebook(url)
    video_url = info["video"]
    title = info.get("title", "Facebook Video")

    safe_title = sanitize_filename(title) or "fb_video"
    filepath = os.path.join(TEMP_DIR, f"{safe_title}_{os.getpid()}.mp4")

    async with aiohttp.ClientSession() as session:
        async with session.get(video_url, headers={"User-Agent": UA},
                               timeout=aiohttp.ClientTimeout(total=300),
                               allow_redirects=True) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            if total > MAX_FILE_SIZE:
                raise ValueError(f"File terlalu besar ({total // (1024*1024)}MB), batas {MAX_FILE_SIZE // (1024*1024)}MB")

            downloaded = 0
            with open(filepath, "wb") as f:
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_cb and total > 0:
                        await progress_cb(downloaded, total)

    return {"filepath": filepath, "title": title}

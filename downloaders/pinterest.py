"""Pinterest downloader — resolve pin.it short links, extract media."""
import re
import os
import uuid
import aiohttp
from config import TEMP_DIR, MAX_FILE_SIZE
from utils.cleanup import ensure_temp_dir

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

PINTEREST_RE = re.compile(
    r'https?://(www\.)?(pinterest\.(com|co\.\w+|ca|fr|de|it|es|co\.uk)|pin\.it)/',
    re.IGNORECASE,
)


def is_pinterest_url(url: str) -> bool:
    return bool(PINTEREST_RE.match(url.strip()))


async def _resolve_short(url: str) -> str:
    """Follow redirects for pin.it short links."""
    async with aiohttp.ClientSession() as s:
        async with s.head(url, allow_redirects=True, headers={"User-Agent": UA},
                          timeout=aiohttp.ClientTimeout(total=15)) as r:
            return str(r.url)


async def download_pinterest(url: str, progress_cb=None) -> dict:
    ensure_temp_dir()

    if "pin.it/" in url:
        url = await _resolve_short(url)

    if progress_cb:
        await progress_cb(10, 100)

    headers = {"User-Agent": UA}
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Gagal memuat halaman Pinterest: HTTP {resp.status}")
            html = await resp.text()

    if progress_cb:
        await progress_cb(30, 100)

    # Try to find video first
    video_url = None
    video_patterns = [
        r'"url":"(https://v1?\.pinimg\.com/videos/[^"]+\.mp4)"',
        r'"video_url":"(https?://[^"]+\.mp4[^"]*)"',
        r'<video[^>]+src="(https?://[^"]+\.mp4[^"]*)"',
    ]
    for pat in video_patterns:
        m = re.search(pat, html)
        if m:
            video_url = m.group(1).replace("\\u002F", "/").replace("\\/", "/")
            break

    # Find image
    image_url = None
    img_patterns = [
        r'"url":"(https://i\.pinimg\.com/originals/[^"]+)"',
        r'"url":"(https://i\.pinimg\.com/736x/[^"]+)"',
        r'<img[^>]+src="(https://i\.pinimg\.com/[^"]+)"',
        r'"image_url":"(https?://[^"]+)"',
    ]
    for pat in img_patterns:
        m = re.search(pat, html)
        if m:
            image_url = m.group(1).replace("\\u002F", "/").replace("\\/", "/")
            break

    media_url = video_url or image_url
    if not media_url:
        raise RuntimeError("Media tidak ditemukan di halaman Pinterest")

    is_video = video_url is not None
    ext = ".mp4" if is_video else ".jpg"
    filepath = os.path.join(TEMP_DIR, f"pin_{uuid.uuid4().hex[:8]}{ext}")

    if progress_cb:
        await progress_cb(50, 100)

    async with aiohttp.ClientSession() as session:
        async with session.get(media_url, headers=headers,
                               timeout=aiohttp.ClientTimeout(total=120)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"Gagal download media: HTTP {resp.status}")
            total = int(resp.headers.get("Content-Length", 0))
            if total > MAX_FILE_SIZE:
                raise RuntimeError(f"File terlalu besar: {total/(1024*1024):.1f}MB")
            with open(filepath, "wb") as f:
                dl = 0
                async for chunk in resp.content.iter_chunked(512 * 1024):
                    f.write(chunk)
                    dl += len(chunk)
                    if progress_cb and total:
                        await progress_cb(50 + int(dl / total * 45), 100)

    return {"filepath": filepath, "is_video": is_video}

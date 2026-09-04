"""YouTube search plus resilient yt-dlp audio/video downloads."""
import asyncio
import json
import os
import re
import uuid
from urllib.parse import parse_qs, quote, urlparse

import aiohttp

from config import MAX_FILE_SIZE, REQUEST_TIMEOUT, TEMP_DIR
from downloaders.ytdlp_engine import YTDLPDownloadError, run_ytdlp, validate_download
from utils.cleanup import cleanup_file, ensure_temp_dir
from utils.helpers import clean_title, sanitize_filename

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"


def get_video_id(url: str) -> str:
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.lstrip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            video_id = parsed.path.split("/")[2]
        else:
            video_id = (parse_qs(parsed.query).get("v") or [""])[0]
    else:
        video_id = ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Bukan URL YouTube yang valid")
    return video_id


async def _download_thumbnail(url: str, path: str) -> str | None:
    if not url:
        return None
    timeout = aiohttp.ClientTimeout(total=20, connect=8, sock_read=12)
    try:
        async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": UA}) as session:
            async with session.get(url, allow_redirects=True) as response:
                if response.status != 200:
                    return None
                content_length = int(response.headers.get("Content-Length", 0) or 0)
                if content_length > 5 * 1024 * 1024:
                    return None
                downloaded = 0
                with open(path, "wb") as output:
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        downloaded += len(chunk)
                        if downloaded > 5 * 1024 * 1024:
                            raise ValueError("Thumbnail terlalu besar")
                        output.write(chunk)
        return path if os.path.getsize(path) > 0 else None
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
        cleanup_file(path)
        return None


async def yt_download(url: str, fmt: str = "mp3", progress_cb=None, status_cb=None) -> dict:
    """Download validated media without blocking the event loop."""
    ensure_temp_dir()
    video_id = get_video_id(url)
    token = uuid.uuid4().hex[:8]
    prefix = os.path.join(TEMP_DIR, f"yt_{video_id}_{token}")
    output_template = f"{prefix}.%(ext)s"
    output_glob = f"{prefix}.*"

    if fmt == "mp3":
        extra_args = [
            "-f", "bestaudio/best",
            "-x", "--audio-format", "mp3", "--audio-quality", "2",
        ]
    elif fmt == "mp4":
        extra_args = [
            "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/best[height<=720]",
            "--merge-output-format", "mp4",
        ]
    else:
        raise ValueError("Format YouTube tidak didukung")

    try:
        info = await run_ytdlp(
            url,
            output_template,
            output_glob,
            extra_args=extra_args,
            timeout=360,
            attempts=3,
            progress_cb=progress_cb,
            status_cb=status_cb,
            expected_ext=fmt,
        )
        filepath = validate_download(info["filepath"], expected_ext=fmt)
        title = clean_title(info.get("title") or "video")
        artist = info.get("artist") or info.get("uploader") or info.get("channel") or ""
        thumb_path = await _download_thumbnail(
            info.get("thumbnail", ""), os.path.join(TEMP_DIR, f"thumb_{video_id}_{token}.jpg")
        )

        if fmt == "mp3":
            try:
                from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TIT2, TPE1
                from mutagen.mp3 import MP3

                try:
                    audio = MP3(filepath, ID3=ID3)
                except ID3NoHeaderError:
                    audio = MP3(filepath)
                    audio.add_tags()
                if audio.tags is None:
                    audio.add_tags()
                audio.tags.add(TIT2(encoding=3, text=[title]))
                if artist:
                    audio.tags.add(TPE1(encoding=3, text=[artist]))
                if thumb_path:
                    with open(thumb_path, "rb") as image:
                        audio.tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=image.read()))
                audio.save()
                validate_download(filepath, expected_ext="mp3")
            except ImportError:
                pass
            except Exception as exc:
                raise YTDLPDownloadError("POSTPROCESS", f"Metadata MP3 gagal: {exc}") from exc

        return {
            "filepath": filepath,
            "title": title,
            "artist": artist,
            "thumbnail": thumb_path,
            "format": fmt,
            "video_id": video_id,
        }
    except BaseException:
        for path in [p for p in __import__("glob").glob(output_glob) if os.path.isfile(p)]:
            cleanup_file(path)
        raise


async def yt_search(query: str, limit: int = 10) -> list:
    """Search YouTube without downloading media."""
    encoded = quote(query)
    url = f"https://www.youtube.com/results?search_query={encoded}"
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT, connect=15, sock_read=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            url,
            headers={"Accept-Language": "en-US,en;q=0.9", "User-Agent": UA},
            allow_redirects=True,
        ) as response:
            response.raise_for_status()
            html = await response.text()

    match = re.search(r"ytInitialData\s*=\s*(\{.*?\});</script>", html, re.DOTALL)
    if not match:
        raise RuntimeError("Gagal mengambil data pencarian YouTube")
    data = json.loads(match.group(1))
    results = []
    contents = (data.get("contents", {}).get("twoColumnSearchResultsRenderer", {})
                .get("primaryContents", {}).get("sectionListRenderer", {}).get("contents", []))
    for section in contents:
        for item in section.get("itemSectionRenderer", {}).get("contents", []):
            video = item.get("videoRenderer")
            if not video:
                continue
            video_id = video.get("videoId", "")
            title = "".join(run.get("text", "") for run in video.get("title", {}).get("runs", []))
            owner = video.get("ownerText", {}).get("runs", [])
            views = video.get("viewCountText", {}).get("simpleText", "")
            if not views:
                views = "".join(run.get("text", "") for run in video.get("viewCountText", {}).get("runs", []))
            thumbnails = video.get("thumbnail", {}).get("thumbnails", [])
            results.append({
                "id": video_id,
                "title": title,
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "channel": owner[0].get("text", "") if owner else "",
                "duration": video.get("lengthText", {}).get("simpleText", ""),
                "views": views,
                "published": video.get("publishedTimeText", {}).get("simpleText", ""),
                "thumbnail": thumbnails[-1].get("url", "") if thumbnails else "",
            })
            if len(results) >= limit:
                return results
    return results

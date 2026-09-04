"""Spotify downloader - get metadata from Spotify, audio from yt-dlp"""
import re
import os
import asyncio
import aiohttp
import json
import uuid
from config import TEMP_DIR
from downloaders.ytdlp_engine import run_ytdlp, validate_download
from utils.helpers import sanitize_filename
from utils.cleanup import cleanup_file, ensure_temp_dir

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
SPOTIFY_TRACK_RE = re.compile(r'https?://open\.spotify\.com/track/([a-zA-Z0-9]+)')


def extract_track_id(url: str) -> str:
    url = url.split("?")[0]
    m = SPOTIFY_TRACK_RE.search(url.strip())
    if not m:
        raise ValueError("Bukan URL Spotify track yang valid")
    return m.group(1)


async def get_spotify_metadata(track_id: str) -> dict:
    """Get track metadata from Spotify oembed + embed page."""
    url = f"https://open.spotify.com/oembed?url=https://open.spotify.com/track/{track_id}"
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers={"User-Agent": UA},
                               timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status != 200:
                raise RuntimeError("Gagal mengambil metadata Spotify")
            data = await resp.json(content_type=None)

    full_title = data.get("title", "")
    title = full_title
    artist = data.get("author_name", "")
    album = ""

    embed_url = f"https://open.spotify.com/embed/track/{track_id}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(embed_url, headers={"User-Agent": UA},
                                   timeout=aiohttp.ClientTimeout(total=30)) as resp:
                html = await resp.text()

        script_match = re.search(r'<script\s+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if script_match:
            try:
                next_data = json.loads(script_match.group(1))
                track_data = next_data.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})
                if track_data:
                    title = track_data.get("name", title)
                    artists = track_data.get("artists", [])
                    if artists:
                        artist = ", ".join(a.get("name", "") for a in artists)
                    album = track_data.get("albumName", "")
            except (json.JSONDecodeError, KeyError, TypeError):
                pass

        if not artist or artist == title:
            meta_match = re.search(r'<meta\s+name="description"\s+content="([^"]+)"', html)
            if meta_match:
                parts = meta_match.group(1).split(" · ")
                if len(parts) >= 2:
                    dot_split = parts[0].split(". ")
                    if len(dot_split) >= 2:
                        artist = dot_split[-1].strip()
    except Exception:
        pass

    if not title:
        title = full_title

    return {
        "title": title,
        "artist": artist or "",
        "album": album,
        "track_id": track_id,
        "thumbnail": data.get("thumbnail_url", ""),
    }


async def download_spotify(url: str, progress_cb=None, status_cb=None) -> dict:
    ensure_temp_dir()

    track_id = extract_track_id(url)

    if progress_cb:
        await progress_cb(5, 100)

    meta = await get_spotify_metadata(track_id)
    title = meta["title"]
    artist = meta["artist"]
    album = meta["album"]

    if progress_cb:
        await progress_cb(15, 100)

    search_query = f"{title} {artist} audio"
    safe_name = sanitize_filename(f"{artist} - {title}") or f"spotify_{track_id}"
    prefix = os.path.join(TEMP_DIR, f"{safe_name}_{uuid.uuid4().hex[:8]}")
    out_template = f"{prefix}.%(ext)s"
    output_glob = f"{prefix}.*"

    if progress_cb:
        await progress_cb(25, 100)

    try:
        info = await run_ytdlp(
            f"ytsearch1:{search_query}",
            out_template,
            output_glob,
            extra_args=["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "2"],
            timeout=300,
            attempts=3,
            progress_cb=progress_cb,
            status_cb=status_cb,
            expected_ext="mp3",
        )
        filepath = validate_download(info["filepath"], expected_ext="mp3")
    except BaseException:
        import glob
        for partial in glob.glob(output_glob):
            cleanup_file(partial)
        raise

    if progress_cb:
        await progress_cb(75, 100)

    # Add metadata with mutagen
    if filepath.endswith(".mp3"):
        try:
            from mutagen.mp3 import MP3
            from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, ID3NoHeaderError

            try:
                audio = MP3(filepath, ID3=ID3)
            except ID3NoHeaderError:
                audio = MP3(filepath)
                audio.add_tags()

            if audio.tags is None:
                audio.add_tags()

            audio.tags.add(TIT2(encoding=3, text=[title]))
            audio.tags.add(TPE1(encoding=3, text=[artist]))
            if album:
                audio.tags.add(TALB(encoding=3, text=[album]))

            if meta.get("thumbnail"):
                try:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(meta["thumbnail"],
                                               timeout=aiohttp.ClientTimeout(total=15)) as resp:
                            if resp.status == 200:
                                img_data = await resp.read()
                                audio.tags.add(APIC(
                                    encoding=3, mime="image/jpeg",
                                    type=3, desc="Cover", data=img_data,
                                ))
                except Exception:
                    pass

            audio.save()
        except ImportError:
            pass
        except Exception:
            pass

    if progress_cb:
        await progress_cb(95, 100)

    return {
        "filepath": filepath,
        "title": title,
        "artist": artist,
        "album": album,
        "thumbnail": meta.get("thumbnail", ""),
    }

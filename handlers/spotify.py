import os
import aiohttp
from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown,
)
from telethon.tl.types import DocumentAttributeAudio
from downloaders.spotify import download_spotify
from utils.helpers import is_spotify_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file
from config import TEMP_DIR


def register(client):

    @client.on(events.NewMessage(pattern=r"^\.spotify\s+(.+)", outgoing=True))
    async def spotify_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_spotify_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL Spotify track.")
            return

        await edit_markdown(event, "⏳ Memproses download... 0%")
        filepath = None

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Memproses download")

            async def retry_status(stage, attempt, attempts, detail):
                await edit_markdown(
                    event,
                    format_message(
                        "🔄 Mencoba Ulang",
                        f"Tahap: `{stage}`\nPercobaan: `{attempt}/{attempts}`",
                    ),
                )

            result = await download_spotify(url, progress_cb=prog, status_cb=retry_status)
            filepath = result["filepath"]

            title = result['title']
            artist = result.get('artist', '') or 'Tidak diketahui'
            album = result.get('album', '')

            details = [
                f"**Judul:** {escape_markdown(title)}",
                f"**Artis:** {escape_markdown(artist)}",
            ]
            if album:
                details.append(f"**Album:** {escape_markdown(album)}")
            caption = format_message("🎧 Spotify Audio", details=details)

            # Download thumbnail for Telegram thumb
            thumb_path = None
            thumb_url = result.get('thumbnail', '')
            if thumb_url:
                try:
                    thumb_path = os.path.join(TEMP_DIR, f"sthumb_{os.getpid()}.jpg")
                    async with aiohttp.ClientSession() as s:
                        async with s.get(thumb_url, timeout=aiohttp.ClientTimeout(total=15)) as tr:
                            if tr.status == 200:
                                with open(thumb_path, "wb") as tf:
                                    tf.write(await tr.read())
                            else:
                                thumb_path = None
                except Exception:
                    thumb_path = None

            attrs = [DocumentAttributeAudio(
                duration=0,
                title=title,
                performer=artist,
            )]

            thumb_file = thumb_path if (thumb_path and os.path.exists(thumb_path)) else None

            await edit_markdown(event, "📤 Mengirim audio...")
            try:
                await send_file_markdown(client, 
                    event.chat_id,
                    filepath,
                    caption=caption,
                    voice=False,
                    attributes=attrs,
                    thumb=thumb_file,
                )
            finally:
                if thumb_file:
                    cleanup_file(thumb_file)

            await edit_markdown(event, "✅ Download selesai!")

        except Exception as e:
            await edit_markdown(event, error_message(e))
        finally:
            clear_progress(event.id)
            if filepath:
                cleanup_file(filepath)

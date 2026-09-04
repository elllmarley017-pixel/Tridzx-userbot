from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown,
)
import os
import traceback
from downloaders.tiktok import download_tiktok_video, is_tiktok_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file
from utils.helpers import format_duration


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.tt\s+(.+)", outgoing=True))
    async def tt_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_tiktok_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL TikTok.")
            return

        await edit_markdown(event, "⏳ Memproses URL TikTok...")
        filepath = None

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Downloading TikTok")

            result = await download_tiktok_video(url, progress_cb=prog)

            if result.get("type") == "photo":
                await edit_markdown(event, "ℹ️ Konten ini adalah foto/slide. Gunakan `.ttpic <link>` untuk download foto.")
                return

            filepath = result["filepath"]
            creator = result.get("creator", "")
            caption_text = result.get("caption", "")
            duration = result.get("duration", 0)

            details = []
            if creator:
                details.append(f"**Kreator:** {escape_markdown(creator)}")
            if caption_text:
                short = caption_text[:200] + ("..." if len(caption_text) > 200 else "")
                details.append(f"**Caption:** {escape_markdown(short)}")
            if duration:
                details.append(f"**Durasi:** `{format_duration(duration)}`")
            cap = format_message("🎵 TikTok Video", details=details)

            await edit_markdown(event, "📤 Mengirim video...")
            await send_file_markdown(client, 
                event.chat_id,
                filepath,
                caption=cap,
                supports_streaming=True,
            )
            await edit_markdown(event, "✅ Download selesai!")

        except Exception as e:
            await edit_markdown(event, error_message(e))
            print(traceback.format_exc())
        finally:
            clear_progress(event.id)
            if filepath:
                cleanup_file(filepath)

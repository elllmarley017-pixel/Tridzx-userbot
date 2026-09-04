from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown,
)
import os
import traceback
from downloaders.mediafire import download_mediafire, is_mediafire_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.mediafire\s+(.+)", outgoing=True))
    async def mediafire_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_mediafire_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL MediaFire.")
            return

        await edit_markdown(event, "⏳ Memproses URL MediaFire...")
        filepath = None

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Downloading MediaFire")

            result = await download_mediafire(url, progress_cb=prog)
            filepath = result["filepath"]
            filename = result["filename"]
            size = result["size"]

            size_str = f"{size/(1024*1024):.1f}MB" if size > 1024*1024 else f"{size/1024:.1f}KB"

            await edit_markdown(event, "📤 Mengirim file...")
            await send_file_markdown(client, 
                event.chat_id,
                filepath,
                caption=format_message(
                    "📁 MediaFire File",
                    details=[f"**Nama:** {escape_markdown(filename)}", f"**Ukuran:** `{size_str}`"],
                ),
                force_document=True,
            )
            await edit_markdown(event, "✅ Download selesai!")

        except Exception as e:
            await edit_markdown(event, error_message(e))
            print(traceback.format_exc())
        finally:
            clear_progress(event.id)
            if filepath:
                cleanup_file(filepath)

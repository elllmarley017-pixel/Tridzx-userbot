from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, error_message,
)
import os
import traceback
from downloaders.pinterest import download_pinterest, is_pinterest_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.pin\s+(.+)", outgoing=True))
    async def pin_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_pinterest_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL Pinterest.")
            return

        await edit_markdown(event, "⏳ Memproses URL Pinterest...")
        filepath = None

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Downloading Pinterest")

            result = await download_pinterest(url, progress_cb=prog)
            filepath = result["filepath"]

            await edit_markdown(event, "📤 Mengirim media...")
            await send_file_markdown(client, 
                event.chat_id,
                filepath,
                caption="📌 **Pinterest Download**",
                supports_streaming=result["is_video"],
            )
            await edit_markdown(event, "✅ Download selesai!")

        except Exception as e:
            await edit_markdown(event, error_message(e))
            print(traceback.format_exc())
        finally:
            clear_progress(event.id)
            if filepath:
                cleanup_file(filepath)

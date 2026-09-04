from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown,
)
from downloaders.facebook import fb_download, is_facebook_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file


def register(client):

    @client.on(events.NewMessage(pattern=r"^\.fb\s+(.+)", outgoing=True))
    async def fb_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_facebook_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL Facebook.")
            return

        await edit_markdown(event, "⏳ Memproses download... 0%")
        filepath = None

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Memproses download")

            result = await fb_download(url, progress_cb=prog)
            filepath = result["filepath"]

            await edit_markdown(event, "📤 Mengirim video...")
            await send_file_markdown(client, 
                event.chat_id,
                filepath,
                caption=format_message("📘 Facebook Video", escape_markdown(result["title"])),
                supports_streaming=True,
            )
            await edit_markdown(event, "✅ Download selesai!")

        except Exception as e:
            await edit_markdown(event, error_message(e))
        finally:
            clear_progress(event.id)
            if filepath:
                cleanup_file(filepath)

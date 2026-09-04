from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, inline_code,
)
import os
import traceback
from downloaders.videy import download_videy
from utils.progress import progress_callback
import functools

def register(client):
    @client.on(events.NewMessage(pattern=r"^\.videy\s+(.+)", outgoing=True))
    async def handle_videy(event):
        url = event.pattern_match.group(1).strip()
        
        msg = await edit_markdown(event, format_message("⏳ Memproses Videy", inline_code(url)))
        filepath = None
        
        try:
            progress_cb = functools.partial(progress_callback, msg, action="Downloading Videy Video")
            filepath = await download_videy(url, progress_cb=progress_cb)
            
            await edit_markdown(msg, "⬆️ **Mengupload video...**")
            await send_file_markdown(client, 
                event.chat_id,
                file=filepath,
                caption="🎬 **Videy Download**",
                reply_to=event.reply_to_msg_id
            )
            await msg.delete()
            
        except Exception as e:
            error_text = str(e)
            if len(error_text) > 900:
                error_text = error_text[:900] + "..."
            await edit_markdown(msg, error_message(error_text, "Videy Gagal"))
            print(traceback.format_exc())
            
        finally:
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except:
                    pass

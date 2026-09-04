from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown,
)
import asyncio
import aiohttp
from downloaders.tiktok import TikTokResolveError, download_tiktok_photos, is_tiktok_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.ttpic\s+(.+)", outgoing=True))
    async def ttpic_handler(event):
        url = event.pattern_match.group(1).strip()
        if not is_tiktok_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL TikTok.")
            return

        await edit_markdown(event, "⏳ Memproses foto TikTok...")
        filepaths = []

        try:
            async def prog(current, total):
                await progress_callback(event, current, total, "Downloading TikTok Photos")

            result = await download_tiktok_photos(url, progress_cb=prog)

            if result.get("type") == "video":
                await edit_markdown(
                    event,
                    format_message(
                        "❌ Bukan TikTok Photo/Slide",
                        "Link tersebut mengarah ke video TikTok.",
                        note="Gunakan `.tt <link>` untuk mengunduh video.",
                    ),
                )
                return

            filepaths = result.get("filepaths", [])
            if not filepaths:
                await edit_markdown(event, "❌ Tidak ada foto yang ditemukan.")
                return

            creator = result.get("creator", "")
            caption_text = result.get("caption", "")

            details = [
                f"**🖼️ Total Foto:** `{len(filepaths)}`",
                "**📦 Status:** Download selesai",
            ]
            if creator:
                details.append(f"**Kreator:** {escape_markdown(creator)}")
            if caption_text:
                short = caption_text[:200] + ("..." if len(caption_text) > 200 else "")
                details.append(f"**Caption:** {escape_markdown(short)}")
            cap = format_message("📸 TikTok Photo Berhasil Diproses", details=details)

            await edit_markdown(event, f"📤 Mengirim {len(filepaths)} foto...")

            # Send as album (max 10 per group)
            for i in range(0, len(filepaths), 10):
                batch = filepaths[i:i + 10]
                batch_cap = cap if i == 0 else ""
                await send_file_markdown(client, 
                    event.chat_id,
                    batch,
                    caption=batch_cap,
                )

            await edit_markdown(
                event,
                format_message(
                    "📸 TikTok Photo Berhasil Diproses",
                    details=[
                        f"**🖼️ Total Foto:** `{len(filepaths)}`",
                        "**📦 Status:** Download selesai",
                    ],
                ),
            )

        except TikTokResolveError:
            await edit_markdown(
                event,
                format_message(
                    "❌ Gagal Mengakses Link TikTok",
                    "Kemungkinan penyebab:",
                    details=[
                        "Link sudah tidak valid",
                        "TikTok tidak merespons",
                        "Koneksi ke TikTok timeout",
                        "URL tidak dapat di-resolve",
                    ],
                    footer="Silakan coba lagi beberapa saat kemudian.",
                ),
            )
        except (asyncio.TimeoutError, aiohttp.ClientError):
            await edit_markdown(
                event,
                error_message(
                    "Koneksi ke TikTok timeout atau sedang bermasalah. Silakan coba lagi beberapa saat kemudian.",
                    "TikTok Tidak Dapat Diakses",
                ),
            )
        except Exception as exc:
            message = str(exc).strip() or "TikTok Photo/Slide gagal diproses"
            await edit_markdown(event, error_message(message, "TikTok Photo Gagal"))
        finally:
            clear_progress(event.id)
            for fp in filepaths:
                cleanup_file(fp)

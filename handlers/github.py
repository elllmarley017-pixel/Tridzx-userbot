from telethon import events
from telethon.tl.types import DocumentAttributeFilename

from downloaders.github import GitHubDownloadError, download_github, parse_github_url
from utils.cleanup import cleanup_file
from utils.formatting import (
    edit_markdown,
    error_message,
    escape_markdown,
    format_message,
    send_file_markdown,
)
from utils.progress import clear_progress, progress_callback


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.github(?:\s+(.+))?$", outgoing=True))
    async def github_handler(event):
        url = (event.pattern_match.group(1) or "").strip()
        if not url:
            await edit_markdown(
                event,
                format_message(
                    "❌ URL GitHub Diperlukan",
                    example=".github https://github.com/username/repository",
                ),
            )
            return

        try:
            parse_github_url(url)
        except GitHubDownloadError as exc:
            await edit_markdown(event, error_message(exc, "URL GitHub Tidak Valid"))
            return

        await edit_markdown(event, "⏳ Sedang mengambil repository...")
        filepath = None

        try:
            async def progress(current, total):
                await progress_callback(event, current, total, "Mengambil repository")

            async def status(stage):
                if stage == "zip":
                    await edit_markdown(event, "📦 Sedang membuat ZIP...")

            result = await download_github(url, progress_cb=progress, status_cb=status)
            filepath = result["filepath"]
            size_mb = result["size"] / 1024 / 1024

            await edit_markdown(event, "📤 Sedang mengirim ZIP...")
            details = [
                f"**Repository:** {escape_markdown(result['owner'])}/{escape_markdown(result['repo'])}",
                f"**Branch:** `{escape_markdown(result['branch'])}`",
                f"**Ukuran:** `{size_mb:.2f} MB`",
            ]
            if result["folder"]:
                details.insert(2, f"**Path:** `{escape_markdown(result['folder'])}`")

            await send_file_markdown(
                client,
                event.chat_id,
                filepath,
                caption=format_message("📦 GitHub Repository", details=details),
                attributes=[DocumentAttributeFilename(result["filename"])],
                force_document=True,
            )
            await edit_markdown(event, "✅ GitHub berhasil diproses.")

        except GitHubDownloadError as exc:
            await edit_markdown(event, error_message(exc, "GitHub Gagal Diproses"))
        except Exception:
            await edit_markdown(
                event,
                error_message("Terjadi kesalahan internal saat memproses repository", "GitHub Gagal Diproses"),
            )
        finally:
            clear_progress(event.id)
            cleanup_file(filepath)

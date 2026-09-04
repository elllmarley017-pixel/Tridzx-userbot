import os
from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, status_message, error_message, escape_markdown, inline_code, markdown_link,
)
from telethon.tl.types import DocumentAttributeAudio
from downloaders.youtube import yt_search, yt_download
from downloaders.ytdlp_engine import YTDLPDownloadError, validate_download
from utils.helpers import is_youtube_url
from utils.progress import progress_callback, clear_progress
from utils.cleanup import cleanup_file
from utils.activity_logging import mark_activity_failed
from utils.download_logging import log_download


async def _user_label(event):
    try:
        sender = await event.get_sender()
        return f"@{sender.username}" if getattr(sender, "username", None) else str(event.sender_id)
    except Exception:
        return str(event.sender_id)


def _failure_message(stage: str, detail: str) -> str:
    labels = {
        "EXTRACTION": "Extraction Gagal",
        "DOWNLOAD": "Download Gagal",
        "POSTPROCESS": "FFmpeg/Post-processing Gagal",
        "FILE_OUTPUT": "File Output Gagal",
        "FILE_VALIDATION": "Validasi File Gagal",
        "TELEGRAM_UPLOAD": "Upload Gagal",
    }
    title = labels.get(stage, "Download Gagal")
    body = detail[:500] if detail else "Terjadi kesalahan tanpa detail."
    if stage == "TELEGRAM_UPLOAD":
        body = f"File berhasil di-download, tetapi gagal dikirim ke Telegram.\n\nPenyebab: {body}"
    return error_message(body, title)


def register(client):

    @client.on(events.NewMessage(pattern=r"^\.ytsearch\s+(.+)", outgoing=True))
    async def ytsearch_handler(event):
        query = event.pattern_match.group(1).strip()
        if not query:
            await edit_markdown(event, "❌ Masukkan kata kunci pencarian.")
            return

        await edit_markdown(event, status_message(f"Mencari {inline_code(query)}"))

        try:
            results = await yt_search(query, limit=7)
        except Exception as e:
            await edit_markdown(event, error_message(e, "Pencarian Gagal"))
            return

        if not results:
            await edit_markdown(event, "❌ Tidak ditemukan hasil.")
            return

        lines = []
        for i, r in enumerate(results, 1):
            lines.append(
                f"**{i}.** {markdown_link(r['title'], r['url'])}\n"
                f"   • 👤 {escape_markdown(r['channel'])}\n"
                f"   • ⏱ `{escape_markdown(r['duration'])}` · 👁 `{escape_markdown(r['views'])}`"
            )

        text = format_message(
            "🔎 Hasil Pencarian YouTube",
            f"Kata kunci: {inline_code(query)}",
            details=lines,
        )
        # Telegram message limit ~4096 chars
        if len(text) > 4000:
            text = text[:4000] + "\n..."

        await edit_markdown(event, text, link_preview=False)

    async def handle_download(event, fmt: str):
        url = event.pattern_match.group(1).strip()
        feature = f".ytmp{3 if fmt == 'mp3' else 4}"
        if not is_youtube_url(url):
            await edit_markdown(event, "❌ URL tidak valid. Masukkan URL YouTube.")
            return

        user = await _user_label(event)
        filepath = None
        thumb_path = None
        stage = "EXTRACTION"
        last_progress = -1
        await edit_markdown(event, "⏳ Downloading... 0%")
        log_download(user, feature, "DOWNLOADING", url=url, stage=stage, progress="0%")

        try:
            async def prog(current, total):
                nonlocal last_progress
                pct = int(current / total * 100) if total else 0
                await progress_callback(event, current, total, "Downloading")
                if pct // 10 != last_progress // 10:
                    last_progress = pct
                    log_download(user, feature, "DOWNLOADING", url=url, stage="DOWNLOAD", progress=f"{pct}%")

            async def retry_status(retry_stage, attempt, attempts, detail):
                log_download(user, feature, "RETRYING", url=url, stage=retry_stage,
                             progress=f"attempt {attempt}/{attempts}", error=detail)
                await edit_markdown(event, format_message(
                    "🔄 Mencoba Ulang",
                    f"Tahap: `{retry_stage}`\nPercobaan: `{attempt}/{attempts}`",
                ))

            result = await yt_download(url, fmt=fmt, progress_cb=prog, status_cb=retry_status)
            filepath = validate_download(result["filepath"], expected_ext=fmt)
            thumb_path = result.get("thumbnail")
            size = os.path.getsize(filepath)
            stage = "TELEGRAM_UPLOAD"
            await edit_markdown(event, "⬇️ Download selesai\n\n🎵 Processing audio...\n\n📦 Preparing file..." if fmt == "mp3" else "⬇️ Download selesai\n\n🎬 Processing video...\n\n📦 Preparing file...")
            log_download(user, feature, "DOWNLOADED", url=url, stage="FILE_VALIDATION",
                         progress="100%", file=filepath, size=size)

            try:
                if fmt == "mp3":
                    title = result["title"]
                    artist = result.get("artist") or "Tidak diketahui"
                    caption = format_message(
                        "🎵 YouTube Audio",
                        details=[f"**Judul:** {escape_markdown(title)}", f"**Artis:** {escape_markdown(artist)}"],
                    )
                    attrs = [DocumentAttributeAudio(duration=0, title=title, performer=artist)]
                    await send_file_markdown(
                        client, event.chat_id, filepath, caption=caption, voice=False,
                        attributes=attrs, thumb=thumb_path if thumb_path and os.path.exists(thumb_path) else None,
                    )
                else:
                    await send_file_markdown(
                        client, event.chat_id, filepath,
                        caption=format_message("🎬 YouTube Video", escape_markdown(result["title"])),
                        supports_streaming=True,
                    )
            except Exception as exc:
                raise YTDLPDownloadError("TELEGRAM_UPLOAD", str(exc)) from exc

            log_download(user, feature, "SUCCESS", url=url, stage="TELEGRAM_UPLOAD",
                         progress="100%", file=filepath, size=size)
            await edit_markdown(event, "✅ Download Selesai")

        except YTDLPDownloadError as exc:
            mark_activity_failed(f"{exc.stage}: {exc.detail}")
            log_download(user, feature, "FAILED", url=url, stage=exc.stage, error=exc.detail,
                         file=filepath or "-", size=os.path.getsize(filepath) if filepath and os.path.exists(filepath) else 0)
            await edit_markdown(event, _failure_message(exc.stage, exc.detail))
        except Exception as exc:
            detail = str(exc) or exc.__class__.__name__
            mark_activity_failed(f"{stage}: {detail}")
            log_download(user, feature, "FAILED", url=url, stage=stage, error=detail,
                         file=filepath or "-", size=os.path.getsize(filepath) if filepath and os.path.exists(filepath) else 0)
            await edit_markdown(event, _failure_message(stage, detail))
        finally:
            clear_progress(event.id)
            cleanup_file(filepath, thumb_path)

    @client.on(events.NewMessage(pattern=r"^\.ytmp3\s+(.+)", outgoing=True))
    async def ytmp3_handler(event):
        await handle_download(event, "mp3")

    @client.on(events.NewMessage(pattern=r"^\.ytmp4\s+(.+)", outgoing=True))
    async def ytmp4_handler(event):
        await handle_download(event, "mp4")

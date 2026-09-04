"""Asynchronous media converters: image, GIF, MP3, QR, voice note."""
import asyncio
import os
import uuid

from telethon import events
from telethon.tl.types import DocumentAttributeAudio, DocumentAttributeSticker, DocumentAttributeVideo

from config import MAX_FILE_SIZE, TEMP_DIR
from utils.activity_logging import mark_activity_failed
from utils.cleanup import cleanup_file, ensure_temp_dir
from utils.formatting import edit_markdown, error_message, status_message
from utils.formatting import send_file_markdown

CONVERT_TIMEOUT = 180
MAX_DURATION = 15 * 60
MAX_GIF_DURATION = 30
IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif"}
VIDEO_MIMES = {"video/mp4", "video/webm", "video/quicktime", "video/x-matroska"}
AUDIO_MIMES = {"audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/wav", "audio/flac", "audio/aac"}


def _mime(message) -> str:
    return getattr(getattr(message, "document", None), "mime_type", "") or ""


def _attributes(message):
    return getattr(getattr(message, "document", None), "attributes", []) or []


def _attribute(message, kind):
    return next((item for item in _attributes(message) if isinstance(item, kind)), None)


def _size(message) -> int:
    return getattr(getattr(message, "document", None), "size", 0) or 0


def _duration(message) -> float:
    attribute = _attribute(message, DocumentAttributeVideo) or _attribute(message, DocumentAttributeAudio)
    return float(getattr(attribute, "duration", 0) or 0)


def _is_image(message) -> bool:
    return bool(message and (message.photo or _mime(message) in IMAGE_MIMES))


def _is_video(message) -> bool:
    if not message:
        return False
    return bool(
        getattr(message, "video", None)
        or _mime(message).startswith("video/")
        or _mime(message) in VIDEO_MIMES
        or _attribute(message, DocumentAttributeVideo)
    )


def _is_audio(message) -> bool:
    if not message:
        return False
    return bool(
        getattr(message, "audio", None)
        or getattr(message, "voice", None)
        or _mime(message).startswith("audio/")
        or _mime(message) in AUDIO_MIMES
        or _attribute(message, DocumentAttributeAudio)
    )


def _sticker_kind(message) -> str | None:
    if not message or not getattr(message, "sticker", None):
        return None
    mime = _mime(message).lower()
    if mime == "application/x-tgsticker":
        return "tgs"
    if mime.startswith("video/") or mime == "video/webm":
        return "video"
    if mime in {"image/webp", "image/png", ""}:
        return "static"
    return None


def _validate_limits(message, max_duration: int = MAX_DURATION) -> None:
    if _size(message) > MAX_FILE_SIZE:
        raise RuntimeError(f"Media melebihi batas {MAX_FILE_SIZE // 1024 // 1024} MB")
    duration = _duration(message)
    if duration > max_duration:
        raise RuntimeError(f"Durasi media melebihi batas {max_duration // 60} menit")


async def _source(event, predicate, reply_only=False):
    """Prefer replied media, then inspect media attached to the command."""
    reply = await event.get_reply_message() if event.reply_to_msg_id else None
    if reply and predicate(reply):
        return reply
    if reply_only:
        return None
    return event.message if predicate(event.message) else None


async def _run(*command: str, timeout: int = CONVERT_TIMEOUT) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"Converter `{command[0]}` belum terpasang") from exc
    try:
        _, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise RuntimeError("Proses konversi timeout")
    if process.returncode:
        reason = stderr.decode(errors="replace").strip().splitlines()
        raise RuntimeError((reason[-1] if reason else "Converter gagal")[:200])


async def _download(client, message, path: str) -> str:
    downloaded = await asyncio.wait_for(client.download_media(message, file=path), timeout=CONVERT_TIMEOUT)
    if not downloaded or not os.path.isfile(downloaded):
        raise RuntimeError("Media gagal diunduh")
    return downloaded


async def _deliver(client, event, output: str, **kwargs) -> None:
    await send_file_markdown(client, event.chat_id, output, reply_to=event.reply_to_msg_id, **kwargs)
    if event.out:
        await event.delete()


async def _convert_job(client, event, source_message, suffix: str, convert, **send_kwargs):
    ensure_temp_dir()
    token = uuid.uuid4().hex
    source = os.path.join(TEMP_DIR, f"convert_{token}_source")
    output = os.path.join(TEMP_DIR, f"convert_{token}{suffix}")
    try:
        source = await _download(client, source_message, source)
        await convert(source, output)
        if not os.path.isfile(output) or os.path.getsize(output) == 0:
            raise RuntimeError("File hasil konversi kosong")
        await _deliver(client, event, output, **send_kwargs)
    finally:
        cleanup_file(source, output)


async def _to_png(source: str, output: str):
    await _run("ffmpeg", "-y", "-v", "error", "-i", source, "-frames:v", "1", output)


async def _to_gif(source: str, output: str):
    await _run(
        "ffmpeg", "-y", "-v", "error", "-i", source,
        "-t", str(MAX_GIF_DURATION), "-vf",
        "fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer",
        "-loop", "0", output,
    )


async def _tgs_to_gif(source: str, output: str):
    await _run("lottie_convert.py", source, output)


async def _to_mp3(source: str, output: str):
    await _run("ffmpeg", "-y", "-v", "error", "-i", source, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", output)


async def _to_voice(source: str, output: str):
    await _run(
        "ffmpeg", "-y", "-v", "error", "-i", source, "-vn", "-ac", "1", "-ar", "48000",
        "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", "-application", "voip", output,
    )


async def _text_to_qr(text: str, output: str):
    def generate():
        try:
            import qrcode
        except ImportError as exc:
            raise RuntimeError("Library QR Code belum terpasang") from exc
        image = qrcode.make(text)
        image.save(output)

    await asyncio.to_thread(generate)


async def _qr_job(client, event, text: str):
    ensure_temp_dir()
    output = os.path.join(TEMP_DIR, f"qr_{uuid.uuid4().hex}.png")
    try:
        await _text_to_qr(text, output)
        if not os.path.isfile(output) or os.path.getsize(output) == 0:
            raise RuntimeError("QR Code gagal dibuat")
        await _deliver(client, event, output, force_document=False)
    finally:
        cleanup_file(output)


def _failure_reason(exc: Exception) -> str:
    reason = str(exc).replace("\n", " ").strip()
    return reason[:200] or exc.__class__.__name__


async def _edit_failure(event, reason: str, title: str) -> None:
    await edit_markdown(event, error_message(reason, title))
    mark_activity_failed(reason)


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.toimg$", outgoing=True))
    async def toimg_handler(event):
        reply = await event.get_reply_message() if event.reply_to_msg_id else None
        kind = _sticker_kind(reply)
        if kind in {"tgs", "video"}:
            await _edit_failure(
                event, "Sticker animasi/video belum didukung oleh .toimg", "Format Belum Didukung"
            )
            return
        if kind != "static":
            await _edit_failure(event, "Reply bukan sticker statis", "Media Tidak Valid")
            return
        await edit_markdown(event, status_message("Processing...."))
        try:
            _validate_limits(reply)
            await _convert_job(client, event, reply, ".png", _to_png, force_document=False)
        except Exception as exc:
            await _edit_failure(event, _failure_reason(exc), "Conversion failed")

    @client.on(events.NewMessage(pattern=r"^\.togif$", outgoing=True))
    async def togif_handler(event):
        source = await _source(event, lambda message: _sticker_kind(message) in {"video", "tgs"}, reply_only=True)
        if not source:
            await edit_markdown(event, error_message("Reply ke sticker animasi/video dengan `.togif`", "Media Tidak Valid"))
            return
        await edit_markdown(event, status_message("Processing...."))
        try:
            _validate_limits(source, MAX_GIF_DURATION)
            convert = _tgs_to_gif if _sticker_kind(source) == "tgs" else _to_gif
            await _convert_job(client, event, source, ".gif", convert, force_document=False)
        except Exception as exc:
            await edit_markdown(event, error_message(_failure_reason(exc), "Conversion failed"))

    @client.on(events.NewMessage(pattern=r"^\.tomp3$", outgoing=True))
    async def tomp3_handler(event):
        source = await _source(event, lambda message: _is_video(message) or _is_audio(message))
        if not source:
            await _edit_failure(
                event,
                "Media bukan video, dokumen video, audio, atau voice note",
                "Media Tidak Valid",
            )
            return
        await edit_markdown(event, status_message("Processing...."))
        try:
            _validate_limits(source)
            await _convert_job(client, event, source, ".mp3", _to_mp3, force_document=False)
        except Exception as exc:
            await _edit_failure(event, _failure_reason(exc), "Conversion failed")

    @client.on(events.NewMessage(pattern=r"^\.toqr(?:\s+([\s\S]+))?$", outgoing=True))
    async def toqr_handler(event):
        text = (event.pattern_match.group(1) or "").strip()
        if not text:
            reply = await event.get_reply_message() if event.reply_to_msg_id else None
            text = (getattr(reply, "raw_text", None) or getattr(reply, "message", None) or "").strip()
        if not text:
            await _edit_failure(event, "Teks QR kosong", "Teks Tidak Valid")
            return
        await edit_markdown(event, status_message("Processing...."))
        try:
            await _qr_job(client, event, text)
        except Exception as exc:
            await _edit_failure(event, _failure_reason(exc), "Conversion failed")

    @client.on(events.NewMessage(pattern=r"^\.tovn$", outgoing=True))
    async def tovn_handler(event):
        source = await _source(event, lambda message: _is_audio(message) or _is_video(message))
        if not source:
            await edit_markdown(event, error_message("Reply audio/video atau kirim media dengan caption `.tovn`", "Media Tidak Valid"))
            return
        await edit_markdown(event, status_message("Processing...."))
        try:
            _validate_limits(source)
            await _convert_job(client, event, source, ".ogg", _to_voice, voice_note=True)
        except Exception as exc:
            await edit_markdown(event, error_message(_failure_reason(exc), "Conversion failed"))

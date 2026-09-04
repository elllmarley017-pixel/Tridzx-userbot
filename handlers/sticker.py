"""Image-to-Telegram-sticker converter commands: `.stiker` and photo caption `.s`."""
import asyncio
import os
import uuid

from telethon import events, functions, utils
from telethon.errors import PackShortNameOccupiedError, StickersetInvalidError
from telethon.tl.types import (
    DocumentAttributeFilename,
    DocumentAttributeSticker,
    InputMediaUploadedDocument,
    InputStickerSetEmpty,
    InputStickerSetItem,
    InputStickerSetShortName,
)

from config import TEMP_DIR
from utils.cleanup import cleanup_file, ensure_temp_dir
from utils.formatting import edit_markdown, error_message

STICKER_LIMIT = 512 * 1024
CONVERT_TIMEOUT = 60
STICKER_SET_SHORT_NAME = "tenzu_stick"
STICKER_SET_TITLE = "Tenzu Stick"
IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif"}


def _is_image(message) -> bool:
    if not message:
        return False
    if message.photo:
        return True
    document = message.document
    mime = getattr(document, "mime_type", "") if document else ""
    return mime in IMAGE_MIMES


async def _convert_sticker(source: str, output: str) -> None:
    """Create a static 512px WebP sticker, reducing quality until <=512 KiB."""
    last_error = ""
    for quality in (90, 82, 74, 66, 58, 50):
        command = [
            "ffmpeg", "-y", "-v", "error", "-i", source,
            "-vf", "scale=512:512:force_original_aspect_ratio=decrease",
            "-frames:v", "1", "-c:v", "libwebp", "-lossless", "0",
            "-quality", str(quality), "-compression_level", "6", output,
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), timeout=CONVERT_TIMEOUT)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            raise RuntimeError("Konversi sticker timeout")

        last_error = stderr.decode(errors="replace").strip()
        if process.returncode == 0 and os.path.exists(output):
            size = os.path.getsize(output)
            if 0 < size <= STICKER_LIMIT:
                return
        cleanup_file(output)

    raise RuntimeError(last_error[:300] or "Ukuran sticker melebihi batas Telegram")


async def _upload_sticker_document(client, event, output: str):
    uploaded = await client.upload_file(output, file_name="sticker.webp")
    media = await client(functions.messages.UploadMediaRequest(
        peer=await client.get_input_entity(event.chat_id),
        media=InputMediaUploadedDocument(
            file=uploaded,
            mime_type="image/webp",
            attributes=[
                DocumentAttributeFilename("sticker.webp"),
                DocumentAttributeSticker(alt="🖼️", stickerset=InputStickerSetEmpty()),
            ],
            force_file=False,
        ),
    ))
    document = getattr(media, "document", None)
    if not document:
        raise RuntimeError("Upload sticker ke Telegram gagal")
    return document


async def _get_sticker_set(client):
    return await client(functions.messages.GetStickerSetRequest(
        stickerset=InputStickerSetShortName(STICKER_SET_SHORT_NAME),
        hash=0,
    ))


async def _save_to_sticker_set(client, event, output: str):
    """Add to tenzu_stick, then return the actual pack-linked sticker."""
    uploaded_document = await _upload_sticker_document(client, event, output)
    sticker = InputStickerSetItem(
        document=utils.get_input_document(uploaded_document),
        emoji="🖼️",
    )
    sticker_set = InputStickerSetShortName(STICKER_SET_SHORT_NAME)
    try:
        await client(functions.stickers.AddStickerToSetRequest(
            stickerset=sticker_set,
            sticker=sticker,
        ))
    except StickersetInvalidError:
        me = await client.get_me()
        try:
            await client(functions.stickers.CreateStickerSetRequest(
                user_id=await client.get_input_entity(me),
                title=STICKER_SET_TITLE,
                short_name=STICKER_SET_SHORT_NAME,
                stickers=[sticker],
                software="telegram-userbot",
            ))
        except PackShortNameOccupiedError as exc:
            raise RuntimeError(
                "Sticker pack `tenzu_stick` bukan milik akun Telegram pada session ini"
            ) from exc

    try:
        result = await _get_sticker_set(client)
    except StickersetInvalidError as exc:
        raise RuntimeError("Sticker pack `tenzu_stick` gagal dibuat atau tidak dapat diakses") from exc

    documents = getattr(result, "documents", []) or []
    packed_document = next(
        (item for item in documents if item.id == uploaded_document.id),
        documents[-1] if documents else None,
    )
    if not packed_document:
        raise RuntimeError("Sticker tidak ditemukan di pack `tenzu_stick`")
    return packed_document


async def _make_sticker(client, event, source_message) -> None:
    ensure_temp_dir()
    job_id = uuid.uuid4().hex
    source = os.path.join(TEMP_DIR, f"sticker_{job_id}_source")
    output = os.path.join(TEMP_DIR, f"sticker_{job_id}.webp")

    try:
        downloaded = await asyncio.wait_for(
            client.download_media(source_message, file=source),
            timeout=CONVERT_TIMEOUT,
        )
        if not downloaded or not os.path.exists(downloaded):
            raise RuntimeError("Gambar gagal diunduh")
        source = downloaded

        await _convert_sticker(source, output)
        packed_document = await _save_to_sticker_set(client, event, output)
        await client.send_file(
            event.chat_id,
            packed_document,
            reply_to=event.reply_to_msg_id,
        )
        if event.out:
            await event.delete()
    finally:
        cleanup_file(source, output)


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.stiker$", outgoing=True))
    async def stiker_handler(event):
        reply = await event.get_reply_message() if event.is_reply else None
        if not _is_image(reply):
            await edit_markdown(event, "❌ Reply sebuah foto/gambar dengan command `.stiker`")
            return
        try:
            await _make_sticker(client, event, reply)
        except (asyncio.TimeoutError, OSError, RuntimeError) as exc:
            await edit_markdown(event, error_message(str(exc) or "Gagal membuat sticker pack."))
        except Exception as exc:
            await edit_markdown(event, error_message(str(exc) or "Gagal membuat sticker pack."))

    @client.on(events.NewMessage(pattern=r"^\.s$", outgoing=True))
    async def short_sticker_handler(event):
        reply = await event.get_reply_message() if event.is_reply else None
        source_message = event.message if _is_image(event.message) else reply
        if not _is_image(source_message):
            await edit_markdown(
                event,
                "❌ Reply foto/gambar dengan `.s`, atau kirim foto dengan caption `.s`.",
            )
            return
        try:
            await _make_sticker(client, event, source_message)
        except (asyncio.TimeoutError, OSError, RuntimeError) as exc:
            await edit_markdown(event, error_message(str(exc) or "Gagal membuat sticker pack."))
        except Exception as exc:
            await edit_markdown(event, error_message(str(exc) or "Gagal membuat sticker pack."))

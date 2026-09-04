"""Export accessible Telegram history for `.getchat <id/username>`."""
import asyncio
import os
import re
import time
from datetime import timezone

from telethon import events, types, utils
from telethon.errors import (
    ChannelPrivateError,
    ChatAdminRequiredError,
    FloodWaitError,
    RPCError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.types import DocumentAttributeFilename

from config import MAX_FILE_SIZE, TEMP_DIR
from utils.cleanup import cleanup_file, ensure_temp_dir
from utils.formatting import (
    edit_markdown,
    error_message,
    escape_markdown,
    format_message,
    send_file_markdown,
)
from utils.helpers import sanitize_filename

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
ITERATION_TIMEOUT = 60
OUTPUT_LIMIT = MAX_FILE_SIZE - (1024 * 1024)
PROGRESS_INTERVAL = 4


class GetChatError(RuntimeError):
    pass


class OutputTooLarge(GetChatError):
    pass


def _parse_target(raw: str) -> int | str:
    value = raw.strip()
    if not value:
        raise GetChatError("Masukkan Telegram ID atau username")
    if re.fullmatch(r"-?\d+", value):
        target_id = int(value)
        if target_id == 0:
            raise GetChatError("Telegram ID tidak valid")
        return target_id
    username = value.lstrip("@").strip()
    if not USERNAME_RE.fullmatch(username):
        raise GetChatError("Username harus 4–32 karakter dan hanya berisi huruf, angka, atau underscore")
    return username


def _entity_name(entity) -> str:
    if isinstance(entity, int):
        return str(entity)
    if isinstance(entity, types.User):
        return " ".join(filter(None, (entity.first_name, entity.last_name))) or entity.username or "Private Chat"
    return getattr(entity, "title", None) or getattr(entity, "username", None) or "Unknown Chat"


def _chat_type(entity) -> str:
    if isinstance(entity, int):
        return "User ID"
    if isinstance(entity, types.User):
        return "Bot" if entity.bot else "Private Chat"
    if isinstance(entity, types.Channel):
        return "Channel" if entity.broadcast else "Supergroup"
    if isinstance(entity, types.Chat):
        return "Group"
    return "Unknown"


def _marked_id(entity) -> int:
    if isinstance(entity, int):
        return entity
    try:
        return utils.get_peer_id(entity)
    except (TypeError, ValueError):
        return entity.id


def _message_link(entity, message_id: int) -> str:
    username = getattr(entity, "username", None)
    if username:
        return f"https://t.me/{username}/{message_id}"
    if isinstance(entity, types.Channel):
        channel_id = str(entity.id)
        return f"https://t.me/c/{channel_id}/{message_id}"
    return "Unavailable"


def _sender_name(sender) -> str:
    if sender is None:
        return "Unavailable"
    username = getattr(sender, "username", None)
    if username:
        return f"@{username}"
    return _entity_name(sender)


def _record(chat, message, sender) -> str:
    date = message.date
    if date and date.tzinfo:
        date = date.astimezone(timezone.utc).replace(tzinfo=None)
    date_text = date.strftime("%Y-%m-%d %H:%M:%S UTC") if date else "Unavailable"
    text = message.message or ""
    body_label = "Caption" if message.media and text else "Message"
    if not text:
        text = "[Media/non-text message]" if message.media else "[Empty message]"

    return (
        "--- MESSAGE ---\n"
        f"Message ID: {message.id}\n"
        f"Sender: {_sender_name(sender)}\n"
        f"Sender ID: {message.sender_id or 'Unavailable'}\n"
        f"Date: {date_text}\n"
        f"Link: {_message_link(chat, message.id)}\n\n"
        f"{body_label}:\n{text}\n\n"
        "========================================\n\n"
    )


def _chat_header(chat) -> str:
    return (
        "=== CHAT ===\n"
        f"Name: {_entity_name(chat)}\n"
        f"Type: {_chat_type(chat)}\n"
        f"Chat ID: {_marked_id(chat)}\n\n"
    )


def _safe_filename(raw: str) -> str:
    value = raw.strip().lstrip("@")
    safe = sanitize_filename(value, max_len=50).replace(" ", "_") or "target"
    return f"getchat_{safe}.txt"


async def _next(iterator):
    try:
        return await asyncio.wait_for(iterator.__anext__(), timeout=ITERATION_TIMEOUT)
    except StopAsyncIteration:
        return None
    except asyncio.TimeoutError as exc:
        raise GetChatError("Telegram timeout saat membaca riwayat pesan") from exc


async def _resolve_target(client, parsed: int | str, dialogs: list):
    if isinstance(parsed, str):
        try:
            return await asyncio.wait_for(client.get_entity(parsed), timeout=ITERATION_TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise GetChatError("Telegram timeout saat mencari username") from exc
        except (UsernameInvalidError, UsernameNotOccupiedError, ValueError) as exc:
            raise GetChatError("Username tidak ditemukan atau tidak dapat diakses") from exc

    for dialog in dialogs:
        entity = dialog.entity
        if parsed in {entity.id, _marked_id(entity)}:
            return entity
    try:
        return await asyncio.wait_for(client.get_entity(parsed), timeout=ITERATION_TIMEOUT)
    except asyncio.TimeoutError as exc:
        raise GetChatError("Telegram timeout saat mencari ID") from exc
    except (ValueError, RPCError):
        # Numeric user IDs cannot always be resolved without an access hash.
        # Keep the ID and scan accessible histories by sender_id instead.
        if parsed > 0:
            return parsed
        raise GetChatError("ID chat/channel tidak ditemukan pada dialog yang dapat diakses session")


async def _load_dialogs(client) -> list:
    dialogs = []
    iterator = client.iter_dialogs(limit=None).__aiter__()
    while True:
        dialog = await _next(iterator)
        if dialog is None:
            return dialogs
        dialogs.append(dialog)


async def _write_text(file, text: str, written: int) -> int:
    encoded = text.encode("utf-8", errors="replace")
    if written + len(encoded) > OUTPUT_LIMIT:
        raise OutputTooLarge(
            f"Hasil melebihi batas aman `{OUTPUT_LIMIT // 1024 // 1024} MB`; export dihentikan agar file dapat dikirim"
        )
    await asyncio.to_thread(file.write, encoded)
    return written + len(encoded)


async def _collect_history(client, target, dialogs, filepath: str, progress_cb) -> dict:
    is_resolved_user = isinstance(target, types.User)
    is_numeric_user = isinstance(target, int)
    search_all_dialogs = is_resolved_user or is_numeric_user
    candidates = dialogs if search_all_dialogs else [next((d for d in dialogs if d.entity.id == target.id), None)]
    if not search_all_dialogs and candidates[0] is None:
        candidates = [target]

    chats_processed = 0
    messages_found = 0
    inaccessible = []
    truncated = False
    written = 0
    last_progress = 0.0

    with open(filepath, "wb") as output:
        intro = (
            "GETCHAT TELEGRAM HISTORY EXPORT\n"
            f"Target: {_entity_name(target)} ({_marked_id(target)})\n"
            "Scope: Only chats and history accessible to this Telegram session.\n\n"
        )
        written = await _write_text(output, intro, written)

        for candidate in candidates:
            chat = candidate.entity if hasattr(candidate, "entity") else candidate
            try:
                iterator = client.iter_messages(
                    chat,
                    limit=None,
                    from_user=target if is_resolved_user else None,
                    wait_time=1,
                ).__aiter__()
                chat_messages = 0
                header_written = False
                while True:
                    message = await _next(iterator)
                    if message is None:
                        break
                    if is_numeric_user and message.sender_id != target:
                        continue
                    if not header_written:
                        written = await _write_text(output, _chat_header(chat), written)
                        header_written = True
                        chats_processed += 1
                    try:
                        sender = await asyncio.wait_for(message.get_sender(), timeout=ITERATION_TIMEOUT)
                    except (asyncio.TimeoutError, RPCError, ValueError):
                        sender = None
                    written = await _write_text(output, _record(chat, message, sender), written)
                    chat_messages += 1
                    messages_found += 1

                    now = time.monotonic()
                    if now - last_progress >= PROGRESS_INTERVAL:
                        await progress_cb(chats_processed, messages_found)
                        last_progress = now

            except OutputTooLarge:
                truncated = True
                break
            except FloodWaitError as exc:
                inaccessible.append(f"{_entity_name(chat)}: rate limited ({exc.seconds}s)")
            except (ChannelPrivateError, ChatAdminRequiredError):
                inaccessible.append(f"{_entity_name(chat)}: history inaccessible/permission denied")
            except (RPCError, ValueError, GetChatError) as exc:
                inaccessible.append(f"{_entity_name(chat)}: unavailable ({str(exc)[:120]})")

        summary = (
            "\n=== SUMMARY ===\n"
            f"Total messages: {messages_found}\n"
            f"Total chats: {chats_processed}\n"
            f"Inaccessible/unavailable: {len(inaccessible)}\n"
            f"Truncated by file limit: {'Yes' if truncated else 'No'}\n"
        )
        if inaccessible:
            summary += "\nSkipped chats:\n" + "\n".join(f"- {item}" for item in inaccessible[:100]) + "\n"
        try:
            await _write_text(output, summary, written)
        except OutputTooLarge:
            pass

    return {
        "messages": messages_found,
        "chats": chats_processed,
        "inaccessible": len(inaccessible),
        "truncated": truncated,
    }


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.getchat(?:\s+(.+))?$", outgoing=True))
    async def getchat_handler(event):
        raw = event.pattern_match.group(1) or ""
        try:
            parsed = _parse_target(raw)
        except GetChatError as exc:
            await edit_markdown(
                event,
                format_message(
                    "❌ Target Tidak Valid",
                    escape_markdown(exc),
                    example=".getchat @username",
                ),
            )
            return

        await edit_markdown(event, "⏳ Sedang mencari riwayat pesan...")
        filepath = None
        try:
            dialogs = await _load_dialogs(client)
            target = await _resolve_target(client, parsed, dialogs)
            filename = _safe_filename(raw)
            ensure_temp_dir()
            filepath = os.path.join(TEMP_DIR, filename)

            async def progress(chats: int, messages: int):
                try:
                    await edit_markdown(
                        event,
                        format_message(
                            "⏳ Sedang Mencari Riwayat Pesan",
                            details=[
                                f"**🔎 Chat ditemukan:** `{chats}`",
                                f"**💬 Pesan ditemukan:** `{messages}`",
                            ],
                        ),
                    )
                except Exception:
                    pass

            result = await _collect_history(client, target, dialogs, filepath, progress)
            if not result["messages"]:
                await edit_markdown(
                    event,
                    format_message(
                        "❌ Tidak Ada Pesan Ditemukan",
                        "Tidak ada pesan target pada history yang dapat diakses session ini.",
                        note=f"Chat inaccessible/unavailable: {result['inaccessible']}",
                    ),
                )
                return

            await edit_markdown(event, "📦 Sedang membuat file...")
            await send_file_markdown(
                client,
                event.chat_id,
                filepath,
                caption=format_message(
                    "✅ GetChat Selesai",
                    details=[
                        f"**💬 Total pesan:** `{result['messages']}`",
                        f"**🔎 Total chat:** `{result['chats']}`",
                        f"**⚠️ Inaccessible/unavailable:** `{result['inaccessible']}`",
                        f"**📄 File:** `{escape_markdown(filename)}`",
                        f"**Terpotong batas ukuran:** `{'Ya' if result['truncated'] else 'Tidak'}`",
                    ],
                    note="Hanya history yang dapat diakses oleh session Telegram ini.",
                ),
                attributes=[DocumentAttributeFilename(filename)],
                force_document=True,
            )
            await edit_markdown(
                event,
                format_message(
                    "✅ Selesai",
                    details=[
                        f"**💬 Total pesan:** `{result['messages']}`",
                        f"**🔎 Total chat:** `{result['chats']}`",
                        f"**📄 File:** `{escape_markdown(filename)}`",
                    ],
                ),
            )

        except FloodWaitError as exc:
            await edit_markdown(event, error_message(f"Telegram membatasi request. Coba lagi dalam {exc.seconds} detik", "Rate Limit"))
        except (ChannelPrivateError, ChatAdminRequiredError):
            await edit_markdown(event, error_message("Chat atau history tidak dapat diakses oleh session ini", "Akses Ditolak"))
        except GetChatError as exc:
            await edit_markdown(event, error_message(exc, "GetChat Gagal"))
        except asyncio.TimeoutError:
            await edit_markdown(event, error_message("Telegram tidak merespons tepat waktu", "GetChat Timeout"))
        except RPCError:
            await edit_markdown(event, error_message("Telegram API gagal memproses target atau history", "GetChat Gagal"))
        except OSError as exc:
            await edit_markdown(event, error_message(f"Gagal membuat atau mengirim file: {exc}", "File Error"))
        except Exception:
            await edit_markdown(event, error_message("Terjadi kesalahan internal saat mengumpulkan history", "GetChat Gagal"))
        finally:
            cleanup_file(filepath)


if __name__ == "__main__":
    assert _parse_target("123456789") == 123456789
    assert _parse_target("@username") == "username"
    assert _safe_filename("@user_name") == "getchat_user_name.txt"

import re

from telethon import events, functions, types
from telethon.errors import FloodWaitError, RPCError, UsernameInvalidError, UsernameNotOccupiedError

from utils.formatting import edit_markdown, error_message, escape_markdown, format_message, inline_code

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
SEARCH_LIMIT = 10


def _username(value: str) -> str:
    username = value.strip().lstrip("@").strip()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Username harus 4–32 karakter dan hanya berisi huruf, angka, atau underscore")
    return username


def _display_name(entity) -> str:
    if isinstance(entity, types.User):
        return " ".join(part for part in (entity.first_name, entity.last_name) if part) or "Tanpa nama"
    return getattr(entity, "title", None) or "Tanpa nama"


def _entity_kind(entity) -> tuple[str, str]:
    if isinstance(entity, types.User):
        return "user", "👤 User"
    if isinstance(entity, types.Channel) and entity.broadcast:
        return "channel", "📢 Channel"
    return "group", "👥 Group"


def _relevance(entity, keyword: str) -> tuple[int, str]:
    needle = keyword.casefold()
    username = (getattr(entity, "username", None) or "").casefold()
    name = _display_name(entity).casefold()
    if username == needle:
        score = 0
    elif name == needle:
        score = 1
    elif username.startswith(needle):
        score = 2
    elif name.startswith(needle):
        score = 3
    elif needle in username:
        score = 4
    elif needle in name:
        score = 5
    else:
        score = 6
    return score, name


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.id(?:\s+(.+))?$", outgoing=True))
    async def id_handler(event):
        raw = event.pattern_match.group(1) or ""
        try:
            username = _username(raw)
        except ValueError as exc:
            await edit_markdown(
                event,
                format_message("❌ Username Tidak Valid", escape_markdown(exc), example=".id @username"),
            )
            return

        await edit_markdown(event, f"⏳ Mencari {inline_code('@' + username)}...")
        try:
            resolved = await client(functions.contacts.ResolveUsernameRequest(username))
            entity = next((item for item in [*resolved.users, *resolved.chats] if item.id), None)
            if entity is None:
                raise UsernameNotOccupiedError(request=None)

            account_username = getattr(entity, "username", None)
            kind, label = _entity_kind(entity)
            details = [
                f"**Tipe:** {label}",
                f"**Nama:** {escape_markdown(_display_name(entity))}",
                f"**Username:** {inline_code('@' + account_username) if account_username else '*Tidak tersedia*'}",
                f"**ID:** `{entity.id}`",
            ]
            await edit_markdown(event, format_message("🆔 Informasi Telegram", details=details))
        except (UsernameInvalidError, UsernameNotOccupiedError, ValueError, StopIteration):
            await edit_markdown(event, error_message("Username tidak ditemukan atau tidak dapat diakses", "Pencarian Gagal"))
        except FloodWaitError as exc:
            await edit_markdown(event, error_message(f"Telegram membatasi request. Coba lagi dalam {exc.seconds} detik", "Rate Limit"))
        except RPCError:
            await edit_markdown(event, error_message("Telegram API gagal mengakses username tersebut", "Pencarian Gagal"))
        except Exception:
            await edit_markdown(event, error_message("Terjadi kesalahan internal saat mencari username", "Pencarian Gagal"))

    @client.on(events.NewMessage(pattern=r"^\.telesearch(?:\s+(.+))?$", outgoing=True))
    async def telesearch_handler(event):
        keyword = (event.pattern_match.group(1) or "").strip()
        if len(keyword) < 2 or len(keyword) > 64:
            await edit_markdown(
                event,
                format_message(
                    "❌ Keyword Tidak Valid",
                    "Keyword harus berisi `2–64` karakter.",
                    example=".telesearch tenzu",
                ),
            )
            return

        await edit_markdown(event, f"⏳ Mencari Telegram: {inline_code(keyword)}...")
        try:
            result = await client(functions.contacts.SearchRequest(q=keyword, limit=50))
            entities = [*result.users, *result.chats]
            unique = {(_entity_kind(entity)[0], entity.id): entity for entity in entities}
            ranked = sorted(unique.values(), key=lambda entity: _relevance(entity, keyword))[:SEARCH_LIMIT]

            if not ranked:
                await edit_markdown(event, error_message("Tidak ada hasil yang dapat diakses", "Hasil Tidak Ditemukan"))
                return

            details = []
            for index, entity in enumerate(ranked, 1):
                _, label = _entity_kind(entity)
                username = getattr(entity, "username", None)
                identity = inline_code('@' + username) if username else "*username tidak tersedia*"
                details.append(
                    f"**{index}. {label} — {escape_markdown(_display_name(entity))}**\n"
                    f"   {identity} · ID `{entity.id}`"
                )

            await edit_markdown(
                event,
                format_message(
                    "🔎 Hasil Telegram Search",
                    f"Keyword: {inline_code(keyword)}",
                    details=details,
                    note=f"Menampilkan maksimal {SEARCH_LIMIT} hasil yang tersedia melalui Telegram API; bukan seluruh database Telegram.",
                ),
            )
        except FloodWaitError as exc:
            await edit_markdown(event, error_message(f"Telegram membatasi request. Coba lagi dalam {exc.seconds} detik", "Rate Limit"))
        except RPCError:
            await edit_markdown(event, error_message("Telegram API gagal melakukan pencarian", "Pencarian Gagal"))
        except Exception:
            await edit_markdown(event, error_message("Terjadi kesalahan internal saat mencari Telegram", "Pencarian Gagal"))

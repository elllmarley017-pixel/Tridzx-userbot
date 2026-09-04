import re

from telethon import events

from downloaders.tiktok_search import TikTokSearchError, search_accounts, search_videos
from utils.formatting import edit_markdown, error_message, escape_markdown, format_message, inline_code, markdown_link

QUERY_RE = re.compile(r"^(.+?)\s+(account|vt)$", re.IGNORECASE | re.DOTALL)
RESULT_LIMIT = 5


def _number(value) -> str:
    if not isinstance(value, (int, float)):
        return "N/A"
    if value >= 1_000_000_000:
        return f"{value / 1_000_000_000:.1f}B"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.ttsearch(?:\s+(.+))?$", outgoing=True))
    async def ttsearch_handler(event):
        raw = (event.pattern_match.group(1) or "").strip()
        match = QUERY_RE.fullmatch(raw)
        if not match:
            await edit_markdown(
                event,
                format_message(
                    "❌ Format TikTok Search Tidak Valid",
                    "Tipe pencarian hanya menerima `account` atau `vt`.",
                    details=[
                        "Akun: `.ttsearch <query> account`",
                        "Video: `.ttsearch <query> vt`",
                    ],
                    example=".ttsearch video galau vt",
                ),
            )
            return

        query, search_type = match.group(1).strip(), match.group(2).lower()
        if len(query) < 2 or len(query) > 100:
            await edit_markdown(event, error_message("Query harus berisi 2–100 karakter", "Query Tidak Valid"))
            return

        label = "akun" if search_type == "account" else "video"
        await edit_markdown(event, f"⏳ Mencari {label} TikTok: {inline_code(query)}...")

        try:
            if search_type == "account":
                results = await search_accounts(query, RESULT_LIMIT)
                if not results:
                    await edit_markdown(event, error_message("Akun TikTok tidak ditemukan", "Hasil Kosong"))
                    return

                details = []
                for index, item in enumerate(results, 1):
                    verified = " ✓" if item["verified"] else ""
                    avatar = f" · {markdown_link('Avatar', item['avatar'])}" if item["avatar"] else ""
                    details.append(
                        f"**{index}. {escape_markdown(item['name'])}{verified}**\n"
                        f"   {inline_code('@' + item['username'])} · Followers `{_number(item['followers'])}`\n"
                        f"   {markdown_link('Profil TikTok', item['url'])}{avatar}"
                    )
                title = "👤 Hasil Pencarian Akun TikTok"
            else:
                results = await search_videos(query, RESULT_LIMIT)
                if not results:
                    await edit_markdown(event, error_message("Video TikTok tidak ditemukan", "Hasil Kosong"))
                    return

                details = []
                for index, item in enumerate(results, 1):
                    caption = item["caption"][:160] + ("..." if len(item["caption"]) > 160 else "")
                    thumbnail = f" · {markdown_link('Thumbnail', item['thumbnail'])}" if item["thumbnail"] else ""
                    creator = (
                        inline_code('@' + item['username'].lstrip('@'))
                        if item['username'] != "Tidak diketahui"
                        else "*Tidak tersedia*"
                    )
                    details.append(
                        f"**{index}. {escape_markdown(caption)}**\n"
                        f"   Kreator: {creator}\n"
                        f"   👁 `{_number(item['views'])}` · ♥ `{_number(item['likes'])}` · 💬 `{_number(item['comments'])}`\n"
                        f"   {markdown_link('Buka Video', item['url'])}{thumbnail}"
                    )
                title = "🎬 Hasil Pencarian Video TikTok"

            await edit_markdown(
                event,
                format_message(
                    title,
                    f"Query: {inline_code(query)}",
                    details=details,
                    note=f"Menampilkan maksimal {RESULT_LIMIT} hasil dari layanan pencarian publik TikTok.",
                ),
                link_preview=False,
            )
        except TikTokSearchError as exc:
            await edit_markdown(event, error_message(exc, "TikTok Search Gagal"))
        except Exception:
            await edit_markdown(event, error_message("Terjadi kesalahan internal saat mencari TikTok", "TikTok Search Gagal"))

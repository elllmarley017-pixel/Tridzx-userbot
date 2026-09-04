from telethon import events

from downloaders.social_stalker import (
    Profile,
    ProfileNotFound,
    StalkerError,
    extra_stalker,
    facebook_profile,
    github_profile,
    instagram_profile,
    normalize_username,
    roblox_profile,
    tiktok_profile,
    x_profile,
)
from utils.formatting import edit_markdown, error_message, escape_markdown, format_message, inline_code, markdown_link

COMMANDS = {
    "ttstalker": ("TikTok", tiktok_profile),
    "githubstalker": ("GitHub", github_profile),
    "robloxstalker": ("Roblox", roblox_profile),
    "igstalker": ("Instagram", instagram_profile),
    "xstalker": ("X/Twitter", x_profile),
    "fbstalker": ("Facebook", facebook_profile),
}


def _number(value) -> str:
    if value is None or value == "N/A":
        return "N/A"
    if not isinstance(value, (int, float)):
        return str(value)
    for size, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if value >= size:
            return f"{value / size:.1f}{suffix}"
    return str(value)


def _status(private) -> str:
    if private is True:
        return "Private"
    if private is False:
        return "Public"
    return "N/A"


def _profile_message(profile: Profile) -> str:
    avatar = markdown_link("Profile Picture", profile.avatar) if profile.avatar != "N/A" else "N/A"
    details = [
        f"**👤 Username:** {inline_code('@' + profile.username)}",
        f"**📛 Nama:** {escape_markdown(profile.name)}",
        f"**🖼️ Foto Profil:** {avatar}",
        f"**👥 Followers:** `{_number(profile.followers)}`",
        f"**➡️ Following:** `{_number(profile.following)}`",
        f"**📝 Bio:** {escape_markdown(profile.bio)}",
        f"**🔐 Status:** `{_status(profile.private)}`",
        f"**📊 Postingan:** `{_number(profile.posts)}`",
        f"**🔗 URL:** {markdown_link('Buka Profil', profile.url)}",
    ]
    if profile.platform == "GitHub":
        details.extend([
            f"**📧 Email publik:** {escape_markdown(profile.email or 'N/A')}",
            f"**📦 Repository:** `{_number(profile.repositories)}`",
        ])
    for key, value in profile.extras.items():
        details.append(f"**{escape_markdown(key)}:** {escape_markdown(value)}")
    return format_message(f"🔎 {profile.platform} Stalker", details=details, note="Data publik saja; field yang tidak tersedia ditampilkan sebagai N/A.")


def register(client):
    @client.on(events.NewMessage(
        pattern=r"^\.(ttstalker|githubstalker|robloxstalker|igstalker|xstalker|fbstalker)(?:\s+(.+))?$",
        outgoing=True,
    ))
    async def stalker_handler(event):
        command = event.pattern_match.group(1).lower()
        raw = event.pattern_match.group(2) or ""
        platform, fetcher = COMMANDS[command]
        try:
            username = normalize_username(raw)
        except StalkerError as exc:
            await edit_markdown(event, format_message("❌ Username Tidak Valid", escape_markdown(exc), example=f".{command} @username"))
            return

        await edit_markdown(event, f"⏳ Mencari akun {platform}: {inline_code('@' + username)}...")
        try:
            profile = await fetcher(username)
            await edit_markdown(event, _profile_message(profile), link_preview=True)
        except ProfileNotFound as exc:
            await edit_markdown(event, error_message(exc, f"Akun {platform} Tidak Ditemukan"))
        except StalkerError as exc:
            await edit_markdown(event, error_message(exc, f"{platform} Stalker Gagal"))
        except Exception:
            await edit_markdown(event, error_message(f"Layanan {platform} tidak tersedia atau timeout", f"{platform} Stalker Gagal"))

    @client.on(events.NewMessage(pattern=r"^\.extrastalker(?:\s+(.+))?$", outgoing=True))
    async def extra_stalker_handler(event):
        raw = event.pattern_match.group(1) or ""
        try:
            username = normalize_username(raw)
        except StalkerError as exc:
            await edit_markdown(event, format_message("❌ Query Tidak Valid", escape_markdown(exc), example=".extrastalker username"))
            return

        await edit_markdown(event, f"⏳ Mencari {inline_code(username)} pada `38` platform...")
        try:
            results = await extra_stalker(username)
            found = [result for result in results if result.status == "found"]
            not_found = [result for result in results if result.status == "not_found"]
            errors = [result for result in results if result.status == "error"]

            lines = []
            for result in results:
                icon = "✅" if result.status == "found" else "❌" if result.status == "not_found" else "⚠️"
                label = "Found" if result.status == "found" else "Not Found" if result.status == "not_found" else "Error / Unavailable"
                if result.status == "found":
                    line = f"{icon} **{escape_markdown(result.platform)}** — {markdown_link(label, result.url)}"
                    profile = result.profile
                    if profile and profile.followers is not None:
                        line += f" · Followers `{_number(profile.followers)}`"
                    if profile and profile.repositories is not None:
                        line += f" · Repos `{profile.repositories}`"
                else:
                    line = f"{icon} **{escape_markdown(result.platform)}** — {label}"
                lines.append(line)

            text = format_message(
                "🔎 EXTRA STALKER",
                f"Query: {inline_code(username)}",
                details=lines,
                note=(
                    "Pemeriksaan exact public profile URL; bukan pencarian berdasarkan kemiripan nama. "
                    "Status Found pada platform tanpa API hanya berarti URL publik merespons tanpa indikator not-found."
                ),
                footer=f"Found: {len(found)}/38 · Not Found: {len(not_found)}/38 · Error: {len(errors)}/38",
            )
            if len(text) > 4000:
                text = text[:3950] + "\n\n*Hasil dipotong karena batas pesan Telegram.*"
            await edit_markdown(event, text, link_preview=False)
        except Exception:
            await edit_markdown(event, error_message("Pencarian lintas platform gagal atau timeout", "Extra Stalker Gagal"))

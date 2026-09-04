"""Bot and owner information command."""
import time

from telethon import events

from config import BOT_VERSION, PROCESS_STARTED_AT
from utils.formatting import edit_markdown, markdown_link


def format_uptime(seconds: float) -> str:
    total = max(0, int(seconds))
    days, total = divmod(total, 86400)
    hours, total = divmod(total, 3600)
    minutes, seconds = divmod(total, 60)
    parts = []
    if days:
        parts.append(f"{days} Day{'s' if days != 1 else ''}")
    if hours:
        parts.append(f"{hours} Hour{'s' if hours != 1 else ''}")
    if minutes:
        parts.append(f"{minutes} Minute{'s' if minutes != 1 else ''}")
    if seconds or not parts:
        parts.append(f"{seconds} Second{'s' if seconds != 1 else ''}")
    return " ".join(parts)


def register(client):
    @client.on(events.NewMessage(pattern=r"^\.infobot$", outgoing=True))
    async def infobot_handler(event):
        uptime = format_uptime(time.monotonic() - PROCESS_STARTED_AT)
        text = (
            "**🤖 BOT INFORMATION**\n\n"
            "**Bot Name :** Hytryx Userbot\n"
            f"**Version  :** `{BOT_VERSION}`\n"
            f"**Status   :** 🟢 Running • `{uptime}`\n"
            "**Type     :** Python\n"
            f"**Owner    :** {markdown_link('@HanzTenzX', 'https://t.me/HanzTenzX')}\n\n"
            "**👤 OWNER INFORMATION**\n\n"
            f"**Portfolio :** {markdown_link('hanzx-portofolio.vercel.app', 'https://hanzx-portofolio.vercel.app/')}\n"
            f"**Channel   :** {markdown_link('@TenzXrepro', 'https://t.me/TenzXrepro')}\n"
            f"**Archive   :** {markdown_link('@despiselonelyy', 'https://t.me/despiselonelyy')}\n\n"
            "**GitHub Owner :**\n"
            f"• **One :** {markdown_link('elllmarley017-pixel', 'https://github.com/elllmarley017-pixel')}\n"
            f"• **Two :** {markdown_link('hanztenzudv', 'https://github.com/hanztenzudv')}\n\n"
            "**Owner Telegram :**\n"
            f"• **Owner :** {markdown_link('@HanzTenzX', 'https://t.me/HanzTenzX')}"
        )
        await edit_markdown(event, text, link_preview=False)

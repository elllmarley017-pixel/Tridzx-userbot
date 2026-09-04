"""Centralized, safe Markdown formatting for Telegram responses."""
from collections.abc import Iterable
from typing import Any

PARSE_MODE = "markdown"
_WORD_JOINER = "\u2060"


def escape_markdown(value: Any) -> str:
    """Neutralize Telethon Markdown delimiters in untrusted dynamic text."""
    text = str(value) if value is not None else ""
    return (
        text.replace("`", "ˋ")
        .replace("[", "［")
        .replace("]", "］")
        .replace("**", f"*{_WORD_JOINER}*")
        .replace("__", f"_{_WORD_JOINER}_")
        .replace("~~", f"~{_WORD_JOINER}~")
    )


def inline_code(value: Any) -> str:
    return f"`{escape_markdown(value)}`"


def code_block(value: Any, language: str = "") -> str:
    content = str(value) if value is not None else ""
    content = content.replace("```", "ˋˋˋ")
    return f"```{language}\n{content}\n```"


def markdown_link(label: Any, url: Any) -> str:
    safe_url = str(url).replace("\n", "").replace("(", "%28").replace(")", "%29")
    return f"[{escape_markdown(label)}]({safe_url})"


def format_message(
    title: str | None = None,
    body: str | None = None,
    details: Iterable[str] | None = None,
    example: str | None = None,
    note: str | None = None,
    footer: str | None = None,
) -> str:
    """Build one consistent Rich Markdown response."""
    sections: list[str] = []
    if title:
        sections.append(f"**{title}**")
    if body:
        sections.append(body)
    if details:
        items = "\n".join(f"• {item}" for item in details)
        sections.append(f"**📌 Detail**\n{items}")
    if example:
        sections.append(f"**💡 Contoh**\n{inline_code(example)}")
    if note:
        sections.append("\n".join(f"> {line}" for line in note.splitlines()))
    if footer:
        sections.append(f"*{footer}*")
    return "\n\n".join(sections)


def ensure_rich_markdown(text: Any) -> str:
    """Ensure even simple status text has visible Markdown structure."""
    value = str(text) if text is not None else ""
    if any(token in value for token in ("**", "__", "`", "[", "> ", "• ")):
        return value
    return format_message(value)


def status_message(text: str, icon: str = "⏳") -> str:
    return format_message(f"{icon} {text}")


def success_message(text: str = "Selesai") -> str:
    return format_message(f"✅ {text}")


def error_message(error: Any, title: str = "Terjadi Kesalahan") -> str:
    return format_message(f"❌ {title}", escape_markdown(error))


async def edit_markdown(message, text: str, **kwargs):
    """Edit with Markdown; error responses mark the current command failed."""
    rich_text = ensure_rich_markdown(text)
    if rich_text.lstrip().startswith("**❌"):
        try:
            from utils.activity_logging import mark_activity_failed
            mark_activity_failed(rich_text)
        except Exception:
            pass
    return await message.edit(rich_text, parse_mode=PARSE_MODE, **kwargs)


async def send_file_markdown(client, entity, file, **kwargs):
    """Send media while parsing its caption as project-wide Markdown."""
    if kwargs.get("caption"):
        kwargs["caption"] = ensure_rich_markdown(kwargs["caption"])
    kwargs["parse_mode"] = PARSE_MODE
    return await client.send_file(entity, file, **kwargs)

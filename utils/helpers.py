import re
from urllib.parse import urlparse


def is_youtube_url(text: str) -> bool:
    return bool(re.match(
        r'https?://(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)/',
        text.strip()
    ))


def is_facebook_url(text: str) -> bool:
    return bool(re.match(
        r'https?://(www\.)?(facebook\.com|fb\.watch|fb\.com|m\.facebook\.com|fb\.gg)/',
        text.strip(),
        re.IGNORECASE
    ))


def is_spotify_url(text: str) -> bool:
    return bool(re.match(
        r'https?://open\.spotify\.com/track/',
        text.strip()
    ))


def sanitize_filename(name: str, max_len: int = 80) -> str:
    return re.sub(r'[^\w\s\-]', '', name).strip()[:max_len]


def clean_title(title: str) -> str:
    """Bersihkan judul: ganti underscore jadi spasi, trim spasi berlebih."""
    if not title:
        return title
    title = title.replace('_', ' ')
    title = re.sub(r'\s+', ' ', title).strip()
    return title


def format_duration(seconds: int) -> str:
    if seconds <= 0:
        return "N/A"
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"

import time
from config import PROGRESS_UPDATE_INTERVAL
from utils.formatting import edit_markdown, status_message, escape_markdown

_last_update = {}


async def progress_callback(event, current: int, total: int, action: str = "Memproses download"):
    """Update progress message, throttled to avoid rate limit."""
    msg_id = event.id
    now = time.time()

    if msg_id in _last_update and (now - _last_update[msg_id]) < PROGRESS_UPDATE_INTERVAL:
        return

    if total > 0:
        pct = int(current / total * 100)
    else:
        pct = 0

    # Only update at meaningful intervals
    text = status_message(f"{escape_markdown(action)}... `{pct}%`")
    try:
        await edit_markdown(event, text)
        _last_update[msg_id] = now
    except Exception:
        pass


def clear_progress(msg_id: int):
    _last_update.pop(msg_id, None)

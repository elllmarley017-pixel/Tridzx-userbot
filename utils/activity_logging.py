"""Centralized, failure-safe command activity logging."""
import contextvars
import functools
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from config import LOG_DIR, LOG_FILE, LOG_TIMEZONE

_STATUS = {"PENDING", "SUCCESS", "FAILED"}
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|token|password|passwd|otp|authorization|secret)"
    r"(\s*[:=]\s*|\s+)([^\s,;]+)"
)
_BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
_current_activity = contextvars.ContextVar("command_activity", default=None)
_logger = logging.getLogger("telegram_userbot.activity")
_configured = False


@dataclass
class Activity:
    feature: str
    user: str
    failed: bool = False
    error: str = "-"


def _timezone():
    try:
        return ZoneInfo(LOG_TIMEZONE)
    except ZoneInfoNotFoundError:
        # Termux/Python installs may omit the IANA timezone database.
        offsets = {
            "Asia/Jakarta": 7,
            "Asia/Makassar": 8,
            "Asia/Jayapura": 9,
            "UTC": 0,
        }
        hours = offsets.get(LOG_TIMEZONE, 0)
        return timezone(timedelta(hours=hours), name=LOG_TIMEZONE if LOG_TIMEZONE in offsets else "UTC")


def configure_activity_logging() -> None:
    """Configure console plus rotating file output once."""
    global _configured
    if _configured:
        return
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        formatter = logging.Formatter("%(levelname)s\n%(message)s\n" + ("-" * 48))
        file_handler = RotatingFileHandler(
            LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        stream_handler = logging.StreamHandler()
        file_handler.setFormatter(formatter)
        stream_handler.setFormatter(formatter)
        _logger.setLevel(logging.INFO)
        _logger.propagate = False
        _logger.addHandler(file_handler)
        _logger.addHandler(stream_handler)
        _configured = True
    except Exception:
        # Logging must never prevent startup or command execution.
        _configured = False


def _sanitize(value) -> str:
    text = str(value or "-").replace("\r", " ").replace("\n", " ").strip()
    text = _SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
    text = _BEARER_RE.sub("Bearer [REDACTED]", text)
    return text[:1500] or "-"


def _write(activity: Activity, status: str, error: str = "-") -> None:
    """Write one structured event; swallow all logging failures."""
    try:
        configure_activity_logging()
        if not _configured or status not in _STATUS:
            return
        level = logging.ERROR if status == "FAILED" else logging.INFO
        timestamp = f"{datetime.now(_timezone()).strftime('%Y-%m-%d %H:%M:%S')} {LOG_TIMEZONE}"
        message = (
            f"USER    : {_sanitize(activity.user)}\n"
            f"FITUR   : {_sanitize(activity.feature)}\n"
            f"PROSES  : {status}\n"
            f"ERROR   : {_sanitize(error)}\n"
            f"WAKTU   : {timestamp}"
        )
        _logger.log(level, message)
    except Exception:
        pass


async def _user_label(event) -> str:
    sender_id = getattr(event, "sender_id", None) or "Unknown"
    try:
        sender = await event.get_sender()
        username = getattr(sender, "username", None)
        if username:
            return f"@{username}"
        name = " ".join(
            part for part in (getattr(sender, "first_name", None), getattr(sender, "last_name", None)) if part
        )
        return f"{name} ({sender_id})" if name else str(sender_id)
    except Exception:
        return str(sender_id)


def _feature(event) -> str:
    text = (getattr(event, "raw_text", None) or "").strip()
    command = text.split(maxsplit=1)[0] if text else "unknown"
    return command if command.startswith(".") else f".{command}"


def mark_activity_failed(error) -> None:
    """Mark a handled failure so middleware does not report SUCCESS."""
    activity = _current_activity.get()
    if activity is not None:
        activity.failed = True
        activity.error = _sanitize(error)


def install_command_logging(client) -> None:
    """Wrap every subsequently registered handler in one logging middleware."""
    if getattr(client, "_central_command_logging_installed", False):
        return
    configure_activity_logging()
    original_add_event_handler = client.add_event_handler

    def add_event_handler(callback, event=None):
        if getattr(callback, "_activity_logged", False):
            return original_add_event_handler(callback, event)

        @functools.wraps(callback)
        async def logged_callback(update):
            activity = Activity(feature=_feature(update), user=await _user_label(update))
            token = _current_activity.set(activity)
            _write(activity, "PENDING")
            try:
                result = await callback(update)
            except Exception as exc:
                activity.failed = True
                activity.error = _sanitize(exc)
                _write(activity, "FAILED", activity.error)
                raise
            else:
                if activity.failed:
                    _write(activity, "FAILED", activity.error)
                else:
                    _write(activity, "SUCCESS")
                return result
            finally:
                _current_activity.reset(token)

        logged_callback._activity_logged = True
        return original_add_event_handler(logged_callback, event)

    client.add_event_handler = add_event_handler
    client._central_command_logging_installed = True

"""Detailed downloader pipeline logging."""
import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler

from config import LOG_FILE, LOG_TIMEZONE
from utils.activity_logging import _sanitize, _timezone

_logger = logging.getLogger("telegram_userbot.download")
if not _logger.handlers:
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    handler = RotatingFileHandler(LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(levelname)s\n%(message)s\n" + "-" * 48))
    _logger.addHandler(handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False


def log_download(user: str, feature: str, status: str, *, url: str = "-", stage: str = "-", progress: str = "-", error: str = "-", file: str = "-", size: int = 0) -> None:
    timestamp = f"{datetime.now(_timezone()).strftime('%Y-%m-%d %H:%M:%S')} {LOG_TIMEZONE}"
    message = (
        f"USER    : {_sanitize(user)}\nFITUR   : {_sanitize(feature)}\nURL     : {_sanitize(url)}\nSTATUS  : {_sanitize(status)}\n"
        f"STAGE   : {_sanitize(stage)}\nPROGRESS: {_sanitize(progress)}\nFILE    : {_sanitize(file)}\n"
        f"SIZE    : {size / 1024 / 1024:.2f} MB\nERROR   : {_sanitize(error)}\nWAKTU   : {timestamp}"
    )
    _logger.log(logging.ERROR if status.endswith("FAILED") or status == "FAILED" else logging.INFO, message)

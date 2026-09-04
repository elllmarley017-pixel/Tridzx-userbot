import os
import json
import time

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "session", "config.json")
SESSION_NAME = os.path.join(os.path.dirname(__file__), "session", "userbot")
TEMP_DIR = os.path.join(os.path.dirname(__file__), "temp")
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
LOG_FILE = os.path.join(LOG_DIR, "activity.log")
LOG_TIMEZONE = os.environ.get("BOT_TIMEZONE", "Asia/Jakarta")
BOT_VERSION = os.environ.get("BOT_VERSION", "1.0.0")
PROCESS_STARTED_AT = time.monotonic()

# Telegram file size limit (2GB for premium, 50MB for normal - use 50MB as safe default)
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB

# Request timeout
REQUEST_TIMEOUT = 120

# Progress update interval (seconds) to avoid rate limit
PROGRESS_UPDATE_INTERVAL = 3


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    return {}


def save_config(api_id: int, api_hash: str):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump({"api_id": api_id, "api_hash": api_hash}, f)

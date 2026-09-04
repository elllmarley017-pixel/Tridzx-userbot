import os
import glob
from config import TEMP_DIR


def ensure_temp_dir():
    os.makedirs(TEMP_DIR, exist_ok=True)


def cleanup_file(*paths: str):
    for p in paths:
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


def cleanup_temp_dir():
    """Remove all files in temp directory."""
    for f in glob.glob(os.path.join(TEMP_DIR, "*")):
        try:
            os.remove(f)
        except OSError:
            pass

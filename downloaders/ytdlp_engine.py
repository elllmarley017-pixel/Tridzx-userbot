"""Shared async yt-dlp pipeline with deterministic output and staged errors."""
import asyncio
import glob
import json
import os
import sys
from collections.abc import Awaitable, Callable

from config import MAX_FILE_SIZE

ProgressCallback = Callable[[int, int], Awaitable[None]]
StatusCallback = Callable[[str], Awaitable[None]]

_YTDLP_ENV = os.environ.copy()
_YTDLP_ENV["PATH"] = "/data/data/com.termux/files/usr/bin:" + _YTDLP_ENV.get("PATH", "")
_TRANSIENT_MARKERS = (
    "contentlengtherror", "connection reset", "connection aborted", "timed out", "timeout",
    "remote end closed", "incomplete read", "temporary failure", "http error 429",
    "http error 500", "http error 502", "http error 503", "http error 504",
    "unable to download", "network is unreachable", "fragment",
)


class YTDLPDownloadError(RuntimeError):
    def __init__(self, stage: str, detail: str):
        self.stage = stage
        self.detail = (detail or "Unknown error").strip()[:4000]
        super().__init__(f"{stage}: {self.detail}")


def base_command(*, playlist: bool = False) -> list[str]:
    command = [
        sys.executable, "-m", "yt_dlp", "--js-runtimes", "node",
        "--socket-timeout", "25", "--retries", "5", "--fragment-retries", "5",
        "--extractor-retries", "3", "--file-access-retries", "3",
        "--retry-sleep", "http:exp=1:8", "--retry-sleep", "fragment:exp=1:8",
        "--concurrent-fragments", "4", "--continue", "--part", "--newline", "--no-warnings",
    ]
    if not playlist:
        command.append("--no-playlist")
    return command


def _cleanup_candidates(pattern: str) -> None:
    for path in glob.glob(pattern):
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass


def validate_download(path: str, *, expected_ext: str | None = None, minimum_size: int = 1024) -> str:
    path = os.path.abspath(path) if path else ""
    if not path or not os.path.isfile(path):
        raise YTDLPDownloadError("FILE_OUTPUT", f"File tidak ditemukan: {path or '-'}")
    if expected_ext and os.path.splitext(path)[1].lower() != f".{expected_ext.lower().lstrip('.')}":
        raise YTDLPDownloadError("FILE_VALIDATION", f"Ekstensi tidak sesuai: {path}")
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as file:
            if not file.read(16):
                raise OSError("file kosong")
    except OSError as exc:
        raise YTDLPDownloadError("FILE_VALIDATION", f"File tidak dapat dibaca: {exc}") from exc
    if size < minimum_size:
        raise YTDLPDownloadError("FILE_VALIDATION", f"Ukuran file tidak valid: {size} byte")
    if size > MAX_FILE_SIZE:
        raise YTDLPDownloadError(
            "FILE_VALIDATION",
            f"File terlalu besar ({size / 1024 / 1024:.2f} MB), batas {MAX_FILE_SIZE / 1024 / 1024:.0f} MB",
        )
    if path.endswith((".part", ".ytdl", ".temp")):
        raise YTDLPDownloadError("FILE_VALIDATION", f"File masih sementara: {path}")
    return path


def _stage(stderr: str, candidates: list[str]) -> str:
    text = stderr.lower()
    if "ffmpeg" in text or "postprocess" in text or "post-process" in text or "unable to convert" in text:
        return "POSTPROCESS"
    if not candidates and any(word in text for word in ("extractor", "extracting", "unsupported url", "video unavailable", "sign in")):
        return "EXTRACTION"
    if candidates:
        return "FILE_VALIDATION"
    return "DOWNLOAD"


async def _read_stdout(stream, progress_cb: ProgressCallback | None) -> dict:
    """Parse only compact tagged lines; never emit yt-dlp's huge --print-json payload."""
    info: dict = {}
    while raw := await stream.readline():
        line = raw.decode(errors="replace").strip()
        if line.startswith("__PROGRESS__"):
            if progress_cb:
                try:
                    current, total = line.removeprefix("__PROGRESS__").split("|", 1)
                    if current not in {"NA", "None"} and total not in {"NA", "None", "0"}:
                        await progress_cb(int(float(current)), int(float(total)))
                except (ValueError, TypeError):
                    pass
        elif line.startswith("__META__"):
            payload = line.removeprefix("__META__")
            try:
                info.update(json.loads(payload))
            except json.JSONDecodeError:
                # yt-dlp prints unavailable fields as NA, which is not JSON.
                try:
                    info.update(json.loads(payload.replace(":NA", ":null")))
                except json.JSONDecodeError:
                    pass
        elif line.startswith("__FILE__"):
            info["filepath"] = os.path.abspath(line.removeprefix("__FILE__"))
    return info


async def run_ytdlp(
    url: str,
    output_template: str,
    output_glob: str,
    *,
    extra_args: list[str] | None = None,
    expected_ext: str | None = None,
    timeout: int = 300,
    attempts: int = 3,
    progress_cb: ProgressCallback | None = None,
    status_cb: StatusCallback | None = None,
) -> dict:
    output_template = os.path.abspath(output_template)
    output_glob = os.path.abspath(output_glob)
    os.makedirs(os.path.dirname(output_template), exist_ok=True)
    last_error = YTDLPDownloadError("DOWNLOAD", "yt-dlp tidak dijalankan")

    for attempt in range(attempts):
        command = base_command() + [
            "--max-filesize", str(MAX_FILE_SIZE),
            "--progress-template", "download:__PROGRESS__%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s",
            "--print", 'before_dl:__META__{"title":%(title)j,"artist":%(artist)j,"uploader":%(uploader)j,"channel":%(channel)j,"thumbnail":%(thumbnail)j}',
            "--print", "after_move:__FILE__%(filepath)s",
            "-o", output_template, *(extra_args or []), url,
        ]
        process = await asyncio.create_subprocess_exec(
            *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=_YTDLP_ENV, limit=1024 * 1024,
        )
        stdout_task = asyncio.create_task(_read_stdout(process.stdout, progress_cb))
        stderr_task = asyncio.create_task(process.stderr.read())
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
            info = await stdout_task
            stderr = (await stderr_task).decode(errors="replace").strip()
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            _cleanup_candidates(output_glob)
            raise
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            stderr, info = f"Proses yt-dlp timeout setelah {timeout} detik", {}

        candidates = [
            os.path.abspath(path) for path in glob.glob(output_glob)
            if os.path.isfile(path) and not path.endswith((".part", ".ytdl", ".temp"))
        ]
        reported = info.get("filepath")
        ordered = ([reported] if reported and os.path.isfile(reported) else []) + candidates
        valid = []
        for candidate in dict.fromkeys(ordered):
            try:
                valid.append(validate_download(candidate, expected_ext=expected_ext))
            except YTDLPDownloadError as exc:
                last_error = exc

        if process.returncode == 0 and valid:
            info["filepath"] = max(valid, key=os.path.getsize)
            info["stderr"] = stderr
            return info

        detail = stderr or f"yt-dlp exit={process.returncode}; output={candidates or '-'}"
        last_error = YTDLPDownloadError(_stage(detail, candidates), detail)
        if attempt + 1 < attempts:
            if status_cb:
                await status_cb(last_error.stage, attempt + 2, attempts, last_error.detail)
            transient = any(marker in detail.lower() for marker in _TRANSIENT_MARKERS)
            await asyncio.sleep(min(2 ** attempt, 8) if transient else attempt + 1)

    _cleanup_candidates(output_glob)
    raise last_error

"""Asynchronous GitHub repository, branch, and folder downloader."""
import asyncio
import os
import re
import shutil
import uuid
import zipfile
from urllib.parse import quote, unquote, urlparse

import aiohttp

from config import MAX_FILE_SIZE, TEMP_DIR
from utils.cleanup import cleanup_file, ensure_temp_dir

GITHUB_API = "https://api.github.com"
GITHUB_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
DOWNLOAD_LIMIT = MAX_FILE_SIZE + 1
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=300, connect=30, sock_read=60)


class GitHubDownloadError(RuntimeError):
    pass


def parse_github_url(url: str) -> dict:
    """Parse supported github.com repository/tree URLs without network access."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"github.com", "www.github.com"}:
        raise GitHubDownloadError("URL GitHub tidak valid")

    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) < 2 or not all(GITHUB_RE.fullmatch(part) for part in parts[:2]):
        raise GitHubDownloadError("URL repository GitHub tidak valid")

    owner, repo = parts[:2]
    repo = repo.removesuffix(".git")
    if not repo:
        raise GitHubDownloadError("Nama repository tidak valid")

    if len(parts) == 2:
        tail = []
    elif len(parts) >= 4 and parts[2] == "tree":
        tail = parts[3:]
    else:
        raise GitHubDownloadError("Gunakan URL repository atau URL `/tree/<branch>/<folder>`")

    return {"owner": owner, "repo": repo, "tail": tail}


def _headers() -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "telegram-userbot-github-downloader",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def _api_json(session: aiohttp.ClientSession, path: str) -> dict | list:
    async with session.get(f"{GITHUB_API}{path}") as response:
        if response.status == 404:
            raise GitHubDownloadError("Repository, branch, atau folder tidak ditemukan; repository private memerlukan `GITHUB_TOKEN`")
        if response.status in {401, 403}:
            remaining = response.headers.get("X-RateLimit-Remaining")
            if remaining == "0":
                raise GitHubDownloadError("Batas request GitHub API tercapai; atur `GITHUB_TOKEN` lalu coba lagi")
            raise GitHubDownloadError("Akses GitHub ditolak; repository private memerlukan `GITHUB_TOKEN` yang valid")
        if response.status >= 400:
            raise GitHubDownloadError(f"GitHub API gagal: HTTP {response.status}")
        return await response.json()


async def _resolve_target(session: aiohttp.ClientSession, target: dict) -> tuple[str, str]:
    owner = quote(target["owner"], safe="")
    repo = quote(target["repo"], safe="")
    metadata = await _api_json(session, f"/repos/{owner}/{repo}")
    tail = target["tail"]
    if not tail:
        return metadata["default_branch"], ""

    # A branch may contain slashes. Try each prefix, accepting the first whose
    # remaining path exists. This avoids assuming that the branch is one segment.
    for split_at in range(len(tail), 0, -1):
        branch = "/".join(tail[:split_at])
        folder = "/".join(tail[split_at:])
        branch_url = quote(branch, safe="")
        async with session.get(f"{GITHUB_API}/repos/{owner}/{repo}/branches/{branch_url}") as response:
            if response.status != 200:
                continue
        if folder:
            folder_url = quote(folder, safe="/")
            async with session.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/contents/{folder_url}",
                params={"ref": branch},
            ) as response:
                if response.status != 200:
                    continue
                data = await response.json()
                if not isinstance(data, list):
                    raise GitHubDownloadError("URL mengarah ke file; gunakan URL repository atau folder")
        return branch, folder

    raise GitHubDownloadError("Branch atau folder GitHub tidak ditemukan")


async def _download_archive(
    session: aiohttp.ClientSession,
    owner: str,
    repo: str,
    branch: str,
    destination: str,
    progress_cb=None,
) -> None:
    url = f"{GITHUB_API}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}/zipball/{quote(branch, safe='')}"
    async with session.get(url, allow_redirects=True) as response:
        if response.status == 404:
            raise GitHubDownloadError("Archive repository tidak ditemukan")
        if response.status in {401, 403}:
            raise GitHubDownloadError("GitHub menolak download; periksa akses atau `GITHUB_TOKEN`")
        if response.status >= 400:
            raise GitHubDownloadError(f"Download GitHub gagal: HTTP {response.status}")

        total = int(response.headers.get("Content-Length", 0))
        if total > MAX_FILE_SIZE:
            raise GitHubDownloadError(f"Repository terlalu besar; batas file `{MAX_FILE_SIZE // 1024 // 1024} MB`")

        downloaded = 0
        with open(destination, "wb") as archive:
            async for chunk in response.content.iter_chunked(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > DOWNLOAD_LIMIT:
                    raise GitHubDownloadError(f"Repository terlalu besar; batas file `{MAX_FILE_SIZE // 1024 // 1024} MB`")
                archive.write(chunk)
                if progress_cb:
                    await progress_cb(downloaded, total or DOWNLOAD_LIMIT)


def _zip_folder(source_archive: str, output_archive: str, folder: str) -> None:
    folder_parts = tuple(part for part in folder.split("/") if part)
    selected = 0
    written = 0

    with zipfile.ZipFile(source_archive) as source, zipfile.ZipFile(
        output_archive, "w", zipfile.ZIP_DEFLATED, allowZip64=True
    ) as output:
        for info in source.infolist():
            archive_parts = tuple(part for part in info.filename.split("/") if part)
            relative = archive_parts[1:]  # GitHub adds one generated root directory.
            if relative[:len(folder_parts)] != folder_parts:
                continue
            if not relative:
                continue

            output_name = "/".join(relative)
            if info.is_dir():
                output.writestr(output_name.rstrip("/") + "/", b"")
                continue

            written += info.file_size
            if written > MAX_FILE_SIZE * 4:
                raise GitHubDownloadError("Folder terlalu besar untuk diproses dengan aman")
            with source.open(info) as src, output.open(output_name, "w") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            selected += 1

    if not selected:
        raise GitHubDownloadError("Folder GitHub kosong atau tidak ditemukan")
    if os.path.getsize(output_archive) > MAX_FILE_SIZE:
        raise GitHubDownloadError(f"Hasil ZIP terlalu besar; batas file `{MAX_FILE_SIZE // 1024 // 1024} MB`")


async def download_github(url: str, progress_cb=None, status_cb=None) -> dict:
    """Download a public/private-with-token GitHub repository or folder as ZIP."""
    target = parse_github_url(url)
    ensure_temp_dir()
    job_id = uuid.uuid4().hex
    source_archive = os.path.join(TEMP_DIR, f"github_{job_id}_source.zip")
    output_archive = os.path.join(TEMP_DIR, f"github_{job_id}.zip")

    try:
        async with aiohttp.ClientSession(headers=_headers(), timeout=REQUEST_TIMEOUT) as session:
            branch, folder = await _resolve_target(session, target)
            await _download_archive(
                session, target["owner"], target["repo"], branch, source_archive, progress_cb
            )

        if folder:
            if status_cb:
                await status_cb("zip")
            await asyncio.to_thread(_zip_folder, source_archive, output_archive, folder)
        else:
            os.replace(source_archive, output_archive)

        safe_repo = re.sub(r"[^A-Za-z0-9_.-]", "_", target["repo"])
        safe_branch = re.sub(r"[^A-Za-z0-9_.-]", "_", branch)
        filename = f"{safe_repo}-{safe_branch}.zip"
        return {
            "filepath": output_archive,
            "filename": filename,
            "owner": target["owner"],
            "repo": target["repo"],
            "branch": branch,
            "folder": folder,
            "size": os.path.getsize(output_archive),
        }
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        raise GitHubDownloadError("Request GitHub timeout atau koneksi gagal") from exc
    finally:
        cleanup_file(source_archive)


if __name__ == "__main__":
    assert parse_github_url("https://github.com/user/repo") == {"owner": "user", "repo": "repo", "tail": []}
    assert parse_github_url("https://github.com/user/repo/tree/main/src")['tail'] == ["main", "src"]

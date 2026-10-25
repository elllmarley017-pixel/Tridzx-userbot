"use strict";

/**
 * GitHub repository downloader — direct archive download.
 *
 * Tidak menggunakan GitHub REST API.
 * Mengunduh archive ZIP langsung dari github.com.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");

const { MAX_FILE_SIZE, TEMP_DIR } = require("../config");
const { cleanupFile, ensureTempDir } = require("../utils/cleanup");
const { ClientSession, ClientError, TimeoutError } = require("../utils/http");

const GITHUB_RE = /^[A-Za-z0-9_.-]+$/;
const DOWNLOAD_LIMIT = MAX_FILE_SIZE + 1;
const REQUEST_TIMEOUT = 300;

class GitHubDownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubDownloadError";
  }
}

function parseGithubUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new GitHubDownloadError("URL GitHub tidak valid");
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GitHubDownloadError("URL GitHub tidak valid");
  }
  if (host !== "github.com" && host !== "www.github.com") {
    throw new GitHubDownloadError("URL GitHub tidak valid");
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (parts.length < 2 || !parts.slice(0, 2).every((p) => GITHUB_RE.test(p))) {
    throw new GitHubDownloadError("URL repository GitHub tidak valid");
  }

  const owner = parts[0];
  let repo = parts[1];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!repo) throw new GitHubDownloadError("Nama repository tidak valid");

  let tail;
  if (parts.length === 2) {
    tail = [];
  } else if (parts.length >= 4 && parts[2] === "tree") {
    tail = parts.slice(3);
  } else {
    throw new GitHubDownloadError(
      "Gunakan URL repository atau URL /tree/<branch>/<folder>",
    );
  }

  return { owner, repo, tail };
}

/**
 * Default branch of a repository, via the public GitHub API.
 * Falls back to probing the archive URLs when the API is rate limited.
 *
 * @returns {Promise<string>}
 */
async function defaultBranchFor(session, owner, repo) {
  try {
    const api = await session.get(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { allowRedirects: true, headers: { accept: "application/vnd.github+json" } },
    );
    if (api.status === 200) {
      const json = await api.json();
      if (json && typeof json.default_branch === "string" && json.default_branch) {
        return json.default_branch;
      }
    }
    if (api.status === 404) {
      throw new GitHubDownloadError("Repository tidak ditemukan atau privat");
    }
  } catch (err) {
    if (err instanceof GitHubDownloadError) throw err;
    /* network/rate limit: fall through to probing */
  }

  for (const candidate of ["main", "master"]) {
    const resp = await session.get(
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/refs/heads/${candidate}.zip`,
      { method: "HEAD", allowRedirects: true },
    );
    if (resp.status === 200) return candidate;
  }
  throw new GitHubDownloadError("Repository tidak ditemukan atau privat");
}

/**
 * Resolve branch/folder by scraping the GitHub tree page.
 */
async function resolveTarget(session, target) {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);

  // If no branch specified, ask the GitHub API for the default branch.
  // Scraping the HTML with a regex used to fall back to "main" and then fail
  // with "Archive repository tidak ditemukan" on repos whose default is master.
  if (!target.tail.length) {
    const branch = await defaultBranchFor(session, target.owner, target.repo);
    return [branch, ""];
  }

  // A branch may contain slashes. Try each prefix.
  for (let splitAt = target.tail.length; splitAt >= 1; splitAt -= 1) {
    const branch = target.tail.slice(0, splitAt).join("/");
    const folder = target.tail.slice(splitAt).join("/");
    const treeUrl = `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}`;
    if (folder) {
      const folderUrl = `${treeUrl}/${folder.split("/").map(encodeURIComponent).join("/")}`;
      const folderResp = await session.get(folderUrl, { allowRedirects: true });
      if (folderResp.status === 200) {
        return [branch, folder];
      }
    } else {
      const branchResp = await session.get(treeUrl, { allowRedirects: true });
      if (branchResp.status === 200) {
        return [branch, ""];
      }
    }
  }

  throw new GitHubDownloadError("Branch atau folder tidak ditemukan pada repository");
}

/**
 * Download archive ZIP directly from GitHub.
 */
async function downloadArchive(session, owner, repo, branch, destination, progressCb) {
  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  const response = await session.get(url, { allowRedirects: true });
  if (response.status === 404) {
    throw new GitHubDownloadError("Archive repository tidak ditemukan");
  }
  if (response.status >= 400) {
    throw new GitHubDownloadError(`Download GitHub gagal: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  if (total > MAX_FILE_SIZE) {
    throw new GitHubDownloadError(
      `Repository terlalu besar; batas file ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB`,
    );
  }

  const out = fs.createWriteStream(destination);
  let downloaded = 0;
  try {
    for await (const chunk of response.iterChunked(1024 * 1024)) {
      downloaded += chunk.length;
      if (downloaded > DOWNLOAD_LIMIT) {
        throw new GitHubDownloadError(
          `Repository terlalu besar; batas file ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB`,
        );
      }
      out.write(chunk);
      if (progressCb) await progressCb(downloaded, total || DOWNLOAD_LIMIT);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

async function zipFolder(sourceArchive, outputArchive, folder) {
  const buffer = await fs.promises.readFile(sourceArchive);
  const source = await JSZip.loadAsync(buffer);
  const folderParts = folder.split("/").filter(Boolean);

  const output = new JSZip();
  let selected = 0;
  let written = 0;

  const entries = Object.values(source.files);
  for (const entry of entries) {
    const archiveParts = entry.name.split("/").filter(Boolean);
    const relative = archiveParts.slice(1); // GitHub adds one generated root dir.
    if (relative.length < folderParts.length) continue;
    if (!folderParts.every((part, i) => relative[i] === part)) continue;
    if (!relative.length) continue;

    const outputName = relative.join("/");
    if (entry.dir) {
      output.folder(outputName.replace(/\/+$/, "") + "/");
      continue;
    }

    const content = await entry.async("nodebuffer");
    written += content.length;
    if (written > MAX_FILE_SIZE * 4) {
      throw new GitHubDownloadError("Folder terlalu besar untuk diproses dengan aman");
    }
    output.file(outputName, content);
    selected += 1;
  }

  if (!selected) {
    throw new GitHubDownloadError("Folder GitHub kosong atau tidak ditemukan");
  }

  const zipBuffer = await output.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await fs.promises.writeFile(outputArchive, zipBuffer);
  if (fs.statSync(outputArchive).size > MAX_FILE_SIZE) {
    throw new GitHubDownloadError(
      `Hasil ZIP terlalu besar; batas file ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB`,
    );
  }
}

async function downloadGithub(url, { progressCb = null, statusCb = null } = {}) {
  const target = parseGithubUrl(url);
  ensureTempDir();
  const jobId = crypto.randomBytes(16).toString("hex");
  const sourceArchive = path.join(TEMP_DIR, `github_${jobId}_source.zip`);
  const outputArchive = path.join(TEMP_DIR, `github_${jobId}.zip`);

  const session = new ClientSession({ timeout: REQUEST_TIMEOUT });
  try {
    const [branch, folder] = await resolveTarget(session, target);
    await downloadArchive(session, target.owner, target.repo, branch, sourceArchive, progressCb);

    if (folder) {
      if (statusCb) await statusCb("zip");
      await zipFolder(sourceArchive, outputArchive, folder);
    } else {
      await fs.promises.rename(sourceArchive, outputArchive);
    }

    const safeRepo = target.repo.replace(/[^A-Za-z0-9_.-]/g, "_");
    const safeBranch = branch.replace(/[^A-Za-z0-9_.-]/g, "_");
    const filename = `${safeRepo}-${safeBranch}.zip`;
    return {
      filepath: outputArchive,
      filename,
      owner: target.owner,
      repo: target.repo,
      branch,
      folder,
      size: fs.statSync(outputArchive).size,
    };
  } catch (err) {
    if (err instanceof ClientError || err instanceof TimeoutError) {
      throw new GitHubDownloadError("Request GitHub timeout atau koneksi gagal");
    }
    throw err;
  } finally {
    cleanupFile(sourceArchive);
    await session.close();
  }
}

module.exports = {
  GitHubDownloadError,
  parseGithubUrl,
  downloadGithub,
};

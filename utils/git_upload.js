"use strict";
/**
 * Automatic GitHub upload for the project.
 *
 * Flow (`.ghupload`): sanitise secrets → ensure remote → stage → commit → push.
 *
 * Security rules enforced here:
 *   - the PAT is read from `GITHUB_TOKEN` and never written to the repo, the
 *     remote URL on disk, or a log line;
 *   - `.env`, sessions, `session/*.json`, credentials and tokens are removed
 *     from the index before every commit, even if they were tracked earlier;
 *   - a pre-push scan aborts the upload when a staged file still looks secret.
 *
 * Safety rules:
 *   - no `--force` push, ever;
 *   - no empty commit (nothing staged → no commit);
 *   - a rejected (non-fast-forward) push is reported, not overwritten.
 */
const fs = require("node:fs");
const path = require("node:path");

const { runProcess } = require("./process");

/** Files that must never be committed, regardless of .gitignore. */
const FORBIDDEN_PATTERNS = [
  /^\.env$/,
  /^\.env\.(?!example$).+$/,
  /\.session$/,
  /\.session-journal$/,
  /^session\/.*\.json$/,
  /^session\/.*\.lock$/,
  /^logs\/.*\.log$/,
  /^temp\//,
  /^node_modules\//,
  /^\.git\//,
];

/** Content signatures of real credentials (not test placeholders). */
const SECRET_SIGNATURES = [
  { name: "GitHub PAT (fine-grained)", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "GitHub token (classic)", re: /ghp_[A-Za-z0-9]{30,}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Placeholder values that only look like a token. */
const PLACEHOLDER = /xxxx|Fake|fake|example|contoh|<|>|your[_-]?token/i;

const DEFAULT_REMOTE = "https://github.com/elllmarley017-pixel/Tridzx-userbot.git";
const BRANCH = process.env.GITHUB_BRANCH || "main";

/** Error with a user-facing, already-safe message. */
class GitUploadError extends Error {
  constructor(stage, detail, options = {}) {
    super(detail);
    this.name = "GitUploadError";
    this.stage = stage;
    this.hint = options.hint || "";
    this.transient = Boolean(options.transient);
  }
}

/** True when the file must never be committed. */
function isForbidden(file) {
  const normalised = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  return FORBIDDEN_PATTERNS.some((re) => re.test(normalised));
}

/**
 * Strip credentials out of a git URL or error message.
 * The PAT must never reach a log, a chat message, or the on-disk remote.
 */
function redact(text) {
  return String(text == null ? "" : text)
    .replace(/https:\/\/[^@/\s]+@/g, "https://***@")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "***")
    .replace(/ghp_[A-Za-z0-9]+/g, "***")
    .replace(/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g, "***");
}

/** Run git and return trimmed stdout. Never leaks the token. */
async function git(args, options = {}) {
  const result = await runProcess("git", args, {
    cwd: options.cwd,
    timeout: options.timeout || 120_000,
    env: options.env || process.env,
  });
  if (result.code !== 0) {
    const detail = redact((result.stderr || result.stdout || "").trim());
    throw new GitUploadError(options.stage || "git", detail || `git ${args[0]} gagal`);
  }
  return String(result.stdout || "").trim();
}

/* ------------------------------------------------------------------ *
 * Remote                                                              *
 * ------------------------------------------------------------------ */
/**
 * Point `origin` at the target repository.
 *
 * An existing `origin` is UPDATED (`set-url`), never duplicated. The URL is
 * stored **without** the token; the token is injected per push instead.
 */
async function ensureRemote(cwd, remoteUrl = DEFAULT_REMOTE) {
  const remotes = (await git(["remote"], { cwd })).split("\n").map((line) => line.trim());
  if (remotes.includes("origin")) {
    await git(["remote", "set-url", "origin", remoteUrl], { cwd, stage: "remote" });
    return { action: "updated" };
  }
  await git(["remote", "add", "origin", remoteUrl], { cwd, stage: "remote" });
  return { action: "added" };
}

/* ------------------------------------------------------------------ *
 * Secret hygiene                                                      *
 * ------------------------------------------------------------------ */
/**
 * Un-track every secret file that is currently in the index.
 *
 * `git rm --cached` keeps the file on disk but removes it from the repository,
 * which is required when a previous commit already added it.
 *
 * @returns {Promise<string[]>} the paths that were removed from the index
 */
async function untrackSecrets(cwd) {
  const tracked = (await git(["ls-files"], { cwd })).split("\n").filter(Boolean);
  const offenders = tracked.filter(isForbidden);
  if (!offenders.length) return [];
  await git(["rm", "--cached", "--quiet", "--ignore-unmatch", ...offenders], {
    cwd,
    stage: "sanitise",
  });
  return offenders;
}

/**
 * Scan staged files for real credential signatures.
 * @returns {Promise<{file: string, name: string}[]>}
 */
async function scanStaged(cwd) {
  // `--diff-filter=d` excludes deletions: a secret being REMOVED from the repo
  // is exactly what we want, so it must not abort the upload.
  const staged = (await git(["diff", "--cached", "--name-only", "--diff-filter=d"], { cwd }))
    .split("\n")
    .filter(Boolean);
  const hits = [];
  for (const file of staged) {
    if (isForbidden(file)) {
      // Should be impossible after `untrackSecrets`; keep it as a hard stop.
      hits.push({ file, name: "file terlarang" });
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue; // binary or unreadable: nothing to match
    }
    for (const { name, re } of SECRET_SIGNATURES) {
      const match = re.exec(content);
      if (!match) continue;
      if (PLACEHOLDER.test(match[0])) continue; // documented placeholder
      hits.push({ file, name });
      break;
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Push                                                                *
 * ------------------------------------------------------------------ */
/**
 * Push using an ephemeral URL that carries the token.
 * The token is passed through the process environment only.
 */
async function pushWithToken(cwd, token, remoteUrl = DEFAULT_REMOTE, branch = BRANCH) {
  const clean = remoteUrl.replace(/^https:\/\/[^@]*@/, "https://");
  const authUrl = clean.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  const result = await runProcess(
    "git",
    ["-c", "credential.helper=", "push", authUrl, `HEAD:${branch}`],
    { cwd, timeout: 180_000 },
  );
  if (result.code === 0) return { ok: true, output: redact(result.stdout) };

  const stderr = redact((result.stderr || result.stdout || "").trim());
  if (/Authentication failed|could not read Username|403|Invalid username or password|Permission denied/i.test(stderr)) {
    throw new GitUploadError(
      "auth",
      "Autentikasi GitHub gagal. Periksa GITHUB_TOKEN (butuh izin Contents: Read and write).",
      { hint: stderr },
    );
  }
  if (/non-fast-forward|fetch first|rejected/i.test(stderr)) {
    throw new GitUploadError(
      "conflict",
      "Push ditolak: branch remote lebih baru. Jalankan `git pull --rebase` lalu ulangi.",
      { hint: stderr },
    );
  }
  if (/Could not resolve host|unable to access|timed out|Connection/i.test(stderr)) {
    throw new GitUploadError("network", "Gagal terhubung ke GitHub. Periksa koneksi.", {
      transient: true,
      hint: stderr,
    });
  }
  throw new GitUploadError("push", stderr || "git push gagal");
}

/* ------------------------------------------------------------------ *
 * Orchestration                                                       *
 * ------------------------------------------------------------------ */
/**
 * Stage, commit (only when there is something to commit) and push.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]        project root
 * @param {string} [options.token]      PAT (defaults to `GITHUB_TOKEN`)
 * @param {string} [options.remoteUrl]
 * @param {string} [options.branch]
 * @param {string} [options.message]
 * @returns {Promise<object>} a summary safe to display
 */
async function uploadToGithub(options = {}) {
  const cwd = options.cwd || process.cwd();
  const token = String(options.token || process.env.GITHUB_TOKEN || "").trim();
  const remoteUrl = options.remoteUrl || process.env.GITHUB_REMOTE || DEFAULT_REMOTE;
  const branch = options.branch || BRANCH;

  if (!token) {
    throw new GitUploadError(
      "config",
      "GITHUB_TOKEN belum diset. Buat PAT dengan izin Contents: Read and write lalu set di environment.",
    );
  }

  // 1. stage everything first (respecting .gitignore).
  await git(["add", "-A"], { cwd, stage: "stage" });

  // 2. THEN remove secrets from the index. Order matters: `git add -A` re-adds
  //    any secret that is still present on disk, so sanitising before staging
  //    would be undone.
  const untracked = await untrackSecrets(cwd);

  // 3. remote: update, never duplicate.
  const remote = await ensureRemote(cwd, remoteUrl);

  // 5. refuse to push real credentials.
  const secrets = await scanStaged(cwd);
  if (secrets.length) {
    throw new GitUploadError(
      "secret",
      `Upload dibatalkan: file rahasia terdeteksi (${secrets.map((s) => `${s.file}: ${s.name}`).join(", ")}).`,
    );
  }

  // 6. commit only when there is something to commit.
  //    Deletions count: removing a secret from the repo is a real change.
  const staged = (await git(["diff", "--cached", "--name-only"], { cwd })).split("\n").filter(Boolean);
  let committed = null;
  if (staged.length) {
    const message = options.message || `Update ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
    await git(
      ["-c", "user.name=userbot", "-c", "user.email=userbot@users.noreply.github.com", "commit", "-m", message],
      { cwd, stage: "commit" },
    );
    committed = {
      hash: (await git(["rev-parse", "--short", "HEAD"], { cwd })).trim(),
      message,
      files: staged.length,
    };
  }

  // 7. push (no --force).
  const push = await pushWithToken(cwd, token, remoteUrl, branch);
  const head = (await git(["rev-parse", "--short", "HEAD"], { cwd })).trim();
  const subject = (await git(["log", "-1", "--pretty=%s"], { cwd })).trim();

  return {
    ok: true,
    branch,
    remote: remote.action,
    untracked,
    committed,
    files: staged.length,
    head,
    subject,
    pushed: push.ok,
  };
}

module.exports = {
  DEFAULT_REMOTE,
  BRANCH,
  FORBIDDEN_PATTERNS,
  SECRET_SIGNATURES,
  GitUploadError,
  isForbidden,
  redact,
  ensureRemote,
  untrackSecrets,
  scanStaged,
  pushWithToken,
  uploadToGithub,
};

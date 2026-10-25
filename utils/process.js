"use strict";
/**
 * Process helpers — the Node.js replacement for `asyncio.create_subprocess_exec`.
 *
 * Wraps `node:child_process.spawn` with:
 *   - a hard timeout,
 *   - streamed stdout/stderr with optional line callbacks,
 *   - graceful SIGKILL fallback,
 *   - staged, deterministic error messages.
 */
const { spawn } = require("node:child_process");

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

class ProcessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProcessError";
    this.code = options.code;
    this.stderr = options.stderr || "";
    this.stdout = options.stdout || "";
    this.signal = options.signal;
  }
}

/**
 * Run a binary to completion.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {number} [options.timeout]  Milliseconds before SIGKILL.
 * @param {(line:string)=>void} [options.onStdoutLine]
 * @param {(line:string)=>void} [options.onStderrLine]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const flushLines = (data, onLine, sink) => {
      sink.chunk += data.toString("utf8");
      const lines = sink.chunk.split("\n");
      sink.chunk = lines.pop();
      for (const line of lines) {
        if (onLine) {
          try {
            onLine(line);
          } catch {
            /* ignore callback errors */
          }
        }
      }
    };

    const outSink = { chunk: "" };
    const errSink = { chunk: "" };

    child.stdout?.on("data", (data) => {
      stdout += data.toString("utf8");
      flushLines(data, options.onStdoutLine, outSink);
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString("utf8");
      flushLines(data, options.onStderrLine, errSink);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new ProcessError(`Gagal menjalankan ${command}: ${err.message}`, { stderr }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.timeout && signal === "SIGKILL") {
        reject(
          new ProcessError(`Proses timeout setelah ${options.timeout} ms`, {
            code,
            stderr,
            stdout,
            signal,
          }),
        );
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (options.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, options.timeout);
      if (timer.unref) timer.unref();
    }
  });
}

/** Run ffmpeg and reject on non-zero exit. */
async function runFfmpeg(args, options = {}) {
  const result = await runProcess(FFMPEG_BIN, ["-hide_banner", "-loglevel", "error", "-y", ...args], options);
  if (result.code !== 0) {
    throw new ProcessError(`ffmpeg gagal (exit ${result.code})`, {
      code: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  return result;
}

/** Probe a media file for its duration in seconds (best effort). */
async function probeDuration(filePath) {
  try {
    const result = await runProcess(FFPROBE_BIN, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const value = parseFloat(result.stdout.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  runProcess,
  runFfmpeg,
  probeDuration,
  ProcessError,
  FFMPEG_BIN,
  FFPROBE_BIN,
};

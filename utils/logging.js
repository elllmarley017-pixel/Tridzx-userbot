"use strict";
/**
 * Rotating file logger — the Node.js replacement for Python's
 * `logging.handlers.RotatingFileHandler`.
 *
 * Writes UTF-8 log records to `logs/activity.log`, rotating to numbered backups
 * once the file exceeds `maxBytes`, keeping at most `backupCount` archives.
 */
const fs = require("node:fs");
const path = require("node:path");

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

class RotatingFileHandler {
  constructor(filename, options = {}) {
    this.filename = filename;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.backupCount = options.backupCount ?? 3;
    this.encoding = options.encoding || "utf8";
    this._fd = null;
    this._size = 0;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this._open();
  }

  _open() {
    try {
      this._fd = fs.openSync(this.filename, "a");
      this._size = this._statSize();
    } catch (err) {
      this._fd = null;
      throw err;
    }
  }

  _statSize() {
    try {
      return fs.statSync(this.filename).size;
    } catch {
      return 0;
    }
  }

  _rotate() {
    try {
      if (this._fd != null) fs.closeSync(this._fd);
    } catch {
      /* ignore */
    }
    this._fd = null;
    for (let index = this.backupCount - 1; index >= 1; index -= 1) {
      const source = `${this.filename}.${index}`;
      const target = `${this.filename}.${index + 1}`;
      if (fs.existsSync(source)) {
        try {
          fs.renameSync(source, target);
        } catch {
          /* ignore */
        }
      }
    }
    if (fs.existsSync(this.filename)) {
      try {
        fs.renameSync(this.filename, `${this.filename}.1`);
      } catch {
        /* ignore */
      }
    }
    this._open();
  }

  write(record) {
    if (this._fd == null) this._open();
    const payload = String(record);
    const size = Buffer.byteLength(payload, this.encoding);
    if (this._size + size > this.maxBytes) {
      this._rotate();
    }
    fs.writeSync(this._fd, payload, null, this.encoding);
    this._size += size;
  }

  close() {
    if (this._fd != null) {
      try {
        fs.closeSync(this._fd);
      } catch {
        /* ignore */
      }
      this._fd = null;
    }
  }
}

const FORMATTER = (level, message) => `${level}\n${message}\n${"-".repeat(48)}\n`;

function createLogger(name, options = {}) {
  const handlers = [];
  const logger = {
    name,
    level: options.level ?? "INFO",
    propagate: false,
    enabled: true,
    addHandler(handler) {
      handlers.push(handler);
      return handler;
    },
    _emit(level, message) {
      if (!logger.enabled) return;
      if (LEVELS[level] < (LEVELS[logger.level] ?? 20)) return;
      const record = (options.formatter || FORMATTER)(level, message);
      for (const handler of handlers) {
        try {
          handler.write(record);
        } catch {
          /* logging must never crash the caller */
        }
      }
    },
    debug(message) {
      logger._emit("DEBUG", message);
    },
    info(message) {
      logger._emit("INFO", message);
    },
    warning(message) {
      logger._emit("WARNING", message);
    },
    error(message) {
      logger._emit("ERROR", message);
    },
    critical(message) {
      logger._emit("CRITICAL", message);
    },
  };
  return logger;
}

function createStreamHandler(stream = process.stderr) {
  return {
    write(record) {
      try {
        stream.write(record);
      } catch {
        /* ignore */
      }
    },
  };
}

function createFileHandler(filename, options = {}) {
  return new RotatingFileHandler(filename, options);
}

module.exports = {
  LEVELS,
  RotatingFileHandler,
  createLogger,
  createFileHandler,
  createStreamHandler,
};

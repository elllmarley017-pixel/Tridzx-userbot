"use strict";
/**
 * Portable SQLite driver.
 *
 * Prefers Node's built-in `node:sqlite` (Node >= 22.5) and transparently
 * falls back to the pure-WASM `node-sqlite3-wasm` package on older runtimes
 * (Node 18/20). The fallback needs no native build toolchain, which matters on
 * Termux/Android and inside minimal containers, and works from `/sdcard` where
 * native `.node` addons cannot be `dlopen()`ed.
 *
 * Both drivers are normalised to the same small surface used by `tl_session`:
 *   db.exec(sql)
 *   db.prepare(sql) -> { get(...params), all(...params), run(...params), setReadBigInts(bool) }
 *   db.close()
 *
 * Integer columns are surfaced as JS `bigint` by both drivers, preserving the
 * int64 peer IDs Telegram uses.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * `node-sqlite3-wasm` guards the database with a sibling `<file>.lock`
 * directory. A hard crash can leave an empty one behind, permanently blocking
 * the next open, so reclaim stale empty locks before connecting.
 */
function clearStaleLock(filePath) {
  const lockPath = `${filePath}.lock`;
  try {
    if (!fs.existsSync(lockPath)) return;
    if (!fs.statSync(lockPath).isDirectory()) return;
    if (fs.readdirSync(lockPath).length === 0) fs.rmdirSync(lockPath);
  } catch {
    /* best effort — a live lock will simply block, as intended */
  }
}

/** @returns {{kind:string, open:(file:string)=>object}} */
function resolveDriver() {
  // 1. Built-in (Node >= 22.5).
  try {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require("node:sqlite");
    if (DatabaseSync) {
      return {
        kind: "node:sqlite",
        open(file) {
          const db = new DatabaseSync(file);
          return wrapNativeSync(db);
        },
      };
    }
  } catch {
    /* fall through to WASM */
  }

  // 2. Pure-WASM fallback.
  const wasm = require("node-sqlite3-wasm");
  const Database = wasm.Database || wasm.default;
  if (!Database) {
    throw new Error("Tidak ada driver SQLite yang tersedia (node:sqlite / node-sqlite3-wasm)");
  }
  return {
    kind: "node-sqlite3-wasm",
    open(file) {
      return wrapWasm(new Database(file));
    },
  };
}

const DRIVER = resolveDriver();

/**
 * `node:sqlite` almost matches the shared surface already; we only add a
 * compatibility no-op for `setReadBigInts` in case an older build exposes
 * integers as numbers by default.
 */
function wrapNativeSync(db) {
  return {
    __raw: db,
    __kind: "node:sqlite",
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      if (typeof stmt.setReadBigInts !== "function") {
        stmt.setReadBigInts = () => {};
      }
      const normalize = (row) => (row === undefined ? undefined : row);
      return {
        get(...params) {
          return normalize(callNative(stmt, "get", params));
        },
        all(...params) {
          return (callNative(stmt, "all", params) || []).map(normalize);
        },
        run(...params) {
          return callNative(stmt, "run", params);
        },
        setReadBigInts(value) {
          stmt.setReadBigInts(value);
        },
      };
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function callNative(stmt, method, params) {
  const fn = stmt[method];
  if (!fn) throw new Error(`Statement tidak mendukung ${method}()`);
  return params.length ? fn.call(stmt, ...params) : fn.call(stmt);
}

/**
 * `node-sqlite3-wasm` accepts params either as a single array or as variadic
 * arguments. Normalise both call styles into the array form it expects, and add
 * the `setReadBigInts` no-op (large integers are always `bigint` there).
 */
function wrapWasm(db) {
  const toParams = (params) => {
    if (params.length === 1 && Array.isArray(params[0])) return params[0];
    return params;
  };
  return {
    __raw: db,
    __kind: "node-sqlite3-wasm",
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get(...params) {
          return stmt.get(toParams(params));
        },
        all(...params) {
          return stmt.all(toParams(params));
        },
        run(...params) {
          return stmt.run(toParams(params));
        },
        setReadBigInts() {
          /* always bigint */
        },
      };
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Open (and create parent directories for) a database file. */
function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  clearStaleLock(filePath);
  const db = DRIVER.open(filePath);
  try {
    // Wait up to 5s for a competing writer instead of failing instantly.
    db.__raw.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* pragma is best effort */
  }
  return db;
}

module.exports = { openDatabase, clearStaleLock, driverKind: DRIVER.kind };

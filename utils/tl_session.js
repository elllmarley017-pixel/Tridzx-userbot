"use strict";
/**
 * GramJS session backed by the existing Telethon SQLite file.
 *
 * The userbot has always stored its login in `session/userbot.session`, a
 * SQLite database whose schema is defined by Telethon's `SQLiteSession`. This
 * class reads that exact schema so the Node.js port reuses the already
 * authenticated account, and writes any new entities back in the same format.
 *
 * Schema (created here when absent, so a fresh install still works):
 *   version(version)
 *   sessions(dc_id, server_address, port, auth_key, takeout_id)
 *   entities(id, hash, username, phone, name, date)
 *   sent_files(md5_digest, file_size, type, id, hash)
 *   update_state(id, pts, qts, date, seq)
 */
const fs = require("node:fs");
const { openDatabase } = require("./sqlite");

const { MemorySession } = require("telegram/sessions");
const { AuthKey } = require("telegram/crypto/AuthKey");
const { Api } = require("telegram");
const bigInt = require("big-integer");

const SESSION_VERSION = 7;

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS version (version integer primary key);
    CREATE TABLE IF NOT EXISTS sessions (
      dc_id integer primary key,
      server_address text,
      port integer,
      auth_key blob,
      takeout_id integer
    );
    CREATE TABLE IF NOT EXISTS entities (
      id integer primary key,
      hash integer not null,
      username text,
      phone integer,
      name text,
      date integer
    );
    CREATE TABLE IF NOT EXISTS sent_files (
      md5_digest blob,
      file_size integer,
      type integer,
      id integer,
      hash integer,
      primary key(md5_digest, file_size, type)
    );
    CREATE TABLE IF NOT EXISTS update_state (
      id integer primary key,
      pts integer,
      qts integer,
      date integer,
      seq integer
    );
  `);
}

class SQLiteSession extends MemorySession {
  /**
   * @param {string} sessionName Absolute path *without* the `.session` suffix,
   *   matching `config.SESSION_NAME`.
   */
  constructor(sessionName) {
    super();
    this.sessionName = sessionName;
    this.filePath = `${sessionName}.session`;
    this._serverAddress = undefined;
    this._dcId = 0;
    this._port = undefined;
    this._authKey = undefined;
    this._takeoutId = undefined;
    this._entities = new Set();
    this._authKeys = new Map();
    this._mainDcId = 0;
    this._db = null;
    this._entityCache = [];
  }

  _connect() {
    if (this._db) return this._db;
    this._db = openDatabase(this.filePath);
    createSchema(this._db);
    return this._db;
  }

  async load() {
    const db = this._connect();
    const version = db.prepare("select version from version limit 1").get();
    if (!version) {
      db.prepare("insert into version values (?)").run(SESSION_VERSION);
    } else if (version.version !== SESSION_VERSION) {
      throw new Error(
        `Unsupported session version ${version.version} (expected ${SESSION_VERSION}).`,
      );
    }

    const sessionStmt = db.prepare(
      "select dc_id, server_address, port, auth_key, takeout_id from sessions limit 1",
    );
    sessionStmt.setReadBigInts(true);
    const session = sessionStmt.get();
    if (session) {
      this._dcId = Number(session.dc_id);
      this._mainDcId = this._dcId;
      this._serverAddress = session.server_address;
      this._mainServerAddress = session.server_address;
      this._port = Number(session.port);
      this._mainPort = Number(session.port);
      this._takeoutId = session.takeout_id == null ? undefined : session.takeout_id;
      if (session.auth_key) {
        const authKey = new AuthKey();
        // `setKey` derives `keyId`, `auxHash` and `_hash` from the raw key
        // material, which GramJS needs for the MTProto handshake.
        await authKey.setKey(Buffer.from(session.auth_key));
        this._authKey = authKey;
      }
    }

    const entityStmt = db.prepare("select id, hash, username, phone, name from entities");
    entityStmt.setReadBigInts(true);
    const rows = entityStmt.all();
    this._entityCache = rows.map((row) => ({
      id: String(row.id),
      hash: String(row.hash),
      username: row.username,
      phone: row.phone,
      name: row.name,
    }));
    // Seed the in-memory set so StoreSession methods work unchanged. IDs and
    // hashes exceed the safe integer range (Telegram peer IDs are int64), so
    // they are kept as bigInt to avoid precision loss.
    for (const row of this._entityCache) {
      this._entities.add([
        bigInt(row.id),
        bigInt(row.hash ?? "0"),
        row.username ?? undefined,
        row.phone ?? undefined,
        row.name ?? undefined,
      ]);
    }
  }

  getEntityRowsById(id, exact = true) {
    const target = typeof id === "object" && id !== null ? id.toString() : String(id);
    if (exact) {
      const row = this._entityCache.find((item) => item.id === target);
      if (row) return [bigInt(row.id), bigInt(row.hash)];
      return undefined;
    }
    const suffix = target;
    const row = this._entityCache.find(
      (item) => item.id === suffix || item.id.endsWith(suffix) || suffix.endsWith(item.id),
    );
    if (row) return [bigInt(row.id), bigInt(row.hash)];
    return super.getEntityRowsById(id, exact);
  }

  getEntityRowsByPhone(phone) {
    const row = this._entityCache.find((item) => String(item.phone) === String(phone));
    return row ? [bigInt(row.id), bigInt(row.hash)] : super.getEntityRowsByPhone(phone);
  }

  getEntityRowsByUsername(username) {
    const row = this._entityCache.find((item) => item.username === username);
    return row ? [bigInt(row.id), bigInt(row.hash)] : super.getEntityRowsByUsername(username);
  }

  getEntityRowsByName(name) {
    const row = this._entityCache.find((item) => item.name === name);
    return row ? [bigInt(row.id), bigInt(row.hash)] : super.getEntityRowsByName(name);
  }

  /**
   * Track the active DC in memory only.
   *
   * GramJS calls this while borrowing senders for other data centres; if we
   * persisted those we would overwrite the authenticated main session (this is
   * what originally corrupted the Telethon file). Persistence only happens when
   * an auth key for the main DC is written via the `authKey` setter.
   */
  setDC(dcId, serverAddress, port) {
    this._dcId = dcId;
    this._serverAddress = serverAddress;
    this._port = port;
  }

  /** Persist the main session row (dc_id + auth_key) exactly once. */
  _persistMainSession() {
    if (!this._db) return;
    try {
      this._db.prepare("delete from sessions").run();
      this._db
        .prepare(
          "insert into sessions (dc_id, server_address, port, auth_key, takeout_id) values (?,?,?,?,?)",
        )
        .run(
          this._mainDcId || this._dcId,
          this._mainServerAddress || this._serverAddress,
          this._mainPort || this._port,
          this._authKey ? Buffer.from(this._authKey.getKey()) : null,
          this._takeoutId == null ? null : Number(this._takeoutId),
        );
    } catch {
      /* ignore persistence errors */
    }
  }

  get dcId() {
    return this._dcId;
  }

  get serverAddress() {
    return this._serverAddress;
  }

  get port() {
    return this._port;
  }

  get authKey() {
    return this._authKey;
  }

  set authKey(value) {
    this._authKey = value;
    this._persistMainSession();
  }

  get takeoutId() {
    return this._takeoutId;
  }

  set takeoutId(value) {
    this._takeoutId = value;
    this._persistMainSession();
  }

  getAuthKey(dcId) {
    if (!dcId || dcId === this.dcId) return this.authKey;
    return this._authKeys.get(Number(dcId));
  }

  setAuthKey(authKey, dcId) {
    if (dcId && Number(dcId) !== this.dcId) {
      const key = Number(dcId);
      if (authKey) this._authKeys.set(key, authKey);
      else this._authKeys.delete(key);
      return;
    }
    this.authKey = authKey;
  }

  processEntities(tlo) {
    const rows = super._entitiesToRows ? super._entitiesToRows(tlo) : [];
    if (!rows || !rows.length) return;
    const db = this._connect();
    const insert = db.prepare(
      "insert or replace into entities (id, hash, username, phone, name, date) values (?,?,?,?,?,?)",
    );
    for (const row of rows) {
      const [id, hash, username, phone, name] = row;
      try {
        insert.run(
          typeof id === "object" && id !== null ? id.toString() : String(id),
          typeof hash === "object" && hash !== null ? hash.toString() : String(hash ?? "0"),
          username ?? null,
          phone ?? null,
          name ?? null,
          Math.floor(Date.now() / 1000),
        );
      } catch {
        /* ignore malformed entity rows */
      }
    }
    super.processEntities(tlo);
  }

  save() {
    /* Writes happen eagerly; nothing to flush. */
  }

  close() {
    /* Keep the handle open for the process lifetime. */
  }

  delete() {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* ignore */
      }
      this._db = null;
    }
    try {
      if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { SQLiteSession, SESSION_VERSION, Api, bigInt };

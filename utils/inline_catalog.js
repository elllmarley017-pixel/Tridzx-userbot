"use strict";
/**
 * Inline content catalogue.
 *
 * The userbot *owns* the content (it is the account that can see/download it),
 * while the Bot API process *serves* it in Inline Mode. Both are separate
 * processes, so the catalogue is persisted as JSON and read by whichever
 * process needs it:
 *
 *   userbot  .inline add <judul>  (reply ke teks/foto/video/dokumen)
 *              └─ media diunduh via MTProto → diunggah ke Bot API → file_id
 *              └─ metadata + file_id disimpan di session/inline_catalog.json
 *
 *   bot      @bot <query>         (Inline Mode)
 *              └─ baca katalog → answerInlineQuery (cached file_id)
 *              └─ saat hasil dipilih, Telegram mengirim konten sebagai bot
 *
 * Item shape:
 *   {
 *     id: "c3",                    // stabil, dipakai di inline result id
 *     type: "text"|"photo"|"video"|"document"|"audio"|"animation"|"voice",
 *     title, description, tags: [],
 *     text,                        // type "text"
 *     caption,                     // media caption (HTML)
 *     file_id, file_unique_id,     // Bot API cache reference
 *     mime, size, duration, width, height, file_name,
 *     uploaded: true|false,        // false → media masih lokal, perlu upload
 *     local_path,                  // media yang belum terunggah
 *     created_at, updated_at,
 *     source: { chat_id, message_id }
 *   }
 */
const fs = require("node:fs");
const path = require("node:path");

const { INLINE_CATALOG_FILE, INLINE_MEDIA_DIR } = require("../config");

/** Media kinds understood by the Telegram Inline Query API. */
const MEDIA_TYPES = ["photo", "video", "document", "audio", "animation", "voice"];
const ALL_TYPES = ["text", ...MEDIA_TYPES];

const MAX_ITEMS = Math.max(50, Number(process.env.INLINE_CATALOG_MAX || 2000) || 2000);
const MAX_TITLE = 120;
const MAX_TEXT = 4000;
const MAX_CAPTION = 1024;
const MAX_TAGS = 20;

const EMPTY = () => ({ version: 1, next_id: 1, items: [] });

/* ------------------------------------------------------------------ *
 * Persistence                                                        *
 * ------------------------------------------------------------------ */
function ensureDir() {
  fs.mkdirSync(path.dirname(INLINE_CATALOG_FILE), { recursive: true });
}

function ensureMediaDir() {
  fs.mkdirSync(INLINE_MEDIA_DIR, { recursive: true });
  return INLINE_MEDIA_DIR;
}

function normalizeString(value, max) {
  const out = String(value == null ? "" : value).trim();
  return max ? out.slice(0, max) : out;
}

function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value == null ? "" : value).split(/[,\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = normalizeString(raw, 40).replace(/^#/, "").toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Coerce an on-disk payload into a well-formed state object. */
function normalize(raw) {
  const state = EMPTY();
  if (!raw || typeof raw !== "object") return state;

  const nextId = Number(raw.next_id);
  if (Number.isInteger(nextId) && nextId > 0) state.next_id = nextId;

  const items = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const id = normalizeString(entry.id, 24);
    if (!id || seen.has(id)) continue;
    const type = String(entry.type || "").toLowerCase();
    if (!ALL_TYPES.includes(type)) continue;
    seen.add(id);
    state.items.push({
      id,
      type,
      title: normalizeString(entry.title, MAX_TITLE) || `Konten ${id}`,
      description: normalizeString(entry.description, 200),
      tags: normalizeTags(entry.tags),
      text: normalizeString(entry.text, MAX_TEXT),
      caption: normalizeString(entry.caption, MAX_CAPTION),
      file_id: normalizeString(entry.file_id, 512),
      file_unique_id: normalizeString(entry.file_unique_id, 128),
      mime: normalizeString(entry.mime, 128),
      file_name: normalizeString(entry.file_name, 200),
      audio_title: normalizeString(entry.audio_title, 64),
      performer: normalizeString(entry.performer, 64),
      size: Number(entry.size) || 0,
      duration: Number(entry.duration) || 0,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      uploaded: Boolean(entry.uploaded && entry.file_id),
      local_path: normalizeString(entry.local_path, 512),
      created_at: normalizeString(entry.created_at, 40) || new Date(0).toISOString(),
      updated_at: normalizeString(entry.updated_at, 40) || "",
      source: entry.source && typeof entry.source === "object" ? {
        chat_id: entry.source.chat_id ?? null,
        message_id: entry.source.message_id ?? null,
      } : null,
    });
  }
  return state;
}

/** Read the catalogue (never throws; empty catalogue on error). */
function load() {
  try {
    if (!fs.existsSync(INLINE_CATALOG_FILE)) return EMPTY();
    return normalize(JSON.parse(fs.readFileSync(INLINE_CATALOG_FILE, "utf8")));
  } catch {
    return EMPTY();
  }
}

/** Persist atomically (tmp + rename) so a crash cannot truncate the file. */
function save(state) {
  ensureDir();
  const payload = JSON.stringify(normalize(state), null, 2);
  const tmp = `${INLINE_CATALOG_FILE}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, INLINE_CATALOG_FILE);
  return payload;
}

function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return result === undefined ? state : result;
}

/* ------------------------------------------------------------------ *
 * CRUD                                                               *
 * ------------------------------------------------------------------ */
function items() {
  return load().items;
}

function get(id) {
  const key = normalizeString(id, 24);
  return items().find((item) => item.id === key) || null;
}

/**
 * Insert one item.
 * @returns {{item: object, total: number}}
 */
function add(input = {}) {
  const type = String(input.type || "text").toLowerCase();
  if (!ALL_TYPES.includes(type)) throw new TypeError(`Tipe konten tidak didukung: ${type}`);

  const now = new Date().toISOString();
  const state = load();
  if (state.items.length >= MAX_ITEMS) {
    throw new RangeError(
      `Katalog penuh (${MAX_ITEMS} item). Hapus item lama dengan .inline del <id>.`,
    );
  }

  const id = `c${state.next_id}`;
  const item = {
    id,
    type,
    title: normalizeString(input.title, MAX_TITLE) || `Konten ${id}`,
    description: normalizeString(input.description, 200),
    tags: normalizeTags(input.tags),
    text: type === "text" ? normalizeString(input.text, MAX_TEXT) : "",
    caption: normalizeString(input.caption, MAX_CAPTION),
    file_id: normalizeString(input.file_id, 512),
    file_unique_id: normalizeString(input.file_unique_id, 128),
    mime: normalizeString(input.mime, 128),
    file_name: normalizeString(input.file_name, 200),
    audio_title: normalizeString(input.audio_title, 64),
    performer: normalizeString(input.performer, 64),
    size: Number(input.size) || 0,
    duration: Number(input.duration) || 0,
    width: Number(input.width) || 0,
    height: Number(input.height) || 0,
    local_path: normalizeString(input.local_path, 512),
    created_at: now,
    updated_at: now,
    source: input.source || null,
  };
  item.uploaded = Boolean(input.uploaded && item.file_id);

  if (type === "text" && !item.text) {
    throw new TypeError("Konten teks tidak boleh kosong.");
  }
  if (type !== "text" && !item.file_id && !item.local_path) {
    throw new TypeError(`Konten ${type} membutuhkan file_id atau file lokal.`);
  }

  state.items.push(item);
  state.next_id += 1;
  save(state);
  return { item, total: state.items.length };
}

function updateItem(id, patch = {}) {
  const key = normalizeString(id, 24);
  let updated = null;
  update((state) => {
    const item = state.items.find((entry) => entry.id === key);
    if (!item) return;
    if (patch.title !== undefined) item.title = normalizeString(patch.title, MAX_TITLE) || item.title;
    if (patch.description !== undefined) item.description = normalizeString(patch.description, 200);
    if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags);
    if (patch.caption !== undefined) item.caption = normalizeString(patch.caption, MAX_CAPTION);
    if (patch.text !== undefined) item.text = normalizeString(patch.text, MAX_TEXT);
    if (patch.file_id !== undefined) item.file_id = normalizeString(patch.file_id, 512);
    if (patch.file_unique_id !== undefined) {
      item.file_unique_id = normalizeString(patch.file_unique_id, 128);
    }
    if (patch.local_path !== undefined) item.local_path = normalizeString(patch.local_path, 512);
    if (patch.uploaded !== undefined) item.uploaded = Boolean(patch.uploaded && item.file_id);
    item.updated_at = new Date().toISOString();
    updated = item;
  });
  return updated;
}

/** Delete one item and its local media copy (if any). */
function remove(id) {
  const key = normalizeString(id, 24);
  let removed = null;
  update((state) => {
    const index = state.items.findIndex((entry) => entry.id === key);
    if (index === -1) return;
    removed = state.items[index];
    state.items.splice(index, 1);
  });
  if (removed && removed.local_path) {
    try {
      if (fs.existsSync(removed.local_path)) fs.rmSync(removed.local_path, { force: true });
    } catch {
      /* a leftover temp file must not break deletion */
    }
  }
  return removed;
}

/** Delete every item (used by `.inline clear`). */
function clear() {
  let count = 0;
  update((state) => {
    count = state.items.length;
    state.items = [];
    state.next_id = 1;
  });
  return count;
}

/* ------------------------------------------------------------------ *
 * Search                                                             *
 * ------------------------------------------------------------------ */
/** Words that only describe a media kind and never a title. */
const TYPE_WORDS = new Map([
  ["text", "text"],
  ["teks", "text"],
  ["foto", "photo"],
  ["photo", "photo"],
  ["gambar", "photo"],
  ["video", "video"],
  ["vidio", "video"],
  ["dokumen", "document"],
  ["document", "document"],
  ["doc", "document"],
  ["file", "document"],
  ["audio", "audio"],
  ["lagu", "audio"],
  ["musik", "audio"],
  ["music", "audio"],
  ["animasi", "animation"],
  ["animation", "animation"],
  ["gif", "animation"],
  ["voice", "voice"],
  ["vn", "voice"],
]);

/**
 * Parse a raw inline query into `{terms, types}`.
 * Supports `type:photo`, `#tag` and plain keywords. `-tag` excludes.
 */
function parseQuery(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const terms = [];
  const tags = [];
  const exclude = [];
  const types = new Set();

  for (const token of text.split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    const typeMatch = /^(?:type|tipe):(.+)$/.exec(lower);
    if (typeMatch) {
      const type = TYPE_WORDS.get(typeMatch[1]) || typeMatch[1];
      if (ALL_TYPES.includes(type)) types.add(type);
      continue;
    }
    if (lower.startsWith("#") && lower.length > 1) {
      tags.push(lower.slice(1));
      continue;
    }
    if (lower.startsWith("-") && lower.length > 1) {
      exclude.push(lower.slice(1));
      continue;
    }
    terms.push(lower);
  }

  // A lone media word ("foto", "video", "gif"…) is a type filter, not a
  // title keyword — otherwise `@bot foto` would only match items whose title
  // literally contains "foto".
  if (terms.length === 1 && !tags.length && !types.size) {
    const mapped = TYPE_WORDS.get(terms[0]);
    if (mapped) {
      types.add(mapped);
      terms.length = 0;
    }
  }
  return { terms, tags, exclude, types: [...types], raw: text };
}

function scoreItem(item, parsed) {
  const title = item.title.toLowerCase();
  const description = String(item.description || "").toLowerCase();
  const body = `${item.text || ""} ${item.caption || ""}`.toLowerCase();
  const tags = item.tags.map((tag) => tag.toLowerCase());
  let score = 0;

  for (const term of parsed.terms) {
    let hit = 0;
    if (title === term) hit = 12;
    else if (title.startsWith(term)) hit = 8;
    else if (title.includes(term)) hit = 6;
    else if (tags.some((tag) => tag === term)) hit = 5;
    else if (tags.some((tag) => tag.includes(term))) hit = 3;
    else if (body.includes(term)) hit = 2;
    else if (description.includes(term)) hit = 1;
    if (!hit) return 0; // every term must match somewhere (AND semantics)
    score += hit;
  }

  for (const tag of parsed.tags) {
    if (tags.includes(tag)) score += 6;
    else if (tags.some((entry) => entry.includes(tag))) score += 3;
    else return 0;
  }

  if (!parsed.terms.length && !parsed.tags.length) score = 1; // browse mode
  return score;
}

/**
 * Search the catalogue.
 *
 * @param {string} raw                  inline query text
 * @param {object} [options]
 * @param {string} [options.type]       force a media type
 * @param {number} [options.limit]      max results (default 25)
 * @param {number} [options.offset]     pagination offset
 * @returns {{items: object[], total: number, hasMore: boolean, parsed: object}}
 */
function search(raw, options = {}) {
  const parsed = parseQuery(raw);
  const forced = options.type ? String(options.type).toLowerCase() : null;
  if (forced && ALL_TYPES.includes(forced)) parsed.types = [forced];

  const all = items();
  const matched = [];
  for (const item of all) {
    if (parsed.types.length && !parsed.types.includes(item.type)) continue;
    if (parsed.exclude.length) {
      const haystack = `${item.title} ${item.tags.join(" ")}`.toLowerCase();
      if (parsed.exclude.some((word) => haystack.includes(word))) continue;
    }
    const score = scoreItem(item, parsed);
    if (score > 0) matched.push({ item, score });
  }

  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.item.created_at).localeCompare(String(a.item.created_at));
  });

  const limit = Math.max(1, Math.min(50, Number(options.limit) || 25));
  const offset = Math.max(0, Number(options.offset) || 0);
  const slice = matched.slice(offset, offset + limit).map((entry) => entry.item);
  return {
    items: slice,
    total: matched.length,
    hasMore: offset + slice.length < matched.length,
    parsed,
  };
}

/** Counts per media type, for status cards. */
function stats() {
  const all = items();
  const byType = Object.fromEntries(ALL_TYPES.map((type) => [type, 0]));
  let uploaded = 0;
  let pending = 0;
  for (const item of all) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    if (item.type === "text") continue;
    if (item.uploaded) uploaded += 1;
    else pending += 1;
  }
  return { total: all.length, byType, uploaded, pending };
}

module.exports = {
  CATALOG_FILE: INLINE_CATALOG_FILE,
  MEDIA_DIR: INLINE_MEDIA_DIR,
  MEDIA_TYPES,
  ALL_TYPES,
  MAX_ITEMS,
  TYPE_WORDS,
  ensureMediaDir,
  load,
  save,
  update,
  items,
  get,
  add,
  updateItem,
  remove,
  clear,
  parseQuery,
  search,
  stats,
};

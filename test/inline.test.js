"use strict";
/**
 * Unit tests for Inline Mode.
 *
 * The catalogue is redirected to a temp directory via env vars *before* any
 * module is required, so the tests never touch the real session files.
 *
 * Run: npm test   (or: node --test test/)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "inline-test-"));
process.env.INLINE_CATALOG_FILE = path.join(TMP, "inline_catalog.json");
process.env.INLINE_MEDIA_DIR = path.join(TMP, "inline_media");
process.env.USERBOT_OWNER_ID = "4242";
process.env.BOT_TOKEN = "";

const catalog = require("../utils/inline_catalog");
const inlineBot = require("../utils/inline_bot");
const config = require("../config");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("catalogue starts empty and supports text items", () => {
  catalog.clear();
  assert.equal(catalog.stats().total, 0);

  const { item } = catalog.add({
    type: "text",
    title: "Sambutan",
    text: "Halo dunia",
    tags: "salam, pembuka",
  });
  assert.equal(item.type, "text");
  assert.equal(item.title, "Sambutan");
  assert.deepEqual(item.tags, ["salam", "pembuka"]);
  assert.equal(catalog.stats().total, 1);
});

test("search matches title, tag and body, and honours type filters", () => {
  catalog.clear();
  catalog.add({ type: "text", title: "Promo Akhir Tahun", text: "Diskon 50%", tags: "promo" });
  catalog.add({ type: "photo", title: "Banner Promo", file_id: "AAA", uploaded: true, tags: "promo,banner" });
  catalog.add({ type: "video", title: "Tutorial Editing", file_id: "BBB", uploaded: true });

  const byTitle = catalog.search("promo");
  assert.equal(byTitle.total, 2);

  const photosOnly = catalog.search("promo type:photo");
  assert.equal(photosOnly.total, 1);
  assert.equal(photosOnly.items[0].type, "photo");

  const byTag = catalog.search("#banner");
  assert.equal(byTag.total, 1);

  const byBody = catalog.search("diskon");
  assert.equal(byBody.total, 1);

  const excluded = catalog.search("promo -banner");
  assert.equal(excluded.total, 1);

  const none = catalog.search("tidak-ada-yang-cocok");
  assert.equal(none.total, 0);

  // Browse mode (empty query) returns everything.
  assert.equal(catalog.search("").total, 3);
});

test("media word alone filters by type", () => {
  catalog.clear();
  catalog.add({ type: "photo", title: "A", file_id: "1", uploaded: true });
  catalog.add({ type: "document", title: "B", file_id: "2", uploaded: true });
  const found = catalog.search("foto");
  assert.equal(found.total, 1);
  assert.equal(found.items[0].type, "photo");
});

test("parseQuery understands type:, #tag and exclusions", () => {
  const parsed = catalog.parseQuery("promo type:video #malam -lama");
  assert.deepEqual(parsed.types, ["video"]);
  assert.deepEqual(parsed.tags, ["malam"]);
  assert.deepEqual(parsed.exclude, ["lama"]);
  assert.deepEqual(parsed.terms, ["promo"]);
});

test("pagination reports hasMore", () => {
  catalog.clear();
  for (let i = 0; i < 7; i += 1) {
    catalog.add({ type: "text", title: `Item ${i}`, text: `isi ${i}`, tags: "batch" });
  }
  const first = catalog.search("batch", { limit: 5 });
  assert.equal(first.items.length, 5);
  assert.equal(first.hasMore, true);
  const second = catalog.search("batch", { limit: 5, offset: 5 });
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, false);
});

test("buildAnswer denies non-owners without leaking content", () => {
  catalog.clear();
  catalog.add({ type: "text", title: "Rahasia", text: "jangan bocor" });
  const payload = inlineBot.buildAnswer(
    { id: "q1", query: "", from: { id: 999 } },
    { owners: [4242] },
  );
  assert.equal(payload.denied, true);
  assert.deepEqual(payload.results, []);
});

test("buildAnswer denies everyone when no owner is configured", () => {
  const payload = inlineBot.buildAnswer(
    { id: "q1", query: "x", from: { id: 1 } },
    { owners: [] },
  );
  assert.equal(payload.denied, true);
});

test("buildAnswer returns typed inline results for the owner", () => {
  catalog.clear();
  catalog.add({ type: "text", title: "Teks", text: "isi teks" });
  catalog.add({ type: "photo", title: "Foto", file_id: "PHOTO1", uploaded: true, caption: "cap" });
  catalog.add({ type: "video", title: "Video", file_id: "VIDEO1", uploaded: true, mime: "video/mp4" });
  catalog.add({ type: "document", title: "Dok", file_id: "DOC1", uploaded: true });
  catalog.add({ type: "audio", title: "Lagu", file_id: "AUD1", uploaded: true });
  catalog.add({ type: "animation", title: "Gif", file_id: "GIF1", uploaded: true });
  catalog.add({ type: "voice", title: "Vn", file_id: "VN1", uploaded: true });

  const payload = inlineBot.buildAnswer(
    { id: "q2", query: "", from: { id: 4242 } },
    { owners: [4242] },
  );
  assert.equal(payload.denied, undefined);
  assert.equal(payload.inline_query_id, "q2");
  assert.equal(payload.is_personal, true);
  assert.equal(payload.cache_time, 0);
  assert.equal(payload.results.length, 7);

  const byType = Object.fromEntries(payload.results.map((r) => [r.title, r]));
  assert.equal(byType.Teks.type, "article");
  // Bot API 10.1+: text results are delivered as InputRichMessageContent.
  // `input_message_content` must contain exactly one content field.
  const teksContent = byType.Teks.input_message_content;
  const keys = Object.keys(teksContent);
  assert.equal(keys.length, 1, `harus tepat satu field, dapat: ${keys.join(",")}`);
  if (teksContent.rich_message) {
    const blocks = teksContent.rich_message.blocks;
    assert.ok(Array.isArray(blocks) && blocks.length > 0);
    assert.ok(JSON.stringify(blocks).includes("isi teks"), "isi teks hilang dari rich blocks");
  } else {
    assert.equal(teksContent.message_text, "isi teks");
  }
  assert.equal(byType.Foto.type, "photo");
  assert.equal(byType.Foto.photo_file_id, "PHOTO1");
  assert.equal(byType.Foto.caption, "cap");
  assert.equal(byType.Video.type, "video");
  assert.equal(byType.Video.video_file_id, "VIDEO1");
  assert.equal(byType.Dok.type, "document");
  assert.equal(byType.Dok.document_file_id, "DOC1");
  assert.equal(byType.Lagu.type, "audio");
  assert.equal(byType.Gif.type, "gif");
  assert.equal(byType.Gif.gif_file_id, "GIF1");
  assert.equal(byType.Vn.type, "voice");
});

test("un-uploaded media returns a helpful placeholder instead of a broken result", () => {
  catalog.clear();
  catalog.add({ type: "photo", title: "Belum", local_path: "/tmp/x.jpg" });
  const payload = inlineBot.buildAnswer(
    { id: "q3", query: "", from: { id: 4242 } },
    { owners: [4242] },
  );
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].type, "article");
  assert.match(payload.results[0].description, /belum diunggah/i);
});

test("empty catalogue returns an onboarding article for the owner", () => {
  catalog.clear();
  const payload = inlineBot.buildAnswer(
    { id: "q4", query: "", from: { id: 4242 } },
    { owners: [4242] },
  );
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].id, "help");
});

test("answerInlineQuery sends a payload and never throws on API errors", async () => {
  catalog.clear();
  catalog.add({ type: "text", title: "Halo", text: "hai" });

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: true }),
    };
  };
  try {
    const result = await inlineBot.answerInlineQuery(
      "123:TEST",
      { id: "q5", query: "", from: { id: 4242 } },
      { owners: [4242] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.answered, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /answerInlineQuery$/);
    assert.equal(calls[0].body.inline_query_id, "q5");

    // Denied query still answers (empty) so the client is not left spinning.
    const denied = await inlineBot.answerInlineQuery(
      "123:TEST",
      { id: "q6", query: "", from: { id: 7 } },
      { owners: [4242] },
    );
    assert.equal(denied.denied, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.results, []);

    // API failure is reported, not thrown.
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: "query is too old" }),
    });
    const failed = await inlineBot.answerInlineQuery(
      "123:TEST",
      { id: "q7", query: "", from: { id: 4242 } },
      { owners: [4242] },
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error, /too old/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("handleUpdate routes inline_query and chosen_inline_result", async () => {
  catalog.clear();
  const { item } = catalog.add({ type: "text", title: "Pilih", text: "ok" });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: true }),
  });
  try {
    const logs = [];
    const inline = await inlineBot.handleUpdate(
      "123:TEST",
      { inline_query: { id: "q8", query: "", from: { id: 4242 } } },
      { owners: [4242], log: (line) => logs.push(line) },
    );
    assert.equal(inline.type, "inline_query");
    assert.equal(inline.answered, 1);
    assert.equal(logs.length, 1);

    const chosen = await inlineBot.handleUpdate(
      "123:TEST",
      { chosen_inline_result: { result_id: item.id, from: { id: 4242 }, inline_message_id: "x" } },
      { owners: [4242], log: (line) => logs.push(line) },
    );
    assert.equal(chosen.type, "chosen_inline_result");
    assert.equal(chosen.item.id, item.id);
  } finally {
    global.fetch = originalFetch;
  }
});

test("bot token is read from the environment and never hard-coded", () => {
  assert.equal(config.resolveBotToken(), "");
  assert.equal(config.isBotToken("123456789:AAFakeTokenForTestsOnly_0000000000"), true);
  assert.equal(config.isBotToken("bukan-token"), false);

  // No literal token may remain in the tracked sources.
  const root = path.join(__dirname, "..");
  const files = ["config.js", "main.js", "bot_api_server.js", "utils/bot_bridge.js", "utils/rich_message.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /\d{8,12}:[A-Za-z0-9_-]{30,}/, `${file} berisi token hard-coded`);
  }
});

test("a BotFather token is rejected as MTProto api_hash", () => {
  assert.throws(
    () => config.validateUserCredentials(12345, "123456789:AAFakeTokenForTestsOnly_0000000000"),
    /token BotFather/i,
  );
  assert.throws(() => config.validateUserCredentials(0, "a".repeat(32)), /api_id/);
  assert.throws(() => config.validateUserCredentials(12345, "bukan-hash"), /32 karakter/i);
  assert.deepEqual(config.validateUserCredentials(12345, "a".repeat(32)), {
    apiId: 12345,
    apiHash: "a".repeat(32),
  });
});

test("catalogue validates media items and deletes local files", () => {
  catalog.clear();
  assert.throws(() => catalog.add({ type: "photo", title: "x" }), /file_id atau file lokal/);
  assert.throws(() => catalog.add({ type: "text", title: "x", text: "" }), /teks tidak boleh kosong/i);
  assert.throws(() => catalog.add({ type: "hologram", title: "x" }), /tidak didukung/);

  const localFile = path.join(TMP, "media.bin");
  fs.writeFileSync(localFile, "data");
  const { item } = catalog.add({
    type: "document",
    title: "Lokal",
    local_path: localFile,
    file_name: "media.bin",
  });
  assert.equal(item.uploaded, false);
  assert.equal(catalog.stats().pending, 1);
  assert.equal(catalog.remove(item.id).id, item.id);
  assert.equal(fs.existsSync(localFile), false);
});

test("inline result ids stay within the Bot API 64-character limit", () => {
  catalog.clear();
  catalog.add({ type: "text", title: "Panjang", text: "x" });
  const payload = inlineBot.buildAnswer(
    { id: "q9", query: "", from: { id: 4242 } },
    { owners: [4242] },
  );
  for (const result of payload.results) {
    assert.ok(result.id.length <= 64, `id ${result.id} terlalu panjang`);
  }
});

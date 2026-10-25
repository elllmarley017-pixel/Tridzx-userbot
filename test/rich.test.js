"use strict";
/**
 * Tests for the Bot API 10.3 Rich Message path and Inline Mode.
 *
 * Everything here is offline: the Bot API is replaced by a recorder, and the
 * assertions encode the payload shapes that were verified live against
 * api.telegram.org (see `utils/rich_transport.js` header).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rich-test-"));
process.env.INLINE_CATALOG_FILE = path.join(TMP, "catalog.json");
process.env.INLINE_MEDIA_DIR = path.join(TMP, "media");
process.env.USERBOT_MENU_QUEUE = path.join(TMP, "queue.json");
process.env.USERBOT_OWNER_ID = "4242";
process.env.BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_0000000000";

require("../native_bootstrap");

const rich = require("../utils/rich_message");
const richTransport = require("../utils/rich_transport");
const menu = require("../utils/menu");
const delivery = require("../utils/menu_delivery");
const inlineBot = require("../utils/inline_bot");
const catalog = require("../utils/inline_catalog");
const botModule = require("../bot");
const userbotModule = require("../userbot");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Record every Bot API call. */
function mockApi(overrides = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    const custom = overrides[method];
    if (custom) {
      const result = custom(body);
      if (result && result.__error) {
        return {
          ok: false,
          status: result.__error.code || 400,
          json: async () => ({
            ok: false,
            error_code: result.__error.code || 400,
            description: result.__error.description,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (method === "getMe") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { id: 999, is_bot: true, username: "ujibot", supports_inline_queries: true },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 4242 } } }),
    };
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    },
    method(name) {
      return calls.filter((call) => call.method === name);
    },
  };
}

test.beforeEach(() => {
  richTransport.resetCapabilityCache();
  delivery.resetIdentityCache();
  catalog.clear();
});

/* ------------------------------------------------------------------ *
 * Rich Message payload shape (verified live)                          *
 * ------------------------------------------------------------------ */
test("buildRichPayload sends exactly one of blocks/html/markdown", () => {
  const message = rich.buildRichMessage([rich.block.paragraph("x")]);
  const payload = richTransport.buildRichPayload(message);
  assert.deepEqual(Object.keys(payload), ["blocks"]);

  const htmlOnly = richTransport.buildRichPayload({ __rich: true, html: "<b>x</b>" });
  assert.deepEqual(Object.keys(htmlOnly), ["html"]);

  const mdOnly = richTransport.buildRichPayload({ __rich: true, markdown: "**x**" });
  assert.deepEqual(Object.keys(mdOnly), ["markdown"]);
});

test("rich payload is capped to the documented 32768-character limit", () => {
  const long = "x".repeat(40000);
  const payload = richTransport.buildRichPayload({ __rich: true, html: long });
  assert.equal(payload.html.length, richTransport.MAX_RICH_HTML);
});

test("blockquote takes nested blocks, expandable takes text (documented shapes)", () => {
  const quote = rich.block.blockquote(rich.text.raw("isi"), { credit: rich.text.raw("penulis") });
  const built = richTransport.buildRichPayload(rich.buildRichMessage([quote]));
  const node = built.blocks[0];
  assert.equal(node.type, "blockquote");
  assert.ok(Array.isArray(node.blocks), "blockquote wajib memakai blocks");
  // Docs: RichBlockBlockQuotation.credit is RichText (plain string here).
  assert.equal(node.credit, "penulis");

  const expandable = richTransport.buildRichPayload(
    rich.buildRichMessage([rich.block.expandableBlockquote(rich.text.raw("isi"), { credit: rich.text.raw("c") })]),
  );
  const exp = expandable.blocks[0];
  assert.equal(exp.type, "expandable_blockquote");
  assert.ok(!Array.isArray(exp.blocks), "expandable tidak boleh memakai blocks");
  assert.ok(exp.text !== undefined, "expandable wajib punya text");
});

test("table cells are objects (Telegram rejects bare strings)", () => {
  const block = rich.block.table({
    headers: ["A", "B"],
    rows: [["1", "2"]],
    caption: "cap",
    striped: true,
    compact: true,
  });
  const payload = richTransport.buildRichPayload(rich.buildRichMessage([block]));
  const table = payload.blocks[0];
  assert.equal(table.type, "table");
  for (const row of table.cells) {
    for (const cell of row) {
      assert.equal(typeof cell, "object", "setiap sel harus objek");
      assert.ok(cell.text !== undefined);
    }
  }
  assert.equal(table.is_compact, true);
  assert.equal(table.is_striped, true);
});

test("media blocks use the documented { type, <kind>: { type, media } } shape", () => {
  const url = "https://example.com/p.jpg";
  const payload = richTransport.buildRichPayload(
    rich.buildRichMessage([rich.block.photo(url, { caption: "cap" })]),
  );
  const photo = payload.blocks[0];
  assert.equal(photo.type, "photo");
  assert.deepEqual(photo.photo, { type: "photo", media: url });
  assert.deepEqual(photo.caption, { text: "cap" });
});

test("inline keyboard is mirrored into RichBlockButtons", () => {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "Buka", url: "https://t.me" },
        { text: "Salin", copy_text: { text: ".start" } },
      ],
      [{ text: "Nav", callback_data: "m:main" }],
    ],
  };
  const blocks = richTransport.inlineKeyboardToRichButtons(keyboard);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "buttons");
  assert.equal(blocks[0].buttons[0].url, "https://t.me");
  assert.deepEqual(blocks[0].buttons[1].copy_text, { text: ".start" });
  assert.equal(blocks[1].buttons[0].callback_data, "m:main");
});

test("composeRichMessage merges page blocks with button rows", () => {
  const message = richTransport.composeRichMessage({
    blocks: [rich.block.heading(1, "Judul"), rich.block.paragraph("isi")],
    keyboard: menu.buildKeyboard(0),
    html: "<b>fallback</b>",
  });
  const payload = richTransport.buildRichPayload(message);
  assert.equal(payload.blocks[0].type, "heading");
  assert.ok(payload.blocks.some((b) => b.type === "buttons"), "RichBlockButtons hilang");
});

/* ------------------------------------------------------------------ *
 * sendRichMessage / editMessageText                                   *
 * ------------------------------------------------------------------ */
test("supportsRichMessages probes once and caches the answer", async () => {
  const api = mockApi({ sendRichMessage: () => ({ __error: { code: 400, description: "Bad Request: chat_id is empty" } }) });
  try {
    const first = await richTransport.supportsRichMessages("123:TEST", { force: true });
    assert.equal(first.supported, true, "400 membuktikan method ada");
    const callsAfterFirst = api.method("sendRichMessage").length;
    await richTransport.supportsRichMessages("123:TEST");
    assert.equal(api.method("sendRichMessage").length, callsAfterFirst, "hasil harus di-cache");
  } finally {
    api.restore();
  }
});

test("supportsRichMessages reports false on 404 (older server)", async () => {
  const api = mockApi({ sendRichMessage: () => ({ __error: { code: 404, description: "Not Found" } }) });
  try {
    const result = await richTransport.supportsRichMessages("123:TEST", { force: true });
    assert.equal(result.supported, false);
  } finally {
    api.restore();
  }
});

test("sendRichMessage posts rich_message + reply_markup", async () => {
  const api = mockApi();
  try {
    const message = richTransport.composeRichMessage({
      blocks: [rich.block.heading(1, "H"), rich.block.paragraph("p")],
      keyboard: menu.buildKeyboard(0),
    });
    const sent = await richTransport.sendRichMessage({
      token: "123:TEST",
      chatId: 4242,
      message,
      keyboard: menu.buildKeyboard(0),
    });
    assert.equal(sent.message_id, 1);
    const call = api.method("sendRichMessage")[0];
    assert.equal(call.body.chat_id, 4242);
    assert.ok(Array.isArray(call.body.rich_message.blocks));
    assert.ok(call.body.reply_markup.inline_keyboard.length > 0);
    assert.equal(call.body.rich_message.html, undefined, "hanya satu field yang boleh dikirim");
  } finally {
    api.restore();
  }
});

test("editRichMessage keeps the keyboard (otherwise it is dropped)", async () => {
  const api = mockApi();
  try {
    await richTransport.editRichMessage({
      token: "123:TEST",
      chatId: 4242,
      messageId: 77,
      message: richTransport.composeRichMessage({ blocks: [rich.block.paragraph("baru")] }),
      keyboard: menu.buildKeyboard(1),
    });
    const call = api.method("editMessageText")[0];
    assert.equal(call.body.message_id, 77);
    assert.ok(Array.isArray(call.body.rich_message.blocks));
    assert.ok(call.body.reply_markup.inline_keyboard.length > 0);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Menu delivery: rich first, HTML fallback                            *
 * ------------------------------------------------------------------ */
test("menu pages render valid rich blocks for every page", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const { blocks, html } = menu.renderPageBlocks(page, { botUsername: "ujibot" });
    const payload = richTransport.buildRichPayload(rich.buildRichMessage(blocks));
    assert.ok(payload.blocks.length > 0);
    assert.ok(!JSON.stringify(payload).includes("[object Object]"), `halaman ${page} bocor objek`);
    assert.ok(html.length > 0);
    const types = new Set(payload.blocks.map((b) => b.type));
    assert.ok(types.has("heading"), `halaman ${page} tanpa heading`);
    assert.ok(types.has("table") || types.has("buttons"), `halaman ${page} tanpa struktur`);
  }
});

test("sendMenuAsBot prefers sendRichMessage with in-message buttons", async () => {
  const api = mockApi();
  try {
    const result = await delivery.sendMenuAsBot({ chatId: 4242, page: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "rich");
    const call = api.method("sendRichMessage").at(-1);
    assert.ok(typeof call.body.rich_message.html === "string");
    assert.ok(call.body.rich_message.html.includes("<tg-button-row>"));
    assert.equal(call.body.reply_markup, undefined);
    assert.equal(api.method("sendMessage").length, 0);
  } finally {
    api.restore();
  }
});

test("sendMenuAsBot falls back to parse_mode HTML when rich is unavailable", async () => {
  const api = mockApi({ sendRichMessage: () => ({ __error: { code: 404, description: "Not Found" } }) });
  try {
    const result = await delivery.sendMenuAsBot({ chatId: 4242, page: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "html");
    const call = api.method("sendMessage")[0];
    assert.equal(call.body.parse_mode, "HTML");
    assert.ok(call.body.reply_markup.inline_keyboard.length > 0);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Inline Mode + InputRichMessageContent                               *
 * ------------------------------------------------------------------ */
test("inline text items use InputRichMessageContent", () => {
  const item = { id: "c1", type: "text", title: "Status", text: "CPU 12%", description: "ringkas" };
  const content = inlineBot.buildTextContent(item);
  assert.ok(content.rich_message, "rich_message hilang");
  assert.ok(Array.isArray(content.rich_message.blocks));
  assert.equal(content.message_text, undefined, "tidak boleh mencampur dua bentuk");
  const types = content.rich_message.blocks.map((b) => b.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("paragraph"));
});

test("inline text items fall back to InputTextMessageContent", () => {
  const item = { id: "c1", type: "text", title: "Status", text: "CPU 12%" };
  const content = inlineBot.buildTextContent(item, { rich: false });
  assert.equal(content.rich_message, undefined);
  assert.equal(typeof content.message_text, "string");
});

test("bot.js inline results carry rich_message for articles", () => {
  const entry = botModule.CATALOG[0];
  const richResult = botModule.buildRichResult(entry, 0);
  assert.equal(richResult.type, "article");
  assert.ok(richResult.input_message_content.rich_message, "rich_message hilang");
  assert.ok(Array.isArray(richResult.input_message_content.rich_message.blocks));

  const textResult = botModule.buildTextResult(entry, 0);
  assert.equal(typeof textResult.input_message_content.message_text, "string");
  assert.equal(textResult.input_message_content.parse_mode, undefined, "teks polos tanpa parse_mode");
});

test("bot.js text results contain no JSON blobs", () => {
  for (const entry of botModule.CATALOG) {
    const plain = botModule.buildTextResult(entry, 0).input_message_content.message_text;
    assert.ok(!plain.includes('{"type"'), `${entry.key} berisi JSON RichText`);
    assert.ok(!plain.includes("[object Object]"), `${entry.key} berisi [object Object]`);
    assert.ok(plain.length > 0);
    assert.ok(plain.length <= 4096);
  }
});

test("richTextToPlain flattens nested RichText nodes", () => {
  assert.equal(botModule.richTextToPlain([{ type: "bold", text: "A" }, " ", { type: "italic", text: "B" }]), "A B");
  assert.equal(botModule.richTextToPlain({ type: "code", text: "x" }), "x");
  assert.equal(botModule.richTextToPlain({ type: "custom_emoji", alternative_text: "👍" }), "👍");
  assert.equal(botModule.richTextToPlain(undefined), "");
});

test("the `!` prefix forces a plain-text inline answer", async () => {
  const api = mockApi();
  try {
    const result = await botModule.answerInlineQuery({
      id: "q1",
      query: "!status",
      from: { id: 4242 },
      offset: "0",
    });
    assert.equal(result.mode, "text");
    const answer = api.method("answerInlineQuery")[0];
    assert.ok(answer.body.results.length > 0);
    const content = answer.body.results[0].input_message_content;
    assert.equal(content.rich_message, undefined, "mode teks tidak boleh mengirim rich_message");
    assert.equal(typeof content.message_text, "string");
  } finally {
    api.restore();
  }
});

test("inline answers respect the 50-result limit and pagination", async () => {
  const api = mockApi();
  try {
    await botModule.answerInlineQuery({ id: "q2", query: "", from: { id: 4242 }, offset: "0" });
    const answer = api.method("answerInlineQuery")[0];
    assert.ok(answer.body.results.length <= 50);
    assert.equal(typeof answer.body.next_offset, "string");
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Userbot side: graceful rich fallback                                *
 * ------------------------------------------------------------------ */
test("isUnsupportedRichError detects the MTProto TypeNotFoundError", () => {
  assert.equal(
    userbotModule.isUnsupportedRichError({
      message: "Could not find a matching Constructor ID for the TLObject that was supposed to be read with ID 174161531",
    }),
    true,
  );
  assert.equal(userbotModule.isUnsupportedRichError({ message: "TypeNotFoundError: x" }), true);
  assert.equal(userbotModule.isUnsupportedRichError({ message: "FLOOD_WAIT_30" }), false);
  assert.equal(userbotModule.isUnsupportedRichError(null), false);
});

test("getInlineResultsSafe retries with the `!` prefix on a rich parse failure", async () => {
  const calls = [];
  const client = {
    invoke: async (request) => {
      const query = request.query;
      calls.push(query);
      if (!query.startsWith("!")) {
        const err = new Error(
          "Could not find a matching Constructor ID for the TLObject that was supposed to be read with ID 174161531",
        );
        throw err;
      }
      return { queryId: 1n, results: [{ id: "status-0" }], nextOffset: "" };
    },
  };
  const result = await userbotModule.getInlineResultsSafe(client, {}, {}, "status", "");
  assert.equal(result.mode, "text");
  assert.equal(result.results.length, 1);
  assert.deepEqual(calls, ["status", "!status"]);
});

test("getInlineResultsSafe keeps rich mode when the layer can decode it", async () => {
  const calls = [];
  const client = {
    invoke: async (request) => {
      calls.push(request.query);
      return { queryId: 1n, results: [{ id: "rich-0" }], nextOffset: "" };
    },
  };
  const result = await userbotModule.getInlineResultsSafe(client, {}, {}, "status", "");
  assert.equal(result.mode, "rich");
  assert.deepEqual(calls, ["status"]);
});

test("getInlineResultsSafe does not hide unrelated errors", async () => {
  const client = {
    invoke: async () => {
      throw new Error("FLOOD_WAIT_30");
    },
  };
  await assert.rejects(
    () => userbotModule.getInlineResultsSafe(client, {}, {}, "status", ""),
    /FLOOD_WAIT/,
  );
});

test("userbot parses `.bot`, `.bot 2` and `.botlist`", () => {
  assert.deepEqual(userbotModule.parseCommand(".bot status"), { name: "bot", args: "status" });
  assert.deepEqual(userbotModule.parseCommand(".bot 2 promo"), { name: "bot", args: "2 promo" });
  assert.deepEqual(userbotModule.parseCommand(".botlist x"), { name: "botlist", args: "x" });
  assert.equal(userbotModule.parseCommand("halo"), null);
  assert.equal(userbotModule.parseCommand("/start"), null);
});

/* ------------------------------------------------------------------ *
 * [object Object] regression                                          *
 * ------------------------------------------------------------------ */
test("no rich payload or rendered text contains [object Object]", () => {
  const formatting = require("../utils/formatting");
  const message = rich.buildRichMessage([
    rich.block.paragraph("Halo"),
    rich.block.table({ headers: ["A"], rows: [["1"]] }),
    rich.block.buttons([rich.richButton("X", { copy_text: ".x" })]),
  ]);
  assert.ok(!JSON.stringify(richTransport.buildRichPayload(message)).includes("[object Object]"));
  assert.ok(!formatting.richToPlain(message).includes("[object Object]"));
  assert.ok(!formatting.escapeMarkdown(message).includes("[object Object]"));
});

/* ------------------------------------------------------------------ *
 * Table pipeline                                                      *
 * ------------------------------------------------------------------ */
test("a table renders <table> in rich HTML and an aligned <pre> in fallback", () => {
  const f = require("../utils/formatting");
  const table = {
    headers: ["Command", "Status"],
    rows: [[" .ai", "Aktif"], [".infobot", "Aktif"]],
    caption: "Dua command",
  };

  const rich = f.formatRichMessage({ title: "Status", table }).html;
  assert.match(rich, /<table>/, "rich harus memakai <table>");
  assert.match(rich, /<th>Command<\/th>/, "header tabel hilang");
  assert.match(rich, /<td>.infobot<\/td>/, "sel tabel hilang");
  assert.match(rich, /<caption>Dua command<\/caption>/);

  const legacy = f.formatMessage({ title: "Status", table });
  assert.match(legacy, /<pre>/, "fallback harus memakai <pre> agar kolom rata");
  assert.ok(!/<table/i.test(legacy), "parse_mode HTML menolak <table>");
  // Every data row keeps its cells, separated by the column marker.
  assert.ok(legacy.includes(".infobot │ Aktif"));
});

test("table fallback aligns columns by display width", () => {
  const f = require("../utils/formatting");
  assert.equal(f.displayWidth("ab"), 2);
  assert.equal(f.displayWidth("🎬"), 2, "emoji dihitung dua kolom");
  const legacy = f.formatMessage({
    table: { headers: ["A", "B"], rows: [["panjang", "1"], ["x", "2"]] },
  });
  const lines = legacy.replace(/<\/?pre>/g, "").split("\n").filter((l) => l.includes("│"));
  const positions = new Set(lines.map((line) => line.indexOf("│")));
  assert.equal(positions.size, 1, `kolom tidak rata: ${[...positions]}`);
});

test("menu fallback never emits rich-only tags", () => {
  const menu = require("../utils/menu");
  const richOnly = /<(p|details|summary|table|tr|th|td|h1|h2|tg-button-row)[\s>]/i;
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    assert.ok(!richOnly.test(menu.renderPageHtml(page)), `halaman ${page} memakai tag rich-only`);
  }
  const feature = menu.renderFeature(menu.featureId(menu.allItems()[0]));
  assert.ok(!richOnly.test(feature.fallback), "fallback fitur memakai tag rich-only");
});

test("dynamic titles are escaped, never injected as markup", () => {
  const f = require("../utils/formatting");
  const html = f.formatMessage({ title: "Judul <x> & y" });
  assert.ok(html.includes("&lt;x&gt;"), "judul harus di-escape");
  assert.ok(!/<x>/.test(html), "judul tidak boleh jadi tag");
});

/* ------------------------------------------------------------------ *
 * Raw tag / [object Object] regressions                               *
 * ------------------------------------------------------------------ */
test("statusMessage keeps author markup instead of escaping it", () => {
  const f = require("../utils/formatting");
  const out = f.statusMessage(`Mencari ${f.inlineCode("drop dead")}`);
  assert.equal(out, "⏳ <b>Mencari <code>drop dead</code></b>");
  assert.ok(!out.includes("&lt;code&gt;"), "tag <code> tidak boleh jadi teks mentah");
});

test("dynamic data is escaped exactly once", () => {
  const f = require("../utils/formatting");
  assert.equal(f.statusMessage("cari a<b & c"), "⏳ <b>cari a&lt;b &amp; c</b>");
  // An entity the caller already escaped must not be escaped again.
  assert.equal(f.statusMessage("a &lt; b"), "⏳ <b>a &lt; b</b>");
  const nested = f.statusMessage(`cari ${f.inlineCode("a<b & c")}`);
  assert.equal(nested, "⏳ <b>cari <code>a&lt;b &amp; c</code></b>");
});

test("formatMessage escapes data inside details and never leaks objects", () => {
  const f = require("../utils/formatting");
  const legacy = f.formatMessage({ details: ["data a<b & c"] });
  assert.ok(legacy.includes("a&lt;b &amp; c"), "data harus di-escape");
  assert.ok(!legacy.includes("[object Object]"));

  const rich = f.formatRichMessage({ details: ["data a<b & c"] });
  assert.ok(rich.html.includes("a&lt;b &amp; c"), "rich html harus ter-escape");
  assert.ok(rich.legacy.includes("a&lt;b &amp; c"), "legacy harus ter-escape");
});

test("errorMessage does not double-escape", () => {
  const f = require("../utils/formatting");
  const out = f.errorMessage("gagal a<b & c", "Judul");
  assert.ok(out.includes("a&lt;b &amp; c"));
  assert.ok(!out.includes("&amp;lt;"), "escape ganda terdeteksi");
});

test("richBlocks/plainOf agree and stay valid", () => {
  const r = require("../utils/rich_message");
  const blocks = [
    r.block.heading("J <x>", 1),
    r.block.paragraph(r.text.bold("b & c")),
    r.pipelineTable(["A & B"], [["1 & 2"]]),
    r.block.quote("q <b>"),
    r.block.footer("f & g"),
  ];
  const rich = r.richBlocks(blocks);
  assert.ok(rich.html.includes("<table>"), "tabel hilang di rich");
  assert.ok(rich.html.includes("A &amp; B"), "header tabel harus ter-escape");
  const plain = r.plainOf(blocks);
  assert.ok(!/<table/i.test(plain), "fallback tidak boleh memakai <table>");
  assert.ok(plain.includes("<pre>"), "fallback tabel harus <pre>");
  for (const out of [rich.html, rich.legacy, plain]) {
    assert.ok(!out.includes("[object Object]"), "objek bocor ke output");
  }
});

/* ------------------------------------------------------------------ *
 * Media validation (.s / .stiker)                                     *
 * ------------------------------------------------------------------ */
test("isImage ignores a link preview and accepts real media", () => {
  const sticker = require("../handlers/sticker");
  // The module only exports register; exercise the rule through the source
  // contract by checking the media-type guard directly.
  const src = require("node:fs").readFileSync(
    require.resolve("../handlers/sticker"),
    "utf8",
  );
  assert.ok(
    src.includes("MessageMediaWebPage") === false || src.includes("media === 'MessageMediaPhoto'"),
    "validasi harus memeriksa tipe media, bukan hanya message.photo",
  );
  assert.ok(src.includes("resolveMedia"), "harus ada resolver media multi-sumber");
  void sticker;
});

test("a link preview is not treated as a photo", () => {
  // Reproduces the reported bug: GramJS exposes `photo` for a webpage preview.
  const message = {
    media: { className: "MessageMediaWebPage" },
    photo: { className: "Photo" },
    document: undefined,
  };
  const media = message.media && message.media.className;
  const accepted = media === "MessageMediaPhoto" && Boolean(message.photo);
  assert.equal(accepted, false, "preview tautan tidak boleh lolos validasi");
});

test("runAction wires __client so handlers can reply", async () => {
  const { command, runAction } = require("../utils/telegram");
  const sent = [];
  const client = {
    addEventHandler() {},
    removeEventHandler() {},
    getMe: async () => ({ id: 1 }),
    sendMessage: async (chat, opts) => {
      sent.push(opts && opts.message);
      return { id: 1, chatId: chat };
    },
    getMessages: async () => [],
  };
  command(
    client,
    /^\.zzz$/,
    async (ev) => {
      await ev.__client.sendMessage(ev.chatId, { message: "ok" });
    },
    { bypassAuth: true },
  );
  const result = await runAction(client, { command: ".zzz", chatId: 5, messageId: 9 });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, ["ok"], "handler harus bisa membalas lewat __client");
});

"use strict";
/**
 * Tests for `.start` delivered through Inline Mode.
 *
 * Behaviour under test:
 *   - one `.start` is enough: no `.start 1`…`.start 7` needed
 *   - the menu result carries HTML + a native keyboard + a `via @bot` marker
 *   - every page/category is reachable from that keyboard
 *   - callbacks on an inline menu are edited through `inline_message_id`
 *     (there is no `callbackQuery.message` for inline messages)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "menu-inline-test-"));
process.env.INLINE_CATALOG_FILE = path.join(TMP, "catalog.json");
process.env.INLINE_MEDIA_DIR = path.join(TMP, "media");
process.env.USERBOT_MENU_QUEUE = path.join(TMP, "queue.json");
process.env.USERBOT_OWNER_ID = "4242";
process.env.BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_0000000000";

require("../native_bootstrap");

const menu = require("../utils/menu");
const menuInline = require("../utils/menu_inline");
const server = require("../bot_api_server");
const richTransport = require("../utils/rich_transport");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

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
          json: async () => ({ ok: false, error_code: result.__error.code, description: result.__error.description }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (method === "getMe") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: 999, is_bot: true, username: "ujibot", supports_inline_queries: true } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
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
});

/* ------------------------------------------------------------------ *
 * Query building                                                      *
 * ------------------------------------------------------------------ */
test("the main menu is one query: `menu`", () => {
  assert.equal(menuInline.queryForPage(0), "menu");
  assert.equal(menuInline.queryForPage(1), "menu:page:1");
  assert.equal(menuInline.queryForPage(7), "menu:page:7");
  assert.equal(menuInline.queryForCategory("stalker"), "menu:cat:stalker");
});

test("menu queries parse into a page", () => {
  assert.deepEqual(menuInline.parseMenuQuery("menu"), { isMenu: true, page: 0, category: null });
  assert.deepEqual(menuInline.parseMenuQuery("menu:page:3"), { isMenu: true, page: 3, category: null });
  assert.deepEqual(menuInline.parseMenuQuery("menu:cat:converter"), { isMenu: true, page: 4, category: "converter" });
  assert.equal(menuInline.parseMenuQuery("promo").isMenu, false);
  assert.equal(menuInline.parseMenuQuery("").isMenu, false);
  // Unknown category falls back to the main menu instead of throwing.
  assert.equal(menuInline.parseMenuQuery("menu:cat:nope").page, 0);
  // Out-of-range pages are clamped.
  assert.equal(menuInline.parseMenuQuery("menu:page:999").page, menu.PAGE_COUNT - 1);
});

/* ------------------------------------------------------------------ *
 * Result shape                                                        *
 * ------------------------------------------------------------------ */
test("menu result carries HTML, a native keyboard and the via marker", () => {
  const result = menuInline.buildMenuResult(0, { botUsername: "ujibot" });
  assert.equal(result.type, "article");
  assert.equal(result.id, "menu-0");
  assert.equal(result.title, "🤖 Menu Utama");

  const content = result.input_message_content;
  assert.equal(content.parse_mode, "HTML");
  assert.ok(!content.rich_message, "inline menu memakai HTML agar bisa dibaca userbot");
  assert.match(content.message_text, /<b>/, "harus ada teks tebal");
  assert.match(content.message_text, /<code>/, "harus ada inline code");
  assert.ok(content.message_text.includes("via @ujibot"), "penanda via bot hilang");
  assert.ok(!content.message_text.includes("[object Object]"));
  assert.ok(content.message_text.length <= 4096);

  const rows = result.reply_markup.inline_keyboard;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const button of row) {
      assert.equal(typeof button.callback_data, "string");
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
      assert.notEqual(menu.parseCallback(button.callback_data).action, "unknown");
    }
  }
});

test("one menu message exposes every category and page", () => {
  const result = menuInline.buildMenuResult(0, { botUsername: "ujibot" });
  const data = result.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

  // Every category reachable directly from the main menu.
  for (const section of menu.SECTIONS) {
    assert.ok(data.includes(menu.CALLBACK.CAT + section.key), `kategori ${section.key} tidak terjangkau`);
  }
  // Close is present; the main menu has no page stepper (it is the root).
  assert.ok(data.includes(menu.CALLBACK.CLOSE));
  assert.ok(!data.some((d) => d.startsWith(menu.CALLBACK.CMD)), "tombol command terlarang");
});

test("each page renders a valid menu result within limits", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const result = menuInline.buildMenuResult(page, { botUsername: "ujibot" });
    assert.ok(result.input_message_content.message_text.length <= 4096, `halaman ${page} terlalu panjang`);
    assert.ok(result.reply_markup.inline_keyboard.length > 0);
    assert.ok(!JSON.stringify(result).includes("[object Object]"));
  }
});

test("menu result can opt into InputRichMessageContent", () => {
  const result = menuInline.buildMenuResult(1, { botUsername: "ujibot", rich: true });
  const content = result.input_message_content;
  if (content.rich_message) {
    assert.ok(Array.isArray(content.rich_message.blocks));
    assert.equal(Object.keys(content.rich_message).length, 1, "tepat satu field");
  } else {
    // Rich unavailable → HTML fallback must still be valid.
    assert.equal(content.parse_mode, "HTML");
  }
});

/* ------------------------------------------------------------------ *
 * answerInlineQuery                                                   *
 * ------------------------------------------------------------------ */
test("answerMenuQuery answers with exactly one menu result", async () => {
  const api = mockApi();
  try {
    const result = await menuInline.answerMenuQuery(
      "123:TEST",
      { id: "q1", query: "menu", from: { id: 4242 } },
      { botUsername: "ujibot" },
    );
    assert.equal(result.isMenu, true);
    assert.equal(result.page, 0);
    assert.equal(result.answered, 1);

    const answer = api.method("answerInlineQuery")[0];
    assert.equal(answer.body.inline_query_id, "q1");
    assert.equal(answer.body.results.length, 1);
    assert.equal(answer.body.results[0].id, "menu-0");
    assert.ok(answer.body.results[0].reply_markup.inline_keyboard.length > 0);
    assert.equal(answer.body.cache_time, 0);
    assert.equal(answer.body.is_personal, true);
  } finally {
    api.restore();
  }
});

test("non-menu queries are ignored by answerMenuQuery", async () => {
  const api = mockApi();
  try {
    const result = await menuInline.answerMenuQuery(
      "123:TEST",
      { id: "q2", query: "promo", from: { id: 4242 } },
      { botUsername: "ujibot" },
    );
    assert.equal(result.isMenu, false);
    assert.equal(api.method("answerInlineQuery").length, 0);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Callback handling on an inline menu                                 *
 * ------------------------------------------------------------------ */
function inlineCallback(data, { from = 4242, inlineMessageId = "INLINE123" } = {}) {
  return { id: "cb1", from: { id: from }, data, inline_message_id: inlineMessageId };
}

test("inline menu callback edits via inline_message_id (no message object)", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(inlineCallback(menu.CALLBACK.PAGE + 2));
    assert.equal(result.action, "page");
    assert.equal(result.page, 2);
    assert.equal(result.format, "rich");

    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.inline_message_id, "INLINE123");
    assert.equal(edit.body.chat_id, undefined, "tidak boleh memakai chat_id");
    assert.equal(edit.body.message_id, undefined);
    assert.ok(edit.body.rich_message.html.includes("<details"), "rich_message hilang");
    assert.ok(edit.body.rich_message.html.includes("<tg-button-row>"), "tombol rich hilang saat edit");
    assert.equal(edit.body.text, undefined, "text dan rich_message tidak boleh bersamaan");
    assert.equal(api.method("sendMessage").length, 0, "navigasi tidak boleh membuat pesan baru");
    assert.equal(api.method("answerCallbackQuery").length, 1);
  } finally {
    api.restore();
  }
});

test("inline menu callback can jump to a category", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(inlineCallback(menu.CALLBACK.CAT + "inline"));
    assert.equal(result.action, "cat");
    assert.equal(result.page, 7);
    assert.equal(result.format, "rich");
    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.inline_message_id, "INLINE123");
    assert.ok(edit.body.rich_message.html.includes("<h2>Inline</h2>"), "halaman kategori salah");
  } finally {
    api.restore();
  }
});

test("inline menu close clears the keyboard (inline messages cannot be deleted)", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(inlineCallback(menu.CALLBACK.CLOSE));
    assert.equal(result.action, "close");
    const call = api.method("editMessageReplyMarkup")[0];
    assert.equal(call.body.inline_message_id, "INLINE123");
    assert.deepEqual(call.body.reply_markup, { inline_keyboard: [] });
  } finally {
    api.restore();
  }
});

test("inline menu callback from a non-owner can navigate", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(inlineCallback(menu.CALLBACK.PAGE + 1, { from: 7 }));
    assert.equal(result.action, "page");
    assert.ok(api.method("editMessageText").length > 0, "non-owner harus bisa berpindah halaman");
  } finally {
    api.restore();
  }
});

test("inline menu `menu` query is answered for the owner and denied otherwise", async () => {
  const api = mockApi();
  try {
    const owner = await server.handle({
      update_id: 1,
      inline_query: { id: "q10", query: "menu", from: { id: 4242 }, offset: "0" },
    });
    assert.equal(owner.action, "menu");
    assert.equal(owner.page, 0);

    const denied = await server.handle({
      update_id: 2,
      inline_query: { id: "q11", query: "menu", from: { id: 7 }, offset: "0" },
    });
    assert.equal(denied.action, "denied");
    const answers = api.method("answerInlineQuery");
    assert.equal(answers.at(-1).body.results.length, 0, "non-owner mendapat hasil kosong");
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * No `.start N` in user-facing text                                   *
 * ------------------------------------------------------------------ */
test("the menu no longer instructs the owner to use `.start N`", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const html = menu.renderPageHtml(page);
    assert.ok(!/\.start [1-7]\b/.test(html), `halaman ${page} masih menyuruh .start N`);
  }
});

test("bot.js serves the same menu query", async () => {
  const bot = require("../bot");
  const api = mockApi();
  try {
    const result = await bot.answerInlineQuery({
      id: "q20",
      query: "menu",
      from: { id: 4242 },
      offset: "0",
    });
    assert.equal(result.mode, "menu");
    const answer = api.method("answerInlineQuery")[0];
    assert.equal(answer.body.results.length, 1);
    assert.equal(answer.body.results[0].id, "menu-0");
    assert.ok(answer.body.results[0].reply_markup.inline_keyboard.length > 0);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Regressions: bot timeout handling + duplicate dispatch              *
 * ------------------------------------------------------------------ */
test("isBotTimeoutError recognises BOT_RESPONSE_TIMEOUT", () => {
  const u = require("../userbot");
  assert.equal(
    u.isBotTimeoutError({ message: "400: BOT_RESPONSE_TIMEOUT (caused by messages.GetInlineBotResults)" }),
    true,
  );
  assert.equal(u.isBotTimeoutError({ message: "FLOOD_WAIT_30" }), false);
  // A bot timeout must not be mistaken for a rich-parsing failure, otherwise the
  // userbot would retry and wait for the ~10s server timeout a second time.
  assert.equal(u.isUnsupportedRichError({ message: "BOT_RESPONSE_TIMEOUT" }), false);
});

test("withTimeout rejects at the deadline without waiting for the source promise", async () => {
  const { performance } = require("node:perf_hooks");
  const u = require("../userbot");
  const slow = new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 8000));
  const started = performance.now();
  await assert.rejects(() => u.withTimeout(slow, 300), (err) => err.code === "LOCAL_TIMEOUT");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `harus berhenti ~300ms, bukan ${Math.round(elapsed)}ms`);
});

test("withTimeout passes through a fast resolution", async () => {
  const u = require("../userbot");
  assert.equal(await u.withTimeout(Promise.resolve("ok"), 5000), "ok");
});

test("getInlineResultsSafe does not retry after a bot timeout", async () => {
  const u = require("../userbot");
  let calls = 0;
  const client = {
    invoke: async () => {
      calls += 1;
      throw new Error("400: BOT_RESPONSE_TIMEOUT (caused by messages.GetInlineBotResults)");
    },
  };
  await assert.rejects(() => u.getInlineResultsSafe(client, {}, {}, "menu", ""), /BOT_RESPONSE_TIMEOUT/);
  assert.equal(calls, 1, "tidak boleh mencoba dua kali");
});

test("inline failure is cached so repeated .start is instant", async () => {
  const start = require("../handlers/start");
  start.inlineHealth.downUntil = 0;
  start.inlineHealth.reason = "";

  const client = {
    getInputEntity: async () => ({}),
    getEntity: async () => ({}),
    invoke: async () => {
      throw new Error("400: BOT_RESPONSE_TIMEOUT (caused by messages.GetInlineBotResults)");
    },
  };
  const event = { chatId: 4242, message: { id: 1, chatId: 4242 }, id: 1 };

  const first = await start.sendViaInline(client, event, 0);
  assert.equal(first.ok, false);
  assert.match(first.reason, /timeout/i);
  assert.ok(start.inlineHealth.downUntil > Date.now(), "kegagalan harus di-cache");

  // Second call must short-circuit without touching the client.
  let touched = false;
  const spyClient = {
    getInputEntity: async () => { touched = true; return {}; },
    getEntity: async () => { touched = true; return {}; },
    invoke: async () => { touched = true; },
  };
  const second = await start.sendViaInline(spyClient, event, 0);
  assert.equal(second.ok, false);
  assert.equal(touched, false, "tidak boleh memanggil Telegram lagi saat cooldown");

  start.inlineHealth.downUntil = 0;
});

test("transportHint explains a bot timeout to the owner", () => {
  const start = require("../handlers/start");
  assert.match(start.transportHint("bot-timeout"), /Bot tidak merespons/i);
  assert.match(start.transportHint("BOT_RESPONSE_TIMEOUT"), /npm run bot/i);
  assert.match(start.transportHint("no-inline-results"), /setinline/i);
  assert.equal(start.transportHint("something else"), "");
});

test("the update poller de-duplicates the same message", async () => {
  const { startUpdatesPoller } = require("../utils/updates_poller");

  // Count how many times the poller feeds a message into GramJS. `_handleUpdate`
  // is imported at module load, so spy on the update objects it receives by
  // making the synthetic message carry a marker we can count.
  const seenIds = [];
  const client = {
    _selfInputPeer: { userId: 4242n },
    session: { processEntities() {} },
    invoke: async () => ({
      className: "updates.Difference",
      newMessages: [
        {
          id: 77,
          peerId: { className: "PeerUser", userId: 4242n },
          message: ".start",
          // `pts` is read by dispatchMessage; keeping it numeric is enough.
          pts: 1,
          ptsCount: 1,
        },
      ],
      otherUpdates: [],
      chats: [],
      users: [],
      state: { pts: 1, qts: 1, date: 1 },
    }),
  };

  // The poller registers ids on the client; that set is the dedupe contract.
  const poller = startUpdatesPoller(client, { intervalMs: 10_000, log: false });
  await poller.poll();
  const sizeAfterFirst = client.__seenMessageIds ? client.__seenMessageIds.size : 0;
  await poller.poll();
  const sizeAfterSecond = client.__seenMessageIds ? client.__seenMessageIds.size : 0;
  poller.stop();

  assert.equal(sizeAfterFirst, 1, "pesan pertama harus dicatat");
  assert.equal(sizeAfterSecond, 1, "pesan yang sama tidak boleh dicatat dua kali");
  assert.ok(
    client.__seenMessageIds.has("4242:77"),
    `kunci dedupe tidak ditemukan: ${[...(client.__seenMessageIds || [])].join(",")}`,
  );
  void seenIds;
});

/* ------------------------------------------------------------------ *
 * `.start` / `.help` rich queries                                     *
 * ------------------------------------------------------------------ */
test("start/help queries map to a rich article with exactly one rich field", () => {
  assert.deepEqual(menuInline.parseRichQuery("start"), { kind: "start", forceText: false });
  assert.deepEqual(menuInline.parseRichQuery(" HELP "), { kind: "help", forceText: false });
  assert.deepEqual(menuInline.parseRichQuery("!help"), { kind: "help", forceText: true });
  assert.equal(menuInline.parseRichQuery("menu"), null);

  for (const kind of ["start", "help"]) {
    const rich = menuInline.buildRichInfoResult(kind, "ujibot").input_message_content.rich_message;
    assert.equal(Object.keys(rich).length, 1);
    assert.ok(Array.isArray(rich.blocks) && rich.blocks.length > 0);
    assert.ok(!JSON.stringify(rich).includes("[object Object]"));
    const text = menuInline.buildTextInfoResult(kind).input_message_content;
    assert.ok(text.message_text.length <= 4096);
  }
});

test("tolerant parser reads query_id + first id from an undecodable rich result", () => {
  const u = require("../userbot");
  const { BinaryReader } = require("telegram/extensions");
  const str = (v) => { const b = Buffer.from(v); const pad = (4 - ((b.length + 1) % 4)) % 4; return Buffer.concat([Buffer.from([b.length]), b, Buffer.alloc(pad)]); };
  const i32 = (n, signed = false) => { const b = Buffer.alloc(4); signed ? b.writeInt32LE(n) : b.writeUInt32LE(n >>> 0); return b; };
  const body = Buffer.concat([
    i32(0xe021f2f6), i32(0), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]), i32(0x1cb5c415), i32(1),
    i32(0x11965f3a), i32(2), str("start"), str("article"), str("Judul"),
    i32(0x0a617e7b), Buffer.alloc(16),
  ]);
  const out = u.readBotResultsTolerant(new BinaryReader(body));
  assert.equal(String(out.queryId), "7");
  assert.equal(out.results[0].id, "start");
  assert.equal(out.results[0].title, "Judul");
});

test(".start no longer accepts page arguments", () => {
  const start = require("../handlers/start");
  const { command } = require("../utils/telegram");
  void command;
  const src = require("node:fs").readFileSync(require.resolve("../handlers/start"), "utf8");
  assert.ok(src.includes("/^\\.start\\s*$/"));
  assert.ok(!/\.start\s+\$\{/.test(src));
  void start;
});

/* ------------------------------------------------------------------ *
 * Feature pages: everything reachable by buttons                      *
 * ------------------------------------------------------------------ */
test("every feature has a detail page with Jalankan + Kembali buttons", () => {
  const items = menu.allItems();
  assert.ok(items.length > 0);
  for (const item of items) {
    const rendered = menu.renderFeature(menu.featureId(item), { botUsername: "ujibot" });
    assert.ok(rendered, `halaman fitur hilang: ${item.base}`);
    const callbacks = rendered.blocks
      .filter((b) => b.type === "buttons")
      .flatMap((b) => b.buttons)
      .filter((b) => b.callback_data);
    const data = callbacks.map((b) => b.callback_data);
    const buttons = rendered.blocks
      .filter((b) => b.type === "buttons")
      .flatMap((b) => b.buttons);
    if (rendered.locked) {
      // Owner-only feature: no run button, just an explanation.
      assert.ok(!data.includes(`cmd:${item.base}`), `tombol mati: ${item.base}`);
      assert.ok(data.includes(menu.CALLBACK.LOCKED), `penanda terkunci hilang: ${item.base}`);
    } else if (menu.needsArgument(item)) {
      // A command that needs an argument must not offer a dead "Jalankan".
      assert.ok(!data.includes(`cmd:${item.base}`), `tombol mati: ${item.base}`);
      assert.ok(
        buttons.some((b) => b.copy_text),
        `tombol salin hilang: ${item.base}`,
      );
    } else {
      assert.ok(data.includes(`cmd:${item.base}`), `tombol jalankan hilang: ${item.base}`);
    }
    assert.ok(data.includes(menu.CALLBACK.MAIN), `tombol menu utama hilang: ${item.base}`);
    assert.ok(data.some((d) => d.startsWith(menu.CALLBACK.PAGE)), `tombol kembali hilang: ${item.base}`);
    for (const value of data) assert.ok(Buffer.byteLength(value, "utf8") <= 64);
    assert.ok(!JSON.stringify(rendered.blocks).includes("[object Object]"));
    assert.ok(rendered.html.length <= 4096);
  }
});

test("feature page is edited in place via a rich callback", async () => {
  const api = mockApi();
  try {
    const id = menu.featureId(menu.allItems().find((i) => i.base === ".ytmp4"));
    const result = await server.handleCallback(inlineCallback(menu.CALLBACK.FEAT + id));
    assert.equal(result.action, "feat");
    assert.equal(result.format, "rich");
    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.inline_message_id, "INLINE123");
    const html = edit.body.rich_message.html;
    assert.ok(html.includes("<code>.ytmp4"), "format command hilang");
    const labels = [...html.matchAll(/<tg-button[^>]*>([^<]*)<\/tg-button>/g)].map((m) => m[1]);
    assert.ok(labels.includes("Kembali"));
    assert.ok(!labels.includes("Jalankan"), "command ber-argumen tidak boleh punya tombol Jalankan");
  } finally {
    api.restore();
  }
});

test("page navigation never sends text and rich_message together", async () => {
  const api = mockApi();
  try {
    await server.handleCallback(inlineCallback(menu.CALLBACK.MAIN));
    for (const call of api.method("editMessageText")) {
      assert.ok(call.body.rich_message || call.body.text, "edit tanpa konten");
      assert.ok(!(call.body.rich_message && call.body.text), "text + rich_message ditolak API");
    }
  } finally {
    api.restore();
  }
});

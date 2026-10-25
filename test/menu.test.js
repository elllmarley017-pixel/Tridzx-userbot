"use strict";
/**
 * Tests for the interactive `.start` menu.
 *
 * Covers the reported bugs directly:
 *   - no `[object Object]` anywhere (HTML, plain text, buttons)
 *   - real `InlineKeyboardMarkup` (not simulated copy-text buttons)
 *   - callback navigation edits the same message (no duplicates)
 *   - owner gate on menus and callbacks
 *   - commands picked from a button are queued for the userbot
 *
 * No network: `global.fetch` is replaced with a recorder.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "menu-test-"));
process.env.INLINE_CATALOG_FILE = path.join(TMP, "catalog.json");
process.env.INLINE_MEDIA_DIR = path.join(TMP, "media");
process.env.USERBOT_MENU_QUEUE = path.join(TMP, "menu_queue.json");
process.env.USERBOT_OWNER_ID = "4242";
process.env.BOT_TOKEN = "123456789:AAFakeTokenForTestsOnly_0000000000";

require("../native_bootstrap");

const menu = require("../utils/menu");
const menuQueue = require("../utils/menu_queue");
const delivery = require("../utils/menu_delivery");
const richTransport = require("../utils/rich_transport");
const server = require("../bot_api_server");
const start = require("../handlers/start");
const formatting = require("../utils/formatting");

/** Install a fake Bot API and record every call. */
function mockApi(overrides = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body, url: String(url) });
    const custom = overrides[method];
    if (custom) {
      const result = custom(body, calls);
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
          result: {
            id: 999,
            is_bot: true,
            username: "ujibot",
            supports_inline_queries: true,
            can_join_groups: true,
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 77, chat: { id: 4242 } } }),
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

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test.beforeEach(() => {
  menuQueue.clear();
  delivery.resetIdentityCache();
  richTransport.resetCapabilityCache();
});

/** Mock a server that does NOT implement sendRichMessage (404). */
function withoutRich(overrides = {}) {
  return mockApi({
    sendRichMessage: () => ({ __error: { code: 404, description: "Not Found" } }),
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */
test("every menu page is valid HTML without [object Object]", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const html = menu.renderPageHtml(page, { botUsername: "ujibot" });
    assert.ok(html.length > 0, `halaman ${page} kosong`);
    assert.ok(html.length <= menu.MAX_MESSAGE_LENGTH, `halaman ${page} melebihi 4096`);
    assert.ok(!html.includes("[object Object]"), `halaman ${page} berisi [object Object]`);
    assert.ok(!html.includes("undefined"), `halaman ${page} berisi undefined`);
    assert.match(html, /<(b|h1|blockquote)[ >]/, `halaman ${page} tanpa penekanan`);
    assert.match(html, /<code>/, "memakai inline code");
    // The parse_mode HTML parser rejects <details>/<table> (verified live), so
    // the text transport must never contain them.
    assert.ok(!/<details/i.test(html), "details tidak didukung parse_mode HTML");
    assert.ok(!/<table/i.test(html), "Telegram HTML tidak mendukung <table>");
  }
});

test("the rich menu uses <details>/<summary>/<p>/<code> as documented", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const html = menu.renderRichHtml(page, { botUsername: "ujibot" });
    assert.ok(!html.includes("[object Object]"), `halaman ${page} berisi [object Object]`);
    assert.match(html, /<details/, `halaman ${page} tanpa details`);
    assert.match(html, /<summary>/, `halaman ${page} tanpa summary`);
    assert.match(html, /<p>/, `halaman ${page} tanpa paragraf`);
    assert.match(html, /<code>/, `halaman ${page} tanpa code`);
    assert.match(html, /<tg-button-row>/, `halaman ${page} tanpa tombol`);
    // Buttons must never carry a command as their label.
    const labels = [...html.matchAll(/<tg-button[^>]*>([^<]*)<\/tg-button>/g)].map((m) => m[1]);
    for (const label of labels) {
      assert.ok(!label.trim().startsWith("."), `tombol command terlarang: ${label}`);
    }
  }
});

test("main menu lists every category and the identity block", () => {
  const html = menu.mainMenuHtml();
  for (const section of menu.SECTIONS) {
    const name = section.title.replace(/^\S+\s*/, "");
    assert.ok(html.includes(menu.esc(name)), `kategori ${section.key} hilang`);
  }
  assert.ok(html.includes(menu.esc(menu.IDENTITY.name)), "nama userbot hilang");
  for (const row of menu.IDENTITY.rows) {
    assert.ok(html.includes(menu.esc(row.label)), `baris ${row.label} hilang`);
    assert.ok(html.includes(`<code>${menu.esc(row.code)}</code>`), `nilai ${row.label} hilang`);
  }
  assert.match(html, /<details open><summary>Information<\/summary>/);
  assert.ok(html.includes("&lt;//&gt;"), "blok beta hilang");
  assert.ok(!/Ketik command/i.test(html), "menu tidak boleh menyuruh mengetik command");
});

test("main menu renders Kategori & Commands as collapsible rich details", () => {
  const { blocks } = menu.renderPageBlocks(0);
  const details = blocks.filter((b) => b.type === "details");
  assert.equal(details.length, 3, "tiga blok details diharapkan");
  assert.equal(details[0].summary, "Information");
  assert.equal(details[0].is_open, true);
  assert.equal(details[0].blocks.length, menu.IDENTITY.rows.length);
  assert.equal(details[1].summary, "Kategori & Commands");
  assert.equal(details[1].blocks.length, menu.SECTIONS.length);
  for (const [index, section] of menu.SECTIONS.entries()) {
    const text = JSON.stringify(details[1].blocks[index].text);
    assert.ok(text.includes(String(section.items.length)), `jumlah ${section.key} hilang`);
  }
  assert.equal(details[2].summary, "</>");
});

test("category pages list each command with its description", () => {
  menu.SECTIONS.forEach((section, index) => {
    const html = menu.renderPageHtml(index + 1);
    for (const [icon, command, description] of section.items) {
      assert.ok(html.includes(menu.commandBase(command)), `${command} hilang`);
      assert.ok(html.includes(menu.esc(description)), `deskripsi ${command} hilang`);
      void icon;
    }
  });
});

test("special HTML characters are escaped, never injected", () => {
  // `<`, `>` and `&` must be escaped; quotes are legal in HTML text and only
  // escaped inside attributes (`escAttr`).
  assert.equal(menu.esc("<b>x</b> & y"), "&lt;b&gt;x&lt;/b&gt; &amp; y");
  assert.equal(menu.escAttr('a"b'), "a&quot;b");
  assert.equal(menu.esc("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  // A command containing angle brackets must not become markup.
  assert.ok(menu.renderPageHtml(1).includes("&lt;query&gt;") === false);
  assert.ok(menu.renderPageHtml(1).includes("<code>.ytsearch</code>"));
});

test("truncateHtml respects the limit and closes open tags", () => {
  const long = `<b>${"x".repeat(5000)}</b>`;
  const out = menu.truncateHtml(long);
  assert.ok(out.length <= menu.MAX_MESSAGE_LENGTH);
  const opens = (out.match(/<b>/g) || []).length;
  const closes = (out.match(/<\/b>/g) || []).length;
  assert.equal(opens, closes, "tag <b> harus seimbang");
});

/* ------------------------------------------------------------------ *
 * Keyboard                                                            *
 * ------------------------------------------------------------------ */
test("keyboard is a real InlineKeyboardMarkup with working callbacks", () => {
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    const keyboard = menu.buildKeyboard(page);
    assert.ok(Array.isArray(keyboard.inline_keyboard));
    assert.ok(keyboard.inline_keyboard.length > 0);
    for (const row of keyboard.inline_keyboard) {
      assert.ok(row.length > 0);
      for (const button of row) {
        assert.equal(typeof button.text, "string");
        assert.ok(button.text.length > 0 && button.text.length <= 64);
        assert.equal(typeof button.callback_data, "string");
        assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, "callback > 64 byte");
        // Native callbacks only — never a copy_text simulation.
        assert.equal(button.copy_text, undefined);
        const parsed = menu.parseCallback(button.callback_data);
        assert.notEqual(parsed.action, "unknown", `callback tak dikenal: ${button.callback_data}`);
      }
    }
  }
});

test("a category page carries menu, close and page navigation only", () => {
  const data = menu.buildKeyboard(2).inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes(menu.CALLBACK.CLOSE), "tombol tutup hilang");
  assert.ok(data.includes(menu.CALLBACK.MAIN), "tombol menu utama hilang");
  assert.ok(data.some((d) => d.startsWith(menu.CALLBACK.PAGE)), "tombol halaman hilang");
  assert.ok(!data.some((d) => d.startsWith(menu.CALLBACK.CMD)), "tombol command terlarang");
});

test("the main menu never shows a command as a button", () => {
  const main = menu.buildKeyboard(0);
  for (const row of main.inline_keyboard) {
    for (const item of row) {
      assert.ok(!String(item.callback_data || "").startsWith(menu.CALLBACK.CMD), "tombol command terlarang");
      assert.ok(!String(item.text).trim().startsWith("."), `label command terlarang: ${item.text}`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(item.text), `emoji pada tombol: ${item.text}`);
    }
  }
});

test("buttons use documented style values only", () => {
  const allowed = new Set(["primary", "success", "danger", "link"]);
  for (let page = 0; page < menu.PAGE_COUNT; page += 1) {
    for (const row of menu.buildKeyboard(page).inline_keyboard) {
      for (const item of row) {
        if (item.style === undefined) continue;
        assert.ok(allowed.has(item.style), `style tidak didukung: ${item.style}`);
      }
    }
  }
});

test("every category has a reachable page", () => {
  menu.SECTIONS.forEach((section, index) => {
    const parsed = menu.parseCallback(menu.CALLBACK.CAT + section.key);
    assert.equal(parsed.action, "cat");
    assert.equal(parsed.page, index + 1);
    assert.equal(menu.sectionForPage(parsed.page).key, section.key);
  });
});

test("page numbers are clamped into range", () => {
  assert.equal(menu.normalizePage(-5), 0);
  assert.equal(menu.normalizePage(999), menu.PAGE_COUNT - 1);
  assert.equal(menu.normalizePage("x"), 0);
  assert.equal(menu.normalizePage(3), 3);
});

/* ------------------------------------------------------------------ *
 * Delivery                                                            *
 * ------------------------------------------------------------------ */
test("sendMenuAsBot uses sendRichMessage with blocks + RichBlockButtons", async () => {
  const api = mockApi();
  try {
    const result = await delivery.sendMenuAsBot({ chatId: 4242, page: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.transport, "bot");
    assert.equal(result.format, "rich");

    // The first call is the capability probe (empty body); the last is the real
    // send.
    const sent = api.method("sendRichMessage").at(-1);
    assert.equal(sent.body.chat_id, 4242);
    // Rich HTML is the transport that accepts <details>/<tg-button-row>.
    assert.equal(sent.body.rich_message.blocks, undefined, "memakai html, bukan blocks");
    const html = sent.body.rich_message.html;
    assert.ok(html.includes("<details"), "details hilang");
    assert.ok(html.includes("<summary>Information</summary>"), "blok Information hilang");
    assert.ok(html.includes("<tg-button-row>"), "tombol rich hilang");
    // Buttons live inside the message as RichBlockButtons; a second native
    // reply_markup would render every button twice.
    assert.equal(sent.body.reply_markup, undefined, "tombol tidak boleh dikirim dua kali");
    const callbacks = [...html.matchAll(/data="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(callbacks.length > 0, "tombol callback hilang");
    for (const value of callbacks) {
      assert.ok(Buffer.byteLength(value, "utf8") <= 64, `callback terlalu panjang: ${value}`);
    }
    // Docs: InputRichMessage takes exactly ONE of html/markdown/blocks.
    assert.equal(sent.body.rich_message.markdown, undefined);
    assert.ok(!JSON.stringify(sent.body).includes("[object Object]"));
    // The old parse_mode path must not be used when rich is available.
    assert.equal(api.method("sendMessage").length, 0);
  } finally {
    api.restore();
  }
});

test("sendMenuAsBot falls back to parse_mode HTML when rich is unavailable", async () => {
  const api = withoutRich();
  try {
    const result = await delivery.sendMenuAsBot({ chatId: 4242, page: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "html");
    const sent = api.method("sendMessage")[0];
    assert.equal(sent.body.parse_mode, "HTML");
    assert.ok(sent.body.reply_markup.inline_keyboard.length > 0);
    assert.ok(sent.body.text.includes("via @ujibot"));
    assert.equal(sent.body.link_preview_options.is_disabled, true);
  } finally {
    api.restore();
  }
});

test("a rich-specific rejection degrades to HTML instead of losing the menu", async () => {
  const api = mockApi({
    sendRichMessage: () => ({
      __error: { code: 400, description: "Bad Request: RICH_MESSAGE_CONTENT_REQUIRED" },
    }),
  });
  try {
    const result = await delivery.sendMenuAsBot({ chatId: 4242, page: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "html");
    assert.equal(api.method("sendMessage").length, 1);
  } finally {
    api.restore();
  }
});

test("delivery falls back to bridge then local when the bot cannot post", async () => {
  const api = withoutRich({
    sendMessage: () => ({ __error: { code: 403, description: "Forbidden: bot was blocked by the user" } }),
  });
  try {
    let bridgeCalled = false;
    let localCalled = false;
    const result = await delivery.deliverMenu({
      chatId: 4242,
      page: 0,
      bridge: async () => {
        bridgeCalled = true;
        return false; // bridge also fails
      },
      local: async () => {
        localCalled = true;
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, "local");
    assert.equal(bridgeCalled, true);
    assert.equal(localCalled, true);
    assert.match(result.reason, /blocked/i);
  } finally {
    api.restore();
  }
});

test("delivery uses the bridge when the bot cannot post but the bridge works", async () => {
  const api = withoutRich({
    sendMessage: () => ({ __error: { code: 400, description: "Bad Request: chat not found" } }),
  });
  try {
    const result = await delivery.deliverMenu({
      chatId: 4242,
      page: 0,
      bridge: async () => true,
      local: async () => {
        throw new Error("local harus dilewati");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.transport, "bridge");
  } finally {
    api.restore();
  }
});

test("editMenuAsBot edits the same message with rich_message (no duplicate)", async () => {
  const api = mockApi();
  try {
    const result = await delivery.editMenuAsBot({ chatId: 4242, messageId: 77, page: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "rich");
    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.chat_id, 4242);
    assert.equal(edit.body.message_id, 77);
    assert.ok(edit.body.rich_message.html.includes("<details"), "rich_message hilang saat edit");
    assert.ok(edit.body.rich_message.html.includes("<tg-button-row>"), "tombol hilang saat edit");
    assert.equal(edit.body.text, undefined, "text dan rich_message tidak boleh dikirim bersamaan");
    assert.equal(api.method("sendMessage").length, 0, "tidak boleh mengirim pesan baru");
  } finally {
    api.restore();
  }
});

test("editMenuAsBot falls back to HTML when rich is unavailable", async () => {
  const api = withoutRich();
  try {
    const result = await delivery.editMenuAsBot({ chatId: 4242, messageId: 77, page: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.format, "html");
    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.parse_mode, "HTML");
    assert.ok(edit.body.reply_markup.inline_keyboard.length > 0);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Callback handling (bot process)                                     *
 * ------------------------------------------------------------------ */
function callback(data, { from = 4242, messageId = 77, chatId = 4242 } = {}) {
  return {
    id: "cb1",
    from: { id: from, is_bot: false, first_name: "Owner" },
    data,
    message: { message_id: messageId, chat: { id: chatId, type: "private" } },
  };
}

test("callback page navigation edits in place and answers the callback", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.PAGE + 2));
    assert.equal(result.action, "page");
    assert.equal(result.page, 2);
    assert.equal(api.method("answerCallbackQuery").length, 1, "callback harus dijawab");
    assert.equal(api.method("editMessageText").length, 1);
    assert.equal(api.method("sendMessage").length, 0, "navigasi tidak boleh membuat pesan baru");
    const edit = api.method("editMessageText")[0];
    assert.equal(edit.body.message_id, 77);
    // Page 2 is the second section (Checker & Searcher). The edit may be a Rich
    // Message (blocks) or HTML — both must describe the right page.
    const body = JSON.stringify(edit.body);
    assert.ok(body.includes("Checker"), "isi halaman 2 salah");
    assert.ok(body.includes(".telesearch"), "command halaman 2 hilang");
  } finally {
    api.restore();
  }
});

test("callback main menu and category jump work", async () => {
  const api = mockApi();
  try {
    const main = await server.handleCallback(callback(menu.CALLBACK.MAIN));
    assert.equal(main.action, "main");
    assert.equal(main.page, 0);

    const cat = await server.handleCallback(callback(menu.CALLBACK.CAT + "converter"));
    assert.equal(cat.action, "cat");
    assert.equal(cat.page, 4);
    assert.equal(api.method("editMessageText").length, 2);
    assert.equal(api.method("sendMessage").length, 0);
  } finally {
    api.restore();
  }
});

test("callback close deletes the menu message", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.CLOSE));
    assert.equal(result.action, "close");
    const del = api.method("deleteMessage")[0];
    assert.equal(del.body.message_id, 77);
  } finally {
    api.restore();
  }
});

test("a non-owner can browse the menu (navigation is public)", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.PAGE + 1, { from: 111 }));
    assert.equal(result.action, "page");
    assert.ok(api.method("editMessageText").length > 0, "non-owner harus melihat halaman");
  } finally {
    api.restore();
  }
});

test("a non-owner cannot run an owner-only feature from its button", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.CMD + ".bcall", { from: 111 }));
    assert.equal(result.action, "locked");
    const answer = api.method("answerCallbackQuery")[0];
    assert.equal(answer.body.show_alert, true);
    assert.match(answer.body.text, /owner/i);
    assert.equal(menuQueue.pending().length, 0, "aksi owner tidak boleh masuk antrean");
  } finally {
    api.restore();
  }
});

test("callback command queues the command for the userbot", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.CMD + ".infobot"));
    assert.equal(result.action, "cmd");
    assert.equal(result.command, ".infobot");
    const queued = menuQueue.pending();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].action, ".infobot");
    assert.equal(queued[0].chat_id, 4242);
    assert.equal(queued[0].command, undefined, "antrean tidak lagi membawa teks command");
    assert.equal(api.method("answerCallbackQuery").length, 1);
  } finally {
    api.restore();
  }
});

test("callback command needing an argument shows the format instead of queueing", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.CMD + ".ytmp4"));
    assert.equal(result.action, "cmd-format");
    assert.equal(menuQueue.pending().length, 0, "command tanpa argumen tidak boleh diantrikan");
    const answer = api.method("answerCallbackQuery")[0];
    assert.match(answer.body.text, /argumen/i);
    // The message is edited into the feature page: format + Jalankan/Kembali.
    const edit = api.method("editMessageText").at(-1);
    const html = edit.body.rich_message.html;
    assert.ok(html.includes("<code>.ytmp4"), "format command hilang");
    assert.ok(html.includes("<details"), "detail collapsible hilang");
    const labels = [...html.matchAll(/<tg-button[^>]*>([^<]*)<\/tg-button>/g)].map((m) => m[1]);
    assert.ok(labels.includes("Kembali"), "tombol kembali hilang");
  } finally {
    api.restore();
  }
});

test("unknown callback is answered, never left spinning", async () => {
  const api = mockApi();
  try {
    const result = await server.handleCallback(callback("m:???"));
    assert.equal(result.action, "unknown");
    assert.equal(api.method("answerCallbackQuery").length, 1);
  } finally {
    api.restore();
  }
});

test("callback with a deleted message falls back to a fresh menu", async () => {
  const api = mockApi({
    editMessageText: () => ({
      __error: { code: 400, description: "Bad Request: message to edit not found" },
    }),
  });
  try {
    const result = await server.handleCallback(callback(menu.CALLBACK.PAGE + 1));
    assert.equal(result.action, "page");
    // The inline-message editor tries first, then the chat/message editor; both
    // fail for a deleted message, so a fresh menu must be sent.
    assert.ok(api.method("editMessageText").length >= 1);
    assert.equal(api.method("sendMessage").length, 1, "harus mengirim menu pengganti");
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Message command (/start)                                            *
 * ------------------------------------------------------------------ */
test("/start sends the menu with native buttons", async () => {
  const api = mockApi();
  try {
    const result = await server.handle({
      update_id: 1,
      message: { message_id: 5, chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: "/start" },
    });
    assert.equal(result, "menu");
    // Rich HTML is preferred; the text path is the fallback.
    const rich = api.method("sendRichMessage").at(-1);
    if (rich) {
      assert.ok(rich.body.rich_message.html.includes("<details"), "details hilang");
      assert.ok(rich.body.rich_message.html.includes("<tg-button-row>"), "tombol hilang");
      assert.deepEqual(rich.body.reply_parameters, { message_id: 5, allow_sending_without_reply: true });
    } else {
      const sent = api.method("sendMessage")[0];
      assert.equal(sent.body.parse_mode, "HTML");
      assert.ok(sent.body.reply_markup.inline_keyboard.length > 0);
      assert.ok(!sent.body.text.includes("[object Object]"));
    }
  } finally {
    api.restore();
  }
});

test("/start 3 opens the requested page", async () => {
  const api = mockApi();
  try {
    await server.handle({
      update_id: 2,
      message: { message_id: 6, chat: { id: 4242 }, from: { id: 4242 }, text: "/start 3" },
    });
    const body = JSON.stringify(api.method("sendRichMessage").at(-1)?.body || api.method("sendMessage")[0]?.body || {});
    assert.ok(body.includes("Stalker"), "halaman 3 (stalker) tidak terbuka");
    assert.ok(body.includes(".githubstalker"), "daftar command stalker hilang");
  } finally {
    api.restore();
  }
});

test("/start serves the menu to any user, with buttons", async () => {
  const api = mockApi();
  try {
    const result = await server.handle({
      update_id: 3,
      message: { message_id: 7, chat: { id: 111 }, from: { id: 111 }, text: "/start" },
    });
    assert.equal(result, "menu");
    // Rich first; the HTML path is the documented fallback in this mock.
    const delivered = api.method("sendRichMessage").length + api.method("sendMessage").length;
    assert.ok(delivered > 0, "menu harus terkirim ke non-owner");
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ *
 * Local (userbot) fallback + queue execution                          *
 * ------------------------------------------------------------------ */
function fakeEvent(text, client) {
  const message = {
    id: 9, chatId: 4242, senderId: 4242, message: text, rawText: text, out: true, __client: client,
    edit: async () => message, getReplyMessage: async () => null,
  };
  return {
    message, chatId: 4242, senderId: 4242, id: 9, isReply: false, replyToMsgId: null,
    __client: client, patternMatch: { group: () => undefined },
  };
}

function fakeClient() {
  const sent = [];
  const handlers = [];
  const client = {
    sent,
    addEventHandler: (handler) => {
      handlers.push(handler);
      return handler;
    },
    removeEventHandler: () => {},
    getMe: async () => ({ id: 4242, firstName: "Owner", username: "owner" }),
    sendMessage: async (chat, options) => {
      sent.push({ chat, ...options });
      return {
        id: sent.length,
        chatId: chat,
        message: options.message,
        rawText: options.message,
        __client: client,
        edit: async () => ({}),
      };
    },
    sendFile: async () => ({}),
  };
  client.handlers = handlers;
  return client;
}

test("self-chat (Saved Messages) is detected so the bot does not post to its own DM", () => {
  const client = { __me: { id: 4242 } };
  const inSelf = {
    chatId: 4242,
    senderId: 4242,
    message: { id: 1, chatId: 4242, senderId: 4242, peerId: { className: "PeerUser", userId: 4242n } },
  };
  assert.equal(start.isSelfChat(client, inSelf), true);

  const inGroup = {
    chatId: -100123,
    senderId: 4242,
    message: { id: 2, chatId: -100123, senderId: 4242, peerId: { className: "PeerChannel", channelId: 123n } },
  };
  assert.equal(start.isSelfChat(client, inGroup), false);

  const otherDm = {
    chatId: 777,
    senderId: 4242,
    message: { id: 3, chatId: 777, senderId: 4242, peerId: { className: "PeerUser", userId: 777n } },
  };
  assert.equal(start.isSelfChat(client, otherDm), false);
});

test("local fallback renders HTML without [object Object] and no dead buttons", async () => {
  const html = start.renderLocal(0, { botUsername: "ujibot" });
  assert.ok(!html.includes("[object Object]"));
  assert.match(html, /<b>/);
  assert.ok(!/\.start \d/.test(html), "tidak boleh ada .start N");
  assert.ok(html.length <= start.LEGACY_LIMIT);
});

test("renderAll stays within the MTProto limit", () => {
  const text = start.renderAll();
  assert.ok(text.length <= start.LEGACY_LIMIT);
  assert.ok(!text.includes("[object Object]"));
  for (const section of menu.SECTIONS) {
    assert.ok(text.includes(menu.commandBase(section.items[0][1])));
  }
});

test("a button action runs its handler without typing anything into the chat", async () => {
  const client = fakeClient();
  const { command } = require("../utils/telegram");
  command(client, /^\.infobot$/, async () => {}, { bypassAuth: true });
  const result = await start.executeQueuedCommand(client, {
    chat_id: 4242,
    message_id: 77,
    action: ".infobot",
  });
  assert.equal(result.ok, true);
  assert.equal(result.handled, 1, "handler .infobot harus jalan");
  assert.equal(client.sent.length, 0, "tidak boleh ada pesan command di chat");
});

test("a queued command is dispatched to its handler without relying on getDifference", async () => {
  const { dispatchCommandText, command } = require("../utils/telegram");
  const client = fakeClient();
  let ran = 0;
  command(client, /^\.infobot$/, async () => {
    ran += 1;
  }, { bypassAuth: true });

  const message = await client.sendMessage(4242, { message: ".infobot" });
  const handled = await dispatchCommandText(client, { message, chatId: 4242, id: message.id });
  assert.equal(handled, 1);
  assert.equal(ran, 1);

  // Non-matching text must not trigger the handler.
  const other = await client.sendMessage(4242, { message: ".ytmp4 x" });
  assert.equal(await dispatchCommandText(client, { message: other, chatId: 4242, id: other.id }), 0);
  assert.equal(ran, 1);
});

test("channel posts are dispatched even when Telegram omits the out flag", async () => {
  const { dispatchCommandText, command } = require("../utils/telegram");
  const client = fakeClient();
  let ran = 0;
  command(client, /^\.start$/, async () => {
    ran += 1;
  }, { bypassAuth: true });
  // A channel post GramJS reports with out: false.
  const message = { id: 5, chatId: -100123, message: ".start", rawText: ".start", out: false };
  assert.equal(await dispatchCommandText(client, { message, chatId: -100123, id: 5 }), 1);
  assert.equal(ran, 1);
});

test("queue worker drains and runs each button action once", async () => {
  const client = fakeClient();
  menuQueue.enqueue({ chatId: 4242, action: ".infobot" });

  const worker = start.startMenuQueue(client, { intervalMs: 250, log: false });
  await new Promise((resolve) => setTimeout(resolve, 700));
  worker.stop();

  assert.equal(menuQueue.pending().length, 0, "antrean harus kosong setelah dieksekusi");
  // Nothing is typed into the chat: the handler produced the answer itself.
  assert.equal(client.sent.length, 0, "tidak boleh ada pesan command");

  // A second drain must not re-run anything (no duplicates).
  const again = start.startMenuQueue(client, { intervalMs: 250, log: false });
  await new Promise((resolve) => setTimeout(resolve, 500));
  again.stop();
  assert.equal(client.sent.length, 0, "aksi tidak boleh dijalankan dua kali");
});

test("queued command rejects non-command payloads", async () => {
  const client = fakeClient();
  const result = await start.executeQueuedCommand(client, { chat_id: 4242, action: "rm -rf /" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bukan-aksi");
  assert.equal(client.sent.length, 0);
});

/* ------------------------------------------------------------------ *
 * [object Object] regression                                          *
 * ------------------------------------------------------------------ */
test("richToPlain flattens Rich Message and RichText without [object Object]", () => {
  const rich = require("../utils/rich_message");
  const message = rich.buildRichMessage([
    rich.block.paragraph("Halo"),
    rich.block.buttons([rich.richButton("X", { copy_text: ".x" })]),
  ]);
  assert.ok(!formatting.richToPlain(message).includes("[object Object]"));
  assert.ok(!formatting.escapeMarkdown(message).includes("[object Object]"));
  assert.ok(!formatting.toText([rich.text.bold("A"), " ", { type: "italic", text: "B" }]).includes("[object Object]"));
  assert.equal(formatting.richToPlain({ text: { text: "dalam" } }), "dalam");
  assert.equal(formatting.richToPlain(undefined), "");
  assert.equal(formatting.richToPlain(42), "42");
});

test("passing a Rich Message object to a text field never yields [object Object]", () => {
  const rich = require("../utils/rich_message");
  const message = rich.buildRichMessage([rich.block.paragraph("Isi")]);
  const card = formatting.formatRichMessage({
    title: "Judul",
    body: message,
    details: [message],
    footer: message,
  });
  assert.ok(!card.legacy.includes("[object Object]"));
  assert.ok(!card.html.includes("[object Object]"));
  assert.ok(card.legacy.includes("Isi"));
});

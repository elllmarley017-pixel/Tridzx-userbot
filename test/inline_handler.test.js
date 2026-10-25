"use strict";
/**
 * Integration tests for `handlers/inline.js` (userbot side).
 *
 * A fake GramJS client/event is used: no network, no Telegram session. The
 * catalogue is redirected to a temp directory before the modules load.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Resolve `telegram` from the Termux-internal node_modules (see native_bootstrap).
require("../native_bootstrap");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "inline-handler-"));
process.env.INLINE_CATALOG_FILE = path.join(TMP, "inline_catalog.json");
process.env.INLINE_MEDIA_DIR = path.join(TMP, "inline_media");
process.env.USERBOT_OWNER_ID = "4242";
process.env.BOT_TOKEN = "";

const catalog = require("../utils/inline_catalog");
const permissions = require("../utils/permissions");
const handler = require("../handlers/inline");

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Build a fake event + client pair that records outgoing texts. */
function harness({ text = "", reply = null, owner = true, download = null } = {}) {
  const sent = [];
  const client = {
    sendMessage: async (chat, options) => {
      sent.push(options.message);
      return { id: sent.length + 100, __client: client };
    },
    sendFile: async () => ({}),
    downloadMedia: async (message) => {
      if (download) return download(message);
      return Buffer.from("media-bytes");
    },
    getMe: async () => ({ id: 4242, firstName: "Owner", username: "owner" }),
  };
  const message = {
    id: 10,
    chatId: owner ? 4242 : 999,
    senderId: owner ? 4242 : 999,
    message: text,
    rawText: text,
    out: owner,
    // Mirror a GramJS `Api.Message`: `editMarkdown` may reuse the returned
    // object as the target of the next edit, so it must carry the peer info.
    edit: async (payload) => {
      sent.push(payload.text);
      return {
        id: 10,
        chatId: 4242,
        senderId: 4242,
        message: payload.text,
        rawText: payload.text,
        __client: client,
        edit: async (next) => {
          sent.push(next.text);
          return { id: 10, chatId: 4242, senderId: 4242, message: next.text, __client: client };
        },
      };
    },
    getReplyMessage: async () => reply,
    __client: client,
  };
  const event = {
    message,
    chatId: owner ? 4242 : 999,
    senderId: owner ? 4242 : 999,
    id: 10,
    isReply: Boolean(reply),
    replyToMsgId: reply ? 9 : null,
    __client: client,
    patternMatch: { group: () => undefined },
  };
  return { event, client, sent };
}

/** Minimal GramJS-like media message for a document/photo. */
function mediaReply(kind = "document") {
  if (kind === "photo") {
    return {
      id: 9,
      chatId: 4242,
      message: "caption foto",
      media: { className: "MessageMediaPhoto", photo: { id: "p1" } },
    };
  }
  return {
    id: 9,
    chatId: 4242,
    message: "caption dokumen",
    media: {
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        mimeType: "application/pdf",
        size: 11,
        attributes: [
          { className: "DocumentAttributeFilename", fileName: "laporan.pdf" },
        ],
      },
    },
  };
}

test.beforeEach(() => {
  catalog.clear();
  permissions.resetPermissions();
  permissions.setOwner({ getMe: async () => ({ id: 4242 }) }, { id: 4242 });
});

test("adds a text item from a replied message", async () => {
  const { event, client, sent } = harness({
    text: ".inline add Judul Satu #tag1",
    reply: { id: 9, chatId: 4242, message: "Isi konten", text: "Isi konten" },
  });
  await handler.addItem(client, event, "Judul Satu #tag1");

  const items = catalog.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal(items[0].title, "Judul Satu");
  assert.deepEqual(items[0].tags, ["tag1"]);
  assert.equal(items[0].text, "Isi konten");
  assert.match(sent.at(-1), /Judul Satu/);
});

test("add without a reply explains what to do", async () => {
  const { event, client, sent } = harness({ text: ".inline add X" });
  await handler.addItem(client, event, "X");
  assert.match(sent.at(-1), /Reply sebuah pesan/);
  assert.equal(catalog.stats().total, 0);
});

test("media item is stored locally when no Bot API token is configured", async () => {
  const { event, client, sent } = harness({
    text: ".inline add Laporan",
    reply: mediaReply("document"),
  });
  await handler.addItem(client, event, "Laporan");

  const [item] = catalog.items();
  assert.equal(item.type, "document");
  assert.equal(item.title, "Laporan");
  assert.equal(item.uploaded, false);
  assert.equal(item.file_name, "laporan.pdf");
  assert.ok(item.local_path && fs.existsSync(item.local_path), "media lokal tersimpan");
  assert.equal(fs.readFileSync(item.local_path).toString(), "media-bytes");
  assert.match(sent.at(-1), /belum diunggah/i);
});

test("photo reply is classified as photo and kept pending without token", async () => {
  const { event, client } = harness({
    text: ".inline add Foto",
    reply: mediaReply("photo"),
  });
  await handler.addItem(client, event, "Foto");
  const [item] = catalog.items();
  assert.equal(item.type, "photo");
  assert.equal(item.caption, "caption foto");
});

test("oversized media is rejected before download", async () => {
  const reply = mediaReply("document");
  reply.media.document.size = 90 * 1024 * 1024; // 90 MB > 50 MB Bot API limit
  let downloaded = false;
  const { event, client, sent } = harness({
    text: ".inline add Besar",
    reply,
    download: () => {
      downloaded = true;
      return Buffer.from("x");
    },
  });
  await handler.addItem(client, event, "Besar");
  assert.equal(downloaded, false);
  assert.match(sent.at(-1), /melebihi batas/i);
  assert.equal(catalog.stats().total, 0);
});

test("list, search and delete sub-commands answer with cards", async () => {
  catalog.add({ type: "text", title: "Promo", text: "diskon", tags: "promo" });
  const { event, client, sent } = harness({ text: ".inline list" });
  await handler.listItems(event, "");
  assert.match(sent.at(-1), /Katalog Inline/);
  assert.match(sent.at(-1), /Promo/);

  await handler.searchItems(event, "promo");
  assert.match(sent.at(-1), /Hasil Pencarian Inline/);

  const removed = catalog.remove("c1");
  assert.equal(removed.title, "Promo");
  assert.equal(catalog.stats().total, 0);
});

test("upload without token fails with a clear message", async () => {
  catalog.add({ type: "document", title: "Doc", local_path: path.join(TMP, "nope.bin") });
  const { event, client, sent } = harness({ text: ".inline upload" });
  await handler.uploadItems(client, event, "");
  assert.match(sent.at(-1), /Token Bot API belum dikonfigurasi/);
});

test("upload reports missing local files instead of throwing", async () => {
  const file = path.join(TMP, "doc.bin");
  fs.writeFileSync(file, "abc");
  catalog.add({ type: "document", title: "Doc", local_path: file, file_name: "doc.bin" });

  // Inject a token for this test only.
  const previous = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith("getMe")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 1, username: "ujibot" } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { message_id: 5, chat: { id: 4242 }, document: { file_id: "DOCX", file_unique_id: "U1", file_name: "doc.bin", file_size: 3 } },
      }),
    };
  };
  try {
    const { event, client, sent } = harness({ text: ".inline upload" });
    await handler.uploadItems(client, event, "");
    assert.match(sent.at(-1), /Unggah Selesai/);
    const [item] = catalog.items();
    assert.equal(item.file_id, "DOCX");
    assert.equal(item.uploaded, true);
    assert.equal(fs.existsSync(file), false, "media lokal dibersihkan setelah unggah");
    assert.ok(calls.some((call) => String(call.url).includes("sendDocument")));
  } finally {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = previous;
  }
});

test("non-owner is refused by the owner guard", async () => {
  const { event, client, sent } = harness({ text: ".inline list", owner: false });
  const allowed = await handler.requireOwner(client, event);
  assert.equal(allowed, false);
  assert.match(sent.at(-1), /hanya dapat digunakan oleh pemilik akun/);
});

"use strict";
/**
 * Broadcast: progress-card formatting and `.delay` synchronisation.
 */
const test = require("node:test");
const assert = require("node:assert");

// Termux keeps node_modules outside the project; this makes `require("telegram")`
// resolvable for the discovery test.
require("../native_bootstrap");

const R = "..";
const rich = require(`${R}/utils/rich_message`);
const store = require(`${R}/utils/broadcast_store`);
const queue = require(`${R}/utils/broadcast_queue`);

const fakeClient = () => ({ sendMessage: async () => {}, forwardMessages: async () => {} });
const targets = (n, base = 1000) =>
  Array.from({ length: n }, (_, i) => ({ id: base + i, title: `t${i}` }));

test("progress stats render <code> instead of a literal tag", () => {
  // The bug: passing `inlineCode(n)` as a plain string gets escaped.
  const broken = rich.renderLegacy([rich.block.paragraph(`✅ Terkirim: ${require(`${R}/utils/formatting`).inlineCode(12)}`)]);
  assert.ok(broken.includes("&lt;code&gt;"), "reproduksi bug gagal");

  // The fix: a RichText node renders as real <code>.
  const fixed = rich.renderLegacy([
    rich.block.paragraph("✅ Terkirim:", " ", rich.text.code("12")),
  ]);
  assert.ok(fixed.includes("<code>12</code>"), "angka harus jadi <code>");
  assert.ok(!fixed.includes("&lt;code&gt;"), "tidak boleh ada tag literal");

  const html = rich.renderHtml([
    rich.block.paragraph("✅ Terkirim:", " ", rich.text.code("12")),
  ]);
  assert.ok(html.includes("<code>12</code>"));
});

test(".delay is applied verbatim, not clamped to 1000 ms", () => {
  const before = store.getDelay();
  try {
    assert.equal(store.setDelay(1).applied, 1);
    assert.equal(store.getDelay(), 1);
    assert.equal(store.setDelay(1000).applied, 1000);
    assert.equal(store.getDelay(), 1000);
    assert.throws(() => store.setDelay(0), /minimal/i);
    assert.throws(() => store.setDelay(999999), /maksimal/i);
  } finally {
    store.setDelay(before);
  }
});

test("a running broadcast picks up a new .delay mid-run", async () => {
  const before = store.getDelay();
  try {
    store.setDelay(300);
    const started = Date.now();
    let changed = false;
    await queue.runQueue({
      client: fakeClient(),
      targets: targets(5),
      payload: { kind: "text", text: "x" },
      onProgress: (state) => {
        if (state.processed === 2 && !changed) {
          changed = true;
          store.setDelay(1);
        }
      },
    });
    const elapsed = Date.now() - started;
    assert.ok(changed, "perubahan delay tidak terjadi");
    // Two gaps at 300 ms, then the rest at ~0 ms.
    assert.ok(elapsed < 1200, `delay lama masih dipakai (${elapsed} ms)`);
  } finally {
    store.setDelay(before);
  }
});

test("stop still cancels a running broadcast", async () => {
  const before = store.getDelay();
  try {
    store.setDelay(1);
    const result = await queue.runQueue({
      client: fakeClient(),
      targets: targets(20, 3000),
      payload: { kind: "text", text: "x" },
      onProgress: (state) => {
        if (state.processed === 3) queue.cancel("tes");
      },
    });
    assert.equal(result.cancelled, true);
    assert.ok(result.sent < 20, "harus berhenti sebelum selesai");
    assert.ok(result.skipped > 0, "sisa target harus dilewati");
  } finally {
    store.setDelay(before);
  }
});

/* ------------------------------------------------------------------ *
 * Chat discovery + target preparation                                 *
 * ------------------------------------------------------------------ */
const discovery = require(`${R}/utils/chat_discovery`);

test("dialog ids are read from GramJS Integer objects", () => {
  // GramJS returns `{ value: bigint }` for dialog.id; missing that shape made
  // every dialog look like "no entity" ("Chat dipindai: 0").
  assert.equal(discovery.normalizeId({ value: -1003998955394n }), -1003998955394);
  assert.equal(discovery.normalizeId(-1003998955394n), -1003998955394);
  assert.equal(discovery.normalizeId("-1003998955394"), -1003998955394);
  assert.equal(discovery.normalizeId({}), null);
  assert.equal(discovery.normalizeId(null), null);
});

test("every scanned dialog is accounted for as target or skip reason", async () => {
  const { Api } = require("telegram");
  const dialogs = [
    { id: { value: -100n }, entity: Object.assign(new Api.Channel(), { id: -100, title: "g", broadcast: false, megagroup: true }), title: "g" },
    { id: { value: 200n }, entity: Object.assign(new Api.User(), { id: 200, firstName: "a" }), title: "a" },
    { id: { value: 300n }, entity: Object.assign(new Api.User(), { id: 300, bot: true }), title: "b" },
  ];
  const client = { iterDialogs: () => dialogs[Symbol.iterator]() };
  const found = await discovery.discoverChats(client, { selfId: "999" });

  const total =
    found.targets.length +
    Object.values(found.skipped).reduce((sum, value) => sum + value, 0);
  assert.equal(found.scanned, 3);
  assert.equal(total, found.scanned, "target + skipped harus sama dengan scanned");
  assert.equal(found.targets.length, 2, "grup + user valid");
  assert.equal(found.skipped.bot, 1);
});

test("blacklist and duplicates are counted, never silently dropped", () => {
  const saved = store.blacklist();
  try {
    // Clean slate for a deterministic assertion.
    for (const entry of saved) store.removeBlacklist(entry.id);
    store.addBlacklist(-500, "blokir");

    const dialogs = [
      { id: -100, title: "a" },
      { id: -100, title: "a-dup" },
      { id: -500, title: "blokir" },
      { id: -200, title: "b" },
    ];
    const prepared = queue.prepareTargets(dialogs, {});
    assert.equal(prepared.targets.length, 2, "dua target unik yang sah");
    assert.equal(prepared.skipped.duplicate, 1, "duplikat harus dihitung");
    assert.equal(prepared.skipped.blacklisted, 1, "blacklist harus dihitung");
    const ids = prepared.targets.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, "tidak boleh ada id ganda");
  } finally {
    store.removeBlacklist(-500);
    for (const entry of saved) store.addBlacklist(entry.id, entry.title);
  }
});

test("prepareTargets excludes only the explicit chat, not every target", () => {
  const dialogs = [
    { id: -100, title: "a" },
    { id: -200, title: "b" },
    { id: 300, title: "c" },
  ];
  const prepared = queue.prepareTargets(dialogs, { exclude: new Set([300]) });
  assert.equal(prepared.targets.length, 2);
  assert.equal(prepared.skipped.excluded, 1);
});

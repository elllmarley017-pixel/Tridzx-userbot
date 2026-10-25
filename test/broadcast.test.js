"use strict";
/**
 * Broadcast: progress-card formatting and `.delay` synchronisation.
 */
const test = require("node:test");
const assert = require("node:assert");

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

"use strict";
/**
 * Owner & premium access management.
 */
const test = require("node:test");
const assert = require("node:assert");

require("../native_bootstrap");

const access = require("../utils/access_store");

test("a user reference accepts id, @username and t.me links", () => {
  assert.deepEqual(access.parseUserRef("123456789"), { kind: "id", id: 123456789 });
  assert.deepEqual(access.parseUserRef("@telegram"), { kind: "username", username: "telegram" });
  assert.deepEqual(access.parseUserRef("telegram"), { kind: "username", username: "telegram" });
  assert.deepEqual(access.parseUserRef("t.me/durov"), { kind: "username", username: "durov" });
  assert.deepEqual(access.parseUserRef("https://t.me/durov"), { kind: "username", username: "durov" });
  assert.equal(access.parseUserRef(""), null);
  assert.equal(access.parseUserRef("@@bad"), null);
});

test("an over-long username is rejected as invalid, not sent to Telegram", () => {
  assert.equal(access.parseUserRef("a".repeat(40)), null);
});

test("owners are stored persistently and de-duplicated", () => {
  const before = access.extraOwnerIds();
  try {
    for (const id of before) access.removeOwner(id);

    assert.equal(access.addOwner(111).added, true);
    assert.equal(access.addOwner(111).added, false, "duplikat tidak ditambahkan lagi");
    assert.deepEqual(access.extraOwnerIds(), [111]);
    assert.equal(access.removeOwner(111).removed, true);
    assert.equal(access.removeOwner(111).removed, false);
    assert.deepEqual(access.extraOwnerIds(), []);
  } finally {
    for (const id of access.extraOwnerIds()) access.removeOwner(id);
    for (const id of before) access.addOwner(id);
  }
});

test("premium stores expiry and expires automatically", () => {
  const id = 999000111;
  try {
    const added = access.addPremium(id, 30);
    assert.equal(added.days, 30);
    assert.ok(Date.parse(added.expiresAt) > Date.now());
    assert.equal(access.isPremium(id), true);

    // 31 days later the access is gone without any background job.
    assert.equal(access.isPremium(id, Date.now() + 31 * 86400000), false);
    assert.equal(access.premiumOf(id, Date.now() + 31 * 86400000), null);

    // Extending an active entry adds on top of the current expiry.
    const extended = access.addPremium(id, 5);
    assert.equal(extended.extended, true);
    assert.equal(extended.days, 35);

    assert.equal(access.removePremium(id).removed, true);
    assert.equal(access.isPremium(id), false);
  } finally {
    access.removePremium(id);
  }
});

test("premium rejects invalid duration", () => {
  assert.throws(() => access.addPremium(123, 0), /minimal 1 hari/i);
  assert.throws(() => access.addPremium(123, -5), /minimal 1 hari/i);
  assert.throws(() => access.addPremium(123, 999999), /maksimal/i);
  assert.throws(() => access.addPremium(0, 5), /tidak valid/i);
});

test("list handlers exist for owners and premium", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../handlers/access"),
    "utf8",
  );
  assert.match(src, /\\\.\(\?:listowner\|ownerlist\)/, "handler .listowner hilang");
  assert.match(src, /\\\.\(\?:listprem\|premlist\)/, "handler .listprem hilang");
});

test("owner and premium lists render as tables", () => {
  const rich = require("../utils/rich_message");
  const fmt = require("../utils/formatting");
  const msg = fmt.formatRichMessage({
    title: "Daftar Owner",
    table: { headers: ["ID", "Peran"], rows: [["1", "utama"]] },
    buttons: [rich.richButton("Tambah Owner", { copy_text: ".addowner " }, "primary")],
  });
  assert.ok(msg.html.includes("<table>"), "rich harus memakai <table>");
  assert.ok(!/<table/i.test(msg.legacy), "fallback tidak boleh memakai <table>");
  assert.ok(msg.legacy.includes("<pre>"), "fallback tabel harus <pre>");
  // The copy button keeps its label next to the payload.
  assert.ok(msg.legacy.includes("Tambah Owner"), "label tombol hilang di fallback");
  assert.ok(!msg.legacy.includes("[object Object]"));
});

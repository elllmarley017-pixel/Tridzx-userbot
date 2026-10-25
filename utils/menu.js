"use strict";
/**
 * Single source of truth for the interactive `.start` menu.
 *
 * Both processes use this module so the userbot and the Bot API can never drift
 * apart:
 *
 *   handlers/start.js   → renders the same pages locally when the Bot API is
 *                         unavailable (fallback), and dispatches commands the
 *                         owner picks from the native buttons.
 *   bot_api_server.js   → sends the menu as `parse_mode: "HTML"` +
 *                         `InlineKeyboardMarkup` and handles `callback_query`
 *                         edits in place (no duplicate messages).
 *
 * Telegram constraints honoured here:
 *   - `parse_mode: "HTML"` supports only b/i/u/s/code/pre/a/blockquote/
 *     tg-spoiler — never <table>, so the overview uses a <pre> table.
 *   - message text ≤ 4096 chars → every page is trimmed with `truncateHtml`.
 *   - `callback_data` ≤ 64 bytes → `cb()` clamps and validates.
 *   - `editMessageText` must keep the same reply_markup or the keyboard is
 *     dropped, so page renders always return text + keyboard together.
 */

const MAX_MESSAGE_LENGTH = 4096;
const MAX_CALLBACK_BYTES = 64;
const MAX_BUTTON_TEXT = 64;

/* ------------------------------------------------------------------ *
 * Catalogue                                                           *
 * ------------------------------------------------------------------ */
/**
 * One entry per feature page.
 * `items` rows are `[icon, command, description]`; `command` doubles as the
 * copy payload and as the callback target (`cmd:<base>`).
 */
const SECTIONS = [
  {
    key: "downloader",
    title: "⬇️ Downloader",
    icon: "⬇️",
    items: [
      ["🔎", ".ytsearch <query>", "Cari video YouTube"],
      ["🎬", ".ytmp4 <link> [resolusi]", "Download video YouTube (MP4)"],
      ["🎵", ".ytmp3 <link>", "Download audio YouTube (MP3)"],
      ["📘", ".fb <link>", "Download video Facebook"],
      ["🎧", ".spotify <link>", "Download lagu Spotify"],
      ["🎬", ".videy <link>", "Download video Videy"],
      ["📌", ".pin <link>", "Download media Pinterest"],
      ["🎵", ".tt <link>", "Download video TikTok"],
      ["📷", ".ttpic <link>", "Download foto/slide TikTok"],
      ["📁", ".mediafire <link>", "Download file MediaFire"],
      ["🐙", ".github <link>", "Download repository/folder GitHub"],
    ],
  },
  {
    key: "checker",
    title: "🔍 Checker & Searcher",
    icon: "🔍",
    items: [
      ["🆔", ".id <username>", "Cek ID Telegram"],
      ["🔎", ".telesearch <text>", "Cari user/channel/group Telegram"],
      ["📜", ".getchat <id/username>", "Export history yang dapat diakses"],
      ["🎯", ".ttsearch <query> <account|vt>", "Cari akun/video TikTok"],
    ],
  },
  {
    key: "stalker",
    title: "🕵️ Stalker",
    icon: "🕵️",
    items: [
      ["🕵️", ".ttstalker <username>", "Info publik TikTok"],
      ["🐙", ".githubstalker <username>", "Info publik GitHub"],
      ["🎮", ".robloxstalker <username>", "Info publik Roblox"],
      ["📸", ".igstalker <username>", "Info publik Instagram"],
      ["𝕏", ".xstalker <username>", "Info publik X/Twitter"],
      ["📘", ".fbstalker <username>", "Info publik Facebook"],
      ["📌", ".pinstalker <username>", "Info publik Pinterest"],
      ["📺", ".ytstalker <username>", "Info publik YouTube"],
      ["🌐", ".extrastalker <username>", "Cek 38 platform publik"],
    ],
  },
  {
    key: "converter",
    title: "🔧 Converter",
    icon: "🔧",
    items: [
      ["🖼️", ".stiker", "Tambahkan gambar ke pack tenzu_stick"],
      ["🖼️", ".s", "Tambahkan gambar ke pack tenzu_stick"],
      ["🖼️", ".toimg", "Konversi sticker statis menjadi PNG"],
      ["🎞️", ".togif", "Konversi sticker animasi/video menjadi GIF"],
      ["🎵", ".tomp3", "Konversi video/audio/voice menjadi MP3"],
      ["▣", ".toqr <text>", "Ubah teks menjadi QR Code"],
      ["🎙️", ".tovn", "Konversi audio/video menjadi Voice Note"],
    ],
  },
  {
    key: "ai",
    title: "🤖 AI & Info",
    icon: "🤖",
    items: [
      ["🤖", ".ai <text>", "AI Chat & Coding Assistant"],
      ["ℹ️", ".infobot", "Informasi bot, owner, dan uptime"],
    ],
  },
  {
    key: "broadcast",
    title: "📢 Broadcast",
    icon: "📢",
    items: [
      ["📢", ".bcall <teks>", "Kirim teks ke semua chat tujuan"],
      ["📨", ".bcall (reply)", "Reply pesan lalu kirim isinya ke semua tujuan"],
      ["➕", ".bcall add", "Tambahkan chat ini ke daftar tujuan"],
      ["📋", ".bcall list", "Lihat daftar tujuan dan blacklist"],
      ["🛑", ".bcall stop", "Hentikan broadcast yang sedang berjalan"],
      ["⏱", ".delay <ms>", "Atur jeda antar pesan (minimal 1000 ms)"],
      ["🚫", ".addbl", "Masukkan chat ini ke blacklist"],
    ],
  },
  {
    key: "inline",
    title: "🗂️ Inline",
    icon: "🗂️",
    items: [
      ["🗂️", ".inline", "Status katalog Inline Mode"],
      ["➕", ".inline add <judul>", "Simpan konten yang di-reply ke katalog"],
      ["📋", ".inline list [kata]", "Lihat & cari katalog"],
      ["⏫", ".inline upload [id|all]", "Unggah media ke Bot API"],
      ["📤", ".inline send <id> [chat]", "Kirim item sebagai bot"],
      ["🔍", ".inline search <kata>", "Uji mesin pencari inline"],
      ["📊", ".inline status", "Ringkasan katalog + kesiapan"],
    ],
  },
];

const TOTAL_COMMANDS = SECTIONS.reduce((sum, section) => sum + section.items.length, 0);

/** Page 0 is the overview; pages 1…N are one category each. */
const PAGE_COUNT = SECTIONS.length + 1;
const DIVIDER = "┈".repeat(14);
const FOOTER = "Pilih fitur lewat tombol. Tidak perlu mengetik command.";

/**
 * Identity shown on the main menu. Every value is real project data.
 * `label` is the visible text, `value` is what `<code>` shows (and what the
 * user can copy), `url` makes it tappable where a link is meaningful.
 */
const IDENTITY = {
  name: "HanzTenzu Userbot",
  rows: [
    { label: "Owner", text: "t.me/HanzTenzX", url: "https://t.me/HanzTenzX", code: "11" },
    { label: "Status", text: "Userbot Rich Message", code: "4" },
    { label: "Channel", text: "@TenzXodiadores", url: "https://t.me/TenzXodiadores", code: "9" },
    {
      label: "GitHub",
      text: "github.com/elllmarley017-pixel",
      url: "https://github.com/elllmarley017-pixel",
      code: "7",
    },
  ],
  beta: "Userbot ini adalah versi beta yang sedang dikembangkan oleh HanzTenzu!!",
};

/** One identity row → `<p>Label: text <code>n</code></p>` (rich HTML). */
function identityRowHtml(row) {
  const text = row.url
    ? `<a href="${escAttr(row.url)}">${esc(row.text)}</a>`
    : esc(row.text || "");
  const tail = row.code ? ` <code>${esc(row.code)}</code>` : "";
  return `<p>${esc(row.label)}: ${text}${tail}</p>`;
}

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */
/** Escape untrusted text for `parse_mode: "HTML"`. */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return esc(value).replace(/"/g, "&quot;");
}

/** `<code>` span (payload is escaped, so `<link>` never becomes markup). */
function code(value) {
  return `<code>${esc(value)}</code>`;
}

/** `<b>` span. */
function bold(value) {
  return `<b>${esc(value)}</b>`;
}

/**
 * Strip the `<placeholder>` / `[optional]` part of a command so the callback
 * payload is paste-ready while sub-commands stay distinct:
 *
 *   ".ytmp4 <link> [resolusi]" -> ".ytmp4"
 *   ".bcall add"               -> ".bcall add"
 *   ".bcall (reply)"           -> ".bcall"
 */
function commandBase(value) {
  return String(value == null ? "" : value)
    .replace(/\(reply\)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Trim HTML to Telegram's 4096-char limit without leaving a dangling tag.
 * Mirrors the re-open/close strategy used by `utils/formatting.js`.
 */
function truncateHtml(value, limit = MAX_MESSAGE_LENGTH) {
  const out = String(value == null ? "" : value);
  if (out.length <= limit) return out;

  const notice = "\n<i>… menu dipotong karena batas Telegram.</i>";
  let budget = Math.max(0, limit - notice.length);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let cut = out.slice(0, budget).replace(/<[^>]*$/, "").replace(/&[a-zA-Z#0-9]*$/, "");
    const open = [];
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
    let match;
    while ((match = tagRe.exec(cut))) {
      const [, closing, name, , selfClosing] = match;
      const tag = name.toLowerCase();
      if (["br", "hr"].includes(tag) || selfClosing) continue;
      if (closing) {
        const index = open.lastIndexOf(tag);
        if (index !== -1) open.splice(index, 1);
      } else {
        open.push(tag);
      }
    }
    const result = `${cut}${open.reverse().map((tag) => `</${tag}>`).join("")}${notice}`;
    if (result.length <= limit) return result;
    budget -= result.length - limit;
    if (budget <= 0) return notice.trim();
  }
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Callback data                                                       *
 * ------------------------------------------------------------------ */
/**
 * Build a callback payload and guarantee the 64-byte Bot API limit.
 * Callback data is a protocol field, never user-visible, so truncating it is
 * safe — an over-long payload would make Telegram reject the whole keyboard.
 */
function cb(value) {
  let data = String(value == null ? "" : value);
  while (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) data = data.slice(0, -1);
  return data;
}

/** Callback namespaces handled by `bot_api_server.js`. */
const CALLBACK = {
  PAGE: "m:page:",
  MAIN: "m:main",
  CAT: "m:cat:",
  CMD: "cmd:",
  CLOSE: "m:close",
  HELP: "m:help",
  /** One feature's detail view (description, format, back button). */
  FEAT: "m:f:",
  /** Tapped a feature that requires the owner. */
  LOCKED: "m:locked",
};

/**
 * Parse a callback payload.
 * @returns {{action: "page"|"main"|"cat"|"cmd"|"close"|"help"|"unknown", value?: string, page?: number}}
 */
function parseCallback(data) {
  const raw = String(data == null ? "" : data);
  if (raw === CALLBACK.MAIN) return { action: "main", page: 0 };
  if (raw === CALLBACK.CLOSE) return { action: "close" };
  if (raw === CALLBACK.HELP) return { action: "help" };
  if (raw === CALLBACK.LOCKED) return { action: "locked" };
  if (raw.startsWith(CALLBACK.PAGE)) {
    const page = Number(raw.slice(CALLBACK.PAGE.length));
    return { action: "page", page: Number.isInteger(page) ? page : 0 };
  }
  if (raw.startsWith(CALLBACK.CAT)) {
    const key = raw.slice(CALLBACK.CAT.length);
    const index = SECTIONS.findIndex((section) => section.key === key);
    return { action: "cat", value: key, page: index >= 0 ? index + 1 : 0 };
  }
  if (raw.startsWith(CALLBACK.CMD)) {
    return { action: "cmd", value: raw.slice(CALLBACK.CMD.length) };
  }
  if (raw.startsWith(CALLBACK.FEAT)) {
    return { action: "feat", value: raw.slice(CALLBACK.FEAT.length) };
  }
  return { action: "unknown", value: raw };
}

/* ------------------------------------------------------------------ *
 * Page rendering (HTML)                                               *
 * ------------------------------------------------------------------ */
/** Page number → section (null for the overview). */
function sectionForPage(page) {
  const index = Number(page) - 1;
  return index >= 0 && index < SECTIONS.length ? SECTIONS[index] : null;
}

/** Clamp a page number into `0 … PAGE_COUNT-1`. */
function normalizePage(page) {
  const value = Number(page);
  if (!Number.isInteger(value)) return 0;
  return Math.min(Math.max(value, 0), PAGE_COUNT - 1);
}

/**
 * Main menu as HTML for a **Rich Message** (`rich_message.html`).
 *
 * `<details>`, `<summary>`, `<p>` and `<code>` are documented Rich HTML tags;
 * the plain `parse_mode: "HTML"` parser rejects them (verified: "Unsupported
 * start tag"). That is why the main menu is delivered as a rich message and
 * `mainMenuFallbackHtml()` covers the text-only transport.
 *
 * @param {object} [options]
 * @param {string} [options.botUsername]
 * @returns {string}
 */
function mainMenuHtml(options = {}) {
  const info = IDENTITY.rows.map(identityRowHtml).join("");
  const categories = SECTIONS.map(
    (entry) =>
      `<p>${esc(entry.title.replace(/^\S+\s*/, ""))} — <code>${entry.items.length}</code></p>`,
  ).join("");
  return [
    `<h1>${esc(IDENTITY.name)}</h1>`,
    `<details open><summary>Information</summary>${info}</details>`,
    `<details><summary>Kategori &amp; Commands</summary>${categories}</details>`,
    `<details><summary>&lt;//&gt;</summary><p>${esc(IDENTITY.beta)}</p></details>`,
  ].join("");
}

/**
 * Same information for `parse_mode: "HTML"`, where `<details>`/`<summary>` are
 * not supported. `<blockquote expandable>` is the documented collapsible
 * equivalent, so the fallback keeps the same structure.
 */
function mainMenuFallbackHtml(options = {}) {
  const info = IDENTITY.rows
    .map((row) => identityRowHtml(row).replace(/^<p>|<\/p>$/g, ""))
    .join("\n");
  const categories = SECTIONS.map(
    (entry) => `${esc(entry.title.replace(/^\S+\s*/, ""))} — <code>${entry.items.length}</code>`,
  ).join("\n");
  void options;
  return [
    `<b>${esc(IDENTITY.name)}</b>`,
    "",
    `<blockquote expandable><b>Information</b>\n${info}</blockquote>`,
    `<blockquote expandable><b>Kategori &amp; Commands</b>\n${categories}</blockquote>`,
    `<blockquote expandable><b>&lt;//&gt;</b>\n${esc(IDENTITY.beta)}</blockquote>`,
  ].join("\n");
}

/**
 * One category page as HTML: every command in its own `<p><code>…</code>`.
 * `collapsible` selects `<details>` (rich) or `<blockquote expandable>`.
 */
function categoryHtml(page, options = {}) {
  const index = normalizePage(page);
  const section = sectionForPage(index);
  if (!section) return mainMenuHtml(options);
  const title = esc(section.title.replace(/^\S+\s*/, ""));
  // `<p>`/`<details>` are Rich HTML only; the parse_mode fallback keeps the
  // documented `<blockquote expandable>` and plain lines.
  if (options.collapsible === false) {
    const lines = section.items
      .map(([, command, description]) => `<code>${esc(commandBase(command))}</code> — ${esc(description)}`)
      .join("\n");
    return `<b>${title}</b>\n<blockquote expandable>${lines}</blockquote>`;
  }
  const rows = section.items
    .map(
      ([, command, description]) =>
        `<p><code>${esc(commandBase(command))}</code> — ${esc(description)}</p>`,
    )
    .join("");
  return `<h2>${title}</h2><details open><summary>Command</summary>${rows}</details>`;
}

/**
 * Render one page as Telegram HTML.
 *
 * @param {number} page       0 = overview, 1…N = category pages
 * @param {object} [options]
 * @param {string} [options.botUsername]  adds the "via @bot" marker
 * @param {string} [options.ownerLabel]   shown in the header
 * @returns {string} HTML ready for `parse_mode: "HTML"`
 */
function renderPageHtml(page, options = {}) {
  const index = normalizePage(page);
  const section = sectionForPage(index);
  const via = options.botUsername
    ? `\n\n<i>Menu ini dikirim via ${esc(`@${String(options.botUsername).replace(/^@/, "")}`)} · tombol di bawah interaktif.</i>`
    : "";

  if (!section) {
    return truncateHtml(`${mainMenuFallbackHtml(options)}${via}`);
  }

  return truncateHtml(`${categoryHtml(index, { collapsible: false })}${via}`);
}

/* ------------------------------------------------------------------ *
 * Keyboard (InlineKeyboardMarkup)                                     *
 * ------------------------------------------------------------------ */
function button(label, data) {
  return { text: String(label).slice(0, MAX_BUTTON_TEXT), callback_data: cb(data) };
}

/**
 * Build the native `InlineKeyboardMarkup` for a page.
 *
 * Layout:
 *   [category] [category]        ← 2 per row, current page highlighted
 *   [command] [command] [command] ← only on category pages
 *   [⬅️] [🏠 Menu] [➡️]
 *   [✖️ Tutup]
 *
 * @param {number} page
 * @param {object} [options]
 * @param {number} [options.commandsPerRow]  default 3
 * @param {boolean} [options.includeCommands] default true on category pages
 * @returns {{inline_keyboard: Array<Array<object>>}}
 */
function buildKeyboard(page, options = {}) {
  const index = normalizePage(page);
  const rows = [];

  // Main menu: navigation only. No command buttons, no icons (Bot API docs:
  // a button needs `text` plus exactly one action field; `style` is optional).
  if (index === 0) {
    SECTIONS.forEach((entry, position) => {
      rows.push([
        {
          text: entry.title.replace(/^\S+\s*/, "").slice(0, MAX_BUTTON_TEXT),
          callback_data: cb(CALLBACK.CAT + entry.key),
          style: position === 0 ? "primary" : undefined,
        },
      ]);
    });
    rows.push([{ text: "Tutup", callback_data: cb(CALLBACK.CLOSE), style: "danger" }]);
    return { inline_keyboard: cleanRows(rows) };
  }

  // Category page: one nav row back to the menu, plus the page stepper.
  const prev = index === 0 ? PAGE_COUNT - 1 : index - 1;
  const next = index === PAGE_COUNT - 1 ? 0 : index + 1;
  rows.push([
    { text: "Menu Utama", callback_data: cb(CALLBACK.MAIN), style: "primary" },
    { text: "Tutup", callback_data: cb(CALLBACK.CLOSE), style: "danger" },
  ]);
  if (PAGE_COUNT > 2) {
    rows.push([
      { text: "Sebelumnya", callback_data: cb(CALLBACK.PAGE + prev) },
      { text: "Berikutnya", callback_data: cb(CALLBACK.PAGE + next) },
    ]);
  }
  void options;
  return { inline_keyboard: cleanRows(rows) };
}

/** Drop `undefined` fields so the payload matches the documented shape. */
function cleanRows(rows) {
  return rows
    .map((row) =>
      row
        .filter(Boolean)
        .map((item) => {
          const out = { text: String(item.text).slice(0, MAX_BUTTON_TEXT) };
          for (const [key, value] of Object.entries(item)) {
            if (key === "text" || value === undefined || value === null) continue;
            out[key] = value;
          }
          return out;
        }),
    )
    .filter((row) => row.length);
}

/* ------------------------------------------------------------------ *
 * Rich Message blocks (Bot API 10.3)                                  *
 * ------------------------------------------------------------------ */
/**
 * Convert an `InlineKeyboardMarkup` into `RichBlockButtons` rows.
 *
 * Rich Message buttons accept `callback_data`/`url`/`copy_text`/`web_app`/
 * `login_url`/`switch_inline_query*` — the same union as an inline keyboard —
 * so one keyboard definition drives both transports.
 *
 * @param {{inline_keyboard: Array<Array<object>>}} keyboard
 * @returns {Array<object>} one `buttons` block per row
 */
function keyboardToRichButtons(keyboard) {
  const rows = (keyboard && keyboard.inline_keyboard) || [];
  const out = [];
  for (const row of rows) {
    const buttons = [];
    for (const item of row || []) {
      if (!item || !item.text) continue;
      const richButton = { text: String(item.text) };
      if (item.callback_data) richButton.callback_data = String(item.callback_data);
      else if (item.url) richButton.url = String(item.url);
      else if (item.copy_text) {
        richButton.copy_text =
          typeof item.copy_text === "string" ? { text: item.copy_text } : item.copy_text;
      } else if (item.switch_inline_query_current_chat !== undefined) {
        richButton.switch_inline_query_current_chat = String(item.switch_inline_query_current_chat);
      } else continue;
      if (item.style) richButton.style = String(item.style);
      buttons.push(richButton);
    }
    if (buttons.length) out.push({ type: "buttons", buttons });
  }
  return out;
}

/**
 * Buttons as `<tg-button-row>` markup (Rich HTML).
 *
 * The row syntax is documented in the Rich HTML style section; `style` accepts
 * `primary` / `success` / `danger` / `link`. One row per keyboard row keeps the
 * layout identical to the native `InlineKeyboardMarkup`.
 */
function buttonRowsHtml(keyboard) {
  const rows = (keyboard && keyboard.inline_keyboard) || [];
  return rows
    .map((row) => {
      const buttons = row
        .filter((item) => item && item.text)
        .map((item) => {
          const style = item.style ? ` style="${escAttr(item.style)}"` : "";
          if (item.callback_data) {
            return `<tg-button type="callback_data" data="${escAttr(item.callback_data)}"${style}>${esc(item.text)}</tg-button>`;
          }
          if (item.url) {
            return `<tg-button type="url" url="${escAttr(item.url)}"${style}>${esc(item.text)}</tg-button>`;
          }
          const copy = item.copy_text && (item.copy_text.text || item.copy_text);
          if (copy) {
            return `<tg-button type="copy_text" text="${escAttr(copy)}"${style}>${esc(item.text)}</tg-button>`;
          }
          return "";
        })
        .filter(Boolean)
        .join("");
      return buttons ? `<tg-button-row>${buttons}</tg-button-row>` : "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * Full page as **Rich HTML** — the only transport that accepts `<details>`,
 * `<summary>`, `<table>` and `<tg-button-row>` (verified against the Bot API:
 * the `parse_mode: "HTML"` parser rejects them).
 *
 * @param {number} page
 * @param {object} [options] `{ botUsername }`
 * @returns {string} HTML for `rich_message.html`
 */
function renderRichHtml(page, options = {}) {
  const index = normalizePage(page);
  const body = index === 0 ? mainMenuHtml(options) : categoryHtml(index, options);
  const rows = buttonRowsHtml(buildKeyboard(index));
  return `${body}${rows}`;
}

/**
 * Build the same page as Rich Message blocks (plus HTML fallback).
 *
 * Used for `sendRichMessage` / `editMessageText` with `rich_message`, so the
 * structured formatting (heading, compact table, expandable quote) is preserved
 * instead of being flattened into `parse_mode: "HTML"` text.
 *
 * @param {number} page
 * @param {object} [options]  `{ botUsername }`
 * @returns {{blocks: Array, html: string}}
 */
function renderPageBlocks(page, options = {}) {
  const index = normalizePage(page);
  const section = sectionForPage(index);
  const html = renderPageHtml(index, options);
  const via = options.botUsername
    ? `via @${String(options.botUsername).replace(/^@/, "")}`
    : "";
  const blocks = [];

  if (!section) {
    blocks.push(
      { type: "heading", text: IDENTITY.name, size: 1 },
      {
        type: "details",
        summary: "Information",
        is_open: true,
        blocks: IDENTITY.rows.map((row) => ({
          type: "paragraph",
          text: [
            `${row.label}: `,
            row.text || "",
            row.code ? " " : "",
            ...(row.code ? [{ type: "code", text: row.code }] : []),
          ].filter((part) => part !== ""),
        })),
      },
      {
        type: "details",
        summary: "Kategori & Commands",
        blocks: SECTIONS.map((entry) => ({
          type: "paragraph",
          text: [
            `${entry.title.replace(/^\S+\s*/, "")} — `,
            { type: "code", text: String(entry.items.length) },
          ],
        })),
      },
      {
        type: "details",
        summary: "</>",
        blocks: [{ type: "paragraph", text: IDENTITY.beta }],
        ...(via ? { credit: via } : {}),
      },
    );
    blocks.push(...keyboardToRichButtons(buildKeyboard(0)));
    return { blocks, html };
  }

  blocks.push(
    { type: "heading", text: section.title.replace(/^\S+\s*/, ""), size: 1 },
    {
      type: "details",
      summary: `Command (${section.items.length})`,
      is_open: true,
      blocks: section.items.map(([, command, description]) => ({
        type: "paragraph",
        text: [{ type: "code", text: commandBase(command) }, ` — ${description}`],
      })),
    },
    { type: "footer", text: via ? `${FOOTER} · ${via}` : FOOTER },
  );
  // Native Rich Buttons live *inside* the message (RichBlockButtons), so the
  // menu is fully operable without any native reply_markup.
  blocks.push(...keyboardToRichButtons(buildKeyboard(index)));
  return { blocks, html };
}

/**
 * Stable id for one catalogue entry.
 *
 * The base command is not unique (`.bcall (reply)` and `.bcall <teks>` share
 * `.bcall`), so the index in `allItems()` is the id — it stays inside the
 * 64-byte `callback_data` limit and always resolves to exactly one entry.
 */
function featureId(item) {
  if (!item) return "";
  // `allItems()` builds fresh objects, so compare by content, not identity.
  const index = allItems().findIndex(
    (entry) => entry.section === item.section && entry.command === item.command,
  );
  return index >= 0 ? String(index) : "";
}

/**
 * Look up one catalogue entry.
 * @param {string|number} id  `featureId()` value, or a base command (`".ytmp4"`)
 */
function findItem(id) {
  const items = allItems();
  const raw = String(id == null ? "" : id).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const index = Number(raw);
    return index >= 0 && index < items.length ? items[index] : null;
  }
  const needle = raw.toLowerCase();
  return items.find((item) => item.base.toLowerCase() === needle) || null;
}

/** True when a catalogue entry needs an argument (`<…>` / `[…]` in its format). */
function needsArgument(item) {
  return Boolean(item && /[<\[]/.test(item.command));
}

/**
 * Feature detail page (no command typing: every action is a button).
 *
 * Layout:
 *   heading + short description
 *   format (as inline code) + "butuh argumen" hint
 *   [▶️ Jalankan] [✍️ Isi argumen]      ← callback buttons
 *   [⬅️ Kembali] [🏠 Menu Utama]
 *
 * @param {string} name  base command (`".ytmp4"`)
 * @param {object} [options] `{ botUsername }`
 * @returns {{html: string, blocks: Array, keyboard: object} | null}
 */
function renderFeature(name, options = {}) {
  const item = findItem(name);
  if (!item) return null;
  const section = SECTIONS.find((entry) => entry.key === item.section);
  const page = section ? SECTIONS.indexOf(section) + 1 : 0;
  const args = needsArgument(item);
  const access = item.access || featureAccess(item.base);
  const locked = access !== "public";
  const via = options.botUsername ? `via @${String(options.botUsername).replace(/^@/, "")}` : "";

  const notes = [
    args
      ? "Ganti bagian &lt;…&gt; dengan nilai Anda, lalu jalankan lewat tombol."
      : "Tidak butuh argumen.",
    locked
      ? "Fitur ini mengubah akun atau memakai kredensial pemilik, jadi hanya owner yang dapat menjalankannya."
      : "Terbuka untuk semua pengguna.",
  ].join(" ");

  // Rich HTML: `<details>`/`<summary>` keep the long part collapsible.
  const html = [
    `<h2>${esc(item.base)}</h2>`,
    `<p>${esc(item.description)}</p>`,
    `<details><summary>Detail</summary>`,
    `<p>Format: <code>${esc(item.command)}</code></p>`,
    `<p>Kategori: ${esc(section ? section.title.replace(/^\S+\s*/, "") : "-")}</p>`,
    `<p>${notes}</p>`,
    via ? `<p>${esc(via)}</p>` : "",
    `</details>`,
  ].filter(Boolean).join("");

  // Text-only fallback: `<details>` is not available under parse_mode HTML.
  const fallback = truncateHtml(
    [
      `<b>${esc(item.base)}</b>`,
      "",
      esc(item.description),
      "",
      `<b>Format</b>\n<code>${esc(item.command)}</code>`,
      "",
      `<blockquote expandable>${esc(notes)}</blockquote>`,
      via ? `<i>${esc(via)}</i>` : "",
    ].filter(Boolean).join("\n"),
  );

  // A locked feature offers no run button: tapping it would only be refused.
  // A command with an argument cannot run from a button, so it copies the format.
  const actionRow = locked
    ? [{ text: "Khusus owner", callback_data: cb(CALLBACK.LOCKED), style: "danger" }]
    : args
      ? [{ text: "Salin format", copy_text: { text: item.command }, style: "primary" }]
      : [
          { text: "Jalankan", callback_data: cb(CALLBACK.CMD + item.base), style: "success" },
          { text: "Salin", copy_text: { text: item.base }, style: "primary" },
        ];

  const keyboard = {
    inline_keyboard: cleanRows([
      actionRow,
      [
        { text: "Kembali", callback_data: cb(CALLBACK.PAGE + page) },
        { text: "Menu Utama", callback_data: cb(CALLBACK.MAIN), style: "primary" },
      ],
    ]),
  };

  const blocks = [
    { type: "heading", text: item.base, size: 2 },
    { type: "paragraph", text: item.description },
    { type: "pre", text: item.command, language: "" },
    {
      type: "expandable_blockquote",
      text: notes,
      ...(via ? { credit: via } : {}),
    },
    { type: "buttons", buttons: actionRow },
    {
      type: "buttons",
      buttons: [
        { text: "Kembali", callback_data: cb(CALLBACK.PAGE + page) },
        { text: "Menu Utama", callback_data: cb(CALLBACK.MAIN), style: "primary" },
      ],
    },
  ];

  return { html, fallback, blocks, keyboard, item, page, id: featureId(item), access, locked };
}

/** Full render: text + keyboard for one page (what both transports send). */
function renderPage(page, options = {}) {
  const index = normalizePage(page);
  return { text: renderPageHtml(index, options), keyboard: buildKeyboard(index, options) };
}

/* ------------------------------------------------------------------ *
 * Command lookup                                                      *
 * ------------------------------------------------------------------ */
/**
 * Access policy for one feature.
 * Delegates to `permissions.js` so a button and a typed command can never
 * disagree about who may run a feature.
 */
function featureAccess(name) {
  try {
    const permissions = require("./permissions");
    return permissions.accessLevel(String(name || "").toLowerCase());
  } catch {
    return "owner";
  }
}

/** Flat list of every catalogue entry with its section. */
function allItems() {
  const out = [];
  for (const section of SECTIONS) {
    for (const [icon, command, description] of section.items) {
      const base = commandBase(command);
      out.push({
        section: section.key,
        icon,
        command,
        base,
        description,
        access: featureAccess(base),
      });
    }
  }
  return out;
}

/** Find a catalogue entry by command name (`".ytmp4"`). */
function findCommand(name) {
  const needle = String(name == null ? "" : name).trim().toLowerCase();
  if (!needle) return null;
  return (
    allItems().find((item) => item.base.toLowerCase() === needle) ||
    allItems().find((item) => item.command.toLowerCase().startsWith(needle)) ||
    null
  );
}

/** True when `name` is a known command (guards callback payloads). */
function isKnownCommand(name) {
  return Boolean(findCommand(name));
}

/** Plain-text rendering of a page (logs, notifications, MTProto fallback). */
function renderPageText(page, options = {}) {
  const html = renderPageHtml(page, options);
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Keys/labels for a compact `@bot` shortcut list. */
function categoryButtons() {
  return SECTIONS.map((section, index) => ({
    label: section.title,
    page: index + 1,
    callback: CALLBACK.CAT + section.key,
    key: section.key,
  }));
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  MAX_CALLBACK_BYTES,
  MAX_BUTTON_TEXT,
  SECTIONS,
  IDENTITY,
  mainMenuHtml,
  mainMenuFallbackHtml,
  categoryHtml,
  buttonRowsHtml,
  renderRichHtml,
  TOTAL_COMMANDS,
  PAGE_COUNT,
  DIVIDER,
  FOOTER,
  CALLBACK,
  esc,
  escAttr,
  code,
  bold,
  commandBase,
  truncateHtml,
  cb,
  parseCallback,
  sectionForPage,
  normalizePage,
  renderPageHtml,
  renderPageText,
  renderPage,
  renderPageBlocks,
  buildKeyboard,
  keyboardToRichButtons,
  renderFeature,
  featureId,
  findItem,
  needsArgument,
  allItems,
  findCommand,
  isKnownCommand,
  categoryButtons,
};

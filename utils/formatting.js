"use strict";
/**
 * Centralized Rich Message design system for every bot response.
 *
 * All handler text is plain, unstyled content; this module is responsible for
 * turning it into a consistent, modern, professional Telegram layout. Handlers
 * therefore never hard-code markup syntax — they pass structure and this file
 * decides the presentation.
 *
 * Rendering
 * ---------
 * Messages are described once as a list of Rich Message blocks
 * (Bot API 10.3 — https://core.telegram.org/bots/api#rich-messages) and then
 * rendered for the transport that is actually available:
 *
 *   1. `renderMarkdown()` / `renderHtml()` — the Rich Message payload
 *      (`markdown` / `html` / `blocks`) consumed by `sendRichMessage`.
 *   2. `renderLegacy()` — the `parse_mode: "html"` subset understood by
 *      GramJS `sendMessage`, used by the userbot account.
 *
 * Buttons are *Rich Message* buttons (`RichMessageButton` / `RichTextButton`)
 * and always stay inside the message text. They are never converted into an
 * `InlineKeyboardButton`.
 */
const rich = require("./rich_message");

const { text, block, richButton, isRichMessage, buildRichMessage } = rich;

/** `parse_mode` used by the legacy (GramJS) transport. */
const PARSE_MODE = "html";

/** Maximum characters Telegram accepts in one message. */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Rich Message transport.
 *
 * The userbot runs on an MTProto *user* session, which cannot call the Bot API
 * `sendRichMessage` method. Rich content is therefore rendered down to the
 * `html` subset GramJS understands. Set `USERBOT_RICH_TRANSPORT=bot` (with a
 * `TELEGRAM_BOT_TOKEN`) to deliver the full `blocks`/`markdown` payload through
 * the Bot API instead.
 */
const RICH_TRANSPORT = (process.env.USERBOT_RICH_TRANSPORT || "userbot").toLowerCase();

/* ------------------------------------------------------------------ *
 * Escaping                                                            *
 * ------------------------------------------------------------------ */
const HTML_ESCAPES = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
];
// Character replacements applied when the raw text contains characters that
// are awkward to render (kept visually similar, mirrored from the old
// Markdown-neutralising behaviour so existing output stays readable).
const NEUTRAL_MAP = [
  ["`", "ˋ"],
  ["\u0000", ""],
];

/**
 * Flatten any RichText / Rich Message / array value into plain text.
 *
 * This is the single place that decides how a structured value becomes a
 * string. Falling back to `String(value)` is what used to leak
 * `[object Object]` into Telegram whenever a handler passed a Rich Message
 * object (or a RichText array) where plain text was expected.
 */
function richToPlain(value, depth = 0) {
  if (value == null || value === false || value === true) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (depth > 32) return "";
  if (Array.isArray(value)) {
    return value.map((part) => richToPlain(part, depth + 1)).join("");
  }
  if (typeof value !== "object") return "";

  // Rich Message wrapper → prefer the already rendered payloads.
  if (value.__rich === true) {
    for (const key of ["legacy", "text", "html", "markdown"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate) return candidate;
    }
    if (Array.isArray(value.blocks)) {
      return value.blocks
        .map((block) => richToPlain(block, depth + 1))
        .filter(Boolean)
        .join("\n\n");
    }
    return "";
  }

  // RichText node / Rich Block node: render its text payload.
  if (value.__raw !== undefined) return richToPlain(value.__raw, depth + 1);
  if (value.text !== undefined) return richToPlain(value.text, depth + 1);
  if (value.expression !== undefined) return String(value.expression);
  if (value.items !== undefined) return richToPlain(value.items, depth + 1);
  if (value.blocks !== undefined) return richToPlain(value.blocks, depth + 1);

  // Last resort: never emit "[object Object]".
  return "";
}

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return richToPlain(value);
}

/**
 * Escape untrusted dynamic text for safe HTML rendering.
 * This is the only function handlers should use for user/API data.
 */
function escapeMarkdown(value) {
  let out = toText(value);
  for (const [from, to] of NEUTRAL_MAP) out = out.split(from).join(to);
  for (const [from, to] of HTML_ESCAPES) out = out.split(from).join(to);
  return out;
}

/**
 * Escape text for HTML **without** destroying markup the caller wrote.
 *
 * Handlers legitimately pass pre-rendered markup such as
 * `statusMessage(\`Mencari ${inlineCode(query)}\`)`. Escaping the whole string
 * turned `<code>` into the literal text `&lt;code&gt;`, which is exactly the
 * "raw tag shown to the user" bug. So:
 *
 *   - `normalizeLegacy` already escapes the *data* and keeps/creates real tags,
 *     so anything that already contains a supported tag passes through it;
 *   - a plain string is escaped once (data), then promoted to Rich structure.
 *
 * Double-escaping is also prevented: an already-escaped entity (`&lt;`) is
 * never escaped again.
 */
function safeMarkup(value) {
  const raw = toText(value);
  if (!raw) return "";
  // Supported tags the Bot API parses; everything else is data.
  const TAG = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|tg-spoiler|span)(\s[^>]*)?>/gi;
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(TAG)) {
    out += escapeData(raw.slice(last, match.index));
    out += match[0]; // author markup survives untouched
    last = match.index + match[0].length;
  }
  out += escapeData(raw.slice(last));
  return out;
}

/**
 * Escape data for HTML, leaving existing entities intact.
 * `&lt;` must not become `&amp;lt;` (that is what double escaping looked like).
 */
function escapeData(value) {
  return String(value)
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline code span, e.g. `720p`. */
function inlineCode(value) {
  return `<code>${escapeMarkdown(value)}</code>`;
}

/** A monospace block. */
function codeBlock(value, language = "") {
  const content = toText(value);
  return language
    ? `<pre><code class="language-${escapeMarkdown(language)}">${escapeMarkdown(content)}</code></pre>`
    : `<pre>${escapeMarkdown(content)}</pre>`;
}

/** A real clickable inline link. */
function markdownLink(label, url) {
  const safeUrl = toText(url).replace(/[\n\r]/g, "");
  if (!safeUrl) return escapeMarkdown(label);
  return `<a href="${escapeMarkdown(safeUrl)}">${escapeMarkdown(label)}</a>`;
}

/** Underlined text, used for section labels. */
function underline(value) {
  return `<u>${escapeMarkdown(value)}</u>`;
}

/** Collapsible spoiler text. */
function spoiler(value) {
  return `<tg-spoiler>${escapeMarkdown(value)}</tg-spoiler>`;
}

/* ------------------------------------------------------------------ *
 * Design tokens                                                       *
 * ------------------------------------------------------------------ */
const SEP = "┈".repeat(12);
/** Thin separator line between a header and its body. */
const divider = () => SEP;

/** Lower-case a string without locale surprises for the rich-text detector. */
function hasRichSyntax(value) {
  return /<(b|strong|i|em|u|s|del|code|pre|a|blockquote|tg-spoiler)[\s>]/i.test(toText(value));
}

/**
 * Translate the legacy Markdown subset (`**bold**`, `__italic__`, `` `code` ``,
 * `[label](url)`, `> quote`) that older handlers still emit into real HTML
 * entities. Text that already contains HTML tags is returned untouched so
 * handlers can mix both styles safely.
 */
function normalizeLegacy(value) {
  let out = toText(value);
  // Text that already contains supported markup is passed through: escaping it
  // would turn `<code>` into literal text. Its *data* was escaped by whoever
  // built the markup (inlineCode, safeMarkup, …).
  if (hasRichSyntax(out)) return out;
  // Code spans first so bold markers inside them are preserved literally.
  const protectedBits = [];
  out = out.replace(/`([^`\n]+)`/g, (_, inner) => {
    protectedBits.push(`<code>${escapeMarkdown(inner)}</code>`);
    return `\u0001${protectedBits.length - 1}\u0001`;
  });
  out = escapeMarkdown(out);
  // Real links: [label](url) -> <a href>.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => markdownLink(label, url));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  out = out.replace(/__([^_\n]+)__/g, "<u>$1</u>");
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  out = out.replace(/^>\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  // Restore protected code spans.
  out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => protectedBits[Number(i)] || "");
  return out;
}

/** Render one detail row, supporting both HTML and legacy Markdown input. */
function renderDetail(item) {
  return normalizeLegacy(item);
}

/* ------------------------------------------------------------------ *
 * Buttons                                                             *
 * ------------------------------------------------------------------ */

/**
 * A button that stays *inside* the text (`RichTextButton`).
 *
 * @param {string} label
 * @param {object} payload   e.g. `{ button: 'menu_1' }`, `{ url: '…' }`,
 *                           `{ copy_text: '…' }`, `{ callback_data: '…' }`.
 * @param {string} [style]   “primary” | “success” | “danger” | “link”.
 */
function button(label, payload, style) {
  return richButton(label, payload, style);
}

/** Wrap a RichMessageButton as a RichTextButton for inline placement. */
function inlineButton(value) {
  return text.button(value);
}

/** A paragraph of RichText, used for `text.example(...)`-style lines. */
function paragraph(...parts) {
  return block.paragraph(...parts);
}

/** One row of Rich Message buttons (`RichBlockButtons`). */
function buttonRow(buttons, options) {
  return block.buttons(buttons, options);
}

/**
 * A copy-to-clipboard button carrying a command, styled “link”.
 * Used next to usage hints so the command stays inside the message text.
 */
function copyButton(label, value, style = "link") {
  return richButton(label, { copy_text: String(value) }, style);
}

/**
 * The canonical inline-button paragraph — exactly the documented shape:
 *
 *   block.paragraph(
 *     text.example(
 *       'EXAMPLE 1: ',
 *       text.button(richButton('contoh', { button: 'menu_1' }, 'primary'))
 *     )
 *   )
 *
 * Every RichTextButton in this project is produced through this helper (or the
 * literal form above), so inline buttons always live inside a paragraph of
 * RichText and never become an `InlineKeyboardButton`.
 *
 * @param {string} prefix  Leading text, e.g. `'Contoh: '`.
 * @param {string} label   Button label.
 * @param {object} payload Button payload (`{ button }`, `{ url }`, `{ copy_text }`, …).
 * @param {string} [style] “primary” | “success” | “danger” | “link”.
 * @returns {object} RichBlockParagraph
 */
function exampleButton(prefix, label, payload, style) {
  return block.paragraph(
    text.example(asPrefix(prefix), text.button(richButton(label, payload, style))),
  );
}

/**
 * Prefix normalisation for inline-button paragraphs.
 *
 * Callers pass either plain text or already-escaped markup built with
 * `inlineCode()` / `escapeMarkdown()`. Markup is passed through as a raw
 * RichText node so it renders as real entities instead of literal `<code>`
 * text; everything else is treated as plain text and escaped by the renderer.
 */
function asPrefix(value) {
  if (value && typeof value === "object") return value;
  const raw = toText(value);
  if (/<(b|i|u|s|code|pre|a|mark|sub|sup|tg-\w+|br)\b/i.test(raw)) {
    return text.raw(raw);
  }
  return raw;
}

/**
 * Same as `exampleButton`, for a button value that was already built with
 * `richButton(...)`.
 */
function exampleWithButton(prefix, button) {
  return block.paragraph(text.example(asPrefix(prefix), text.button(button)));
}

/**
 * A paragraph that mixes text with one or more inline RichTextButtons:
 *
 *   block.paragraph(
 *     text.example('Pilih: ', text.button(richButton('A', { button: 'a' }, 'primary')))
 *   )
 */
function buttonParagraph(...parts) {
  return block.paragraph(text.example(...parts));
}

/**
 * A `Label: value` field whose value can be copied.
 *
 * Renders the documented inline-button shape:
 *   rich   -> `Label: ` + RichTextButton(copy_text = value)
 *   legacy -> `Label: ` + `<code>value</code>` (tap-to-select)
 *
 * The value is therefore never printed twice on the MTProto transport.
 *
 * @param {string} label        Field label, e.g. `"Nama file"`.
 * @param {string} value        Value to copy.
 * @param {string} [style]      Button style in the Rich Message payload.
 */
function copyField(label, value, style = "primary") {
  const text_ = String(value == null ? "" : value);
  return block.paragraph(
    text.example(
      text.raw(`${escapeMarkdown(label)}: `),
      text.button(richButton("Salin", { copy_text: text_ }, style)),
    ),
  );
}

/** A detail row that ends with an inline Rich Message button. */
function detailWithButton(content, button) {
  return text.join(content, " ", text.button(button));
}

/**
 * Closing footer block (`RichBlockFooter`).
 * Messages produced by this design system end with `block.footer(FOOTER)`.
 */
function footerBlock(...parts) {
  return block.footer(text.join(...parts));
}

/** Default footer text used across the bot. */
const FOOTER = "Telegram Userbot · Rich Message";

/* ------------------------------------------------------------------ *
 * Block builder                                                       *
 * ------------------------------------------------------------------ */

/**
 * Convert the design-system options into a list of Rich Message blocks.
 * This is the single source of truth for every renderer.
 */
function messageBlocks(options = {}) {
  const {
    title,
    subtitle,
    body,
    details,
    example,
    note,
    footer,
    compact = false,
    sections,
    buttons,
    buttonRows,
    table,
    quote,
    expandableQuote,
    document,
    blocks: extraBlocks,
  } = options;

  const blocks = [];

  if (title) {
    // Titles are frequently external data (video titles, catalogue items), so
    // they are escaped: a raw `&` or `<` would break parse_mode HTML.
    blocks.push(block.paragraph(text.raw(`<b>${escapeMarkdown(title)}</b>`)));
    if (!compact) blocks.push(block.paragraph(divider()));
  }

  if (subtitle) blocks.push(block.paragraph(text.raw(escapeMarkdown(subtitle))));

  const bodyLines = Array.isArray(body) ? body : body ? [body] : [];
  for (const line of bodyLines) {
    if (toText(line).trim()) blocks.push(block.paragraph(richPart(line)));
  }

  if (details && details.length) {
    const items = details.filter((item) =>
      item && typeof item === "object" ? true : toText(item).trim(),
    );
    if (items.length) {
      const parts = [];
      items.forEach((item, index) => {
        if (index) parts.push("\n");
        parts.push("▸ ");
        parts.push(richPart(item));
      });
      blocks.push(block.paragraph(...parts));
    }
  }

  if (example) {
    blocks.push(block.paragraph(text.raw(underline("Penggunaan"))));
    // Always the documented inline-button shape:
    //   block.paragraph(text.example(prefix, text.button(richButton(...))))
    // A plain string becomes an inline-code hint plus a copy button; RichText
    // input (e.g. `text.example('EXAMPLE: ', text.button(...))`) passes through.
    if (typeof example === "string") {
      blocks.push(
        block.paragraph(
          text.example(
            text.raw(inlineCode(example)),
            text.button(copyButton("Salin", example)),
          ),
        ),
      );
    } else {
      blocks.push(block.paragraph(text.example(...asParts(example))));
    }
  }

  // A table renders as `<table>` in rich HTML and as an aligned `<pre>` block
  // in the parse_mode fallback (see `renderTableLegacy`).
  if (table) blocks.push(block.table(normalizeTable(table)));
  if (quote) blocks.push(block.blockquote(...asParts(quote)));
  if (expandableQuote) blocks.push(block.expandableBlockquote(...asParts(expandableQuote)));
  if (document) blocks.push(block.document(document.url, document));

  const noteLines = Array.isArray(note) ? note : note ? [note] : [];
  for (const line of noteLines) {
    if (!toText(line).trim()) continue;
    blocks.push(block.blockquote(text.raw(normalizeLegacy(line))));
  }

  // Extra sections keep multi-card messages in a single Rich Message.
  for (const section of sections || []) {
    blocks.push(...messageBlocks({ ...section, compact: false }));
  }

  // Pre-built blocks (typically `block.paragraph(text.example(...))` lines that
  // carry inline RichTextButtons).
  for (const extra of extraBlocks || []) {
    if (extra) blocks.push(extra);
  }

  // Inline RichTextButton rows (documented `text.example(...)` shape).
  for (const row of buttonRows || []) blocks.push(block.buttons(row));
  if (buttons && buttons.length) blocks.push(block.buttons(buttons));

  // RichBlockFooter (`<footer>`) always closes the message.
  if (footer) blocks.push(block.footer(text.raw(escapeMarkdown(footer))));

  return blocks;
}

/* ------------------------------------------------------------------ *
 * Table pipeline                                                      *
 * ------------------------------------------------------------------ */
/**
 * One table definition, two renderings.
 *
 * `<table>` is a **Rich HTML** tag: the `parse_mode: "HTML"` parser rejects it
 * ("Unsupported start tag table", verified live). So a table is rendered as:
 *
 *   rich     `<table><tr><th>…</th></tr>…</table>` inside `rich_message.html`
 *   legacy   aligned plain text, padded by display width, inside `<pre>`
 *
 * Callers pass `{ headers, rows, caption }` and get both; `messageBlocks`
 * already routes `options.table` through this, so every handler that passes a
 * table gets the rich table and a readable fallback automatically.
 *
 * @param {object} table
 * @param {string[]} [table.headers]
 * @param {Array<Array<string|object>>} [table.rows]
 * @param {string} [table.caption]
 * @returns {{cells: Array<Array<object>>, headers: string[], rows: string[][], caption?: string}}
 */
function normalizeTable(table = {}) {
  const headers = (table.headers || []).map((value) => toText(value));
  const rows = (table.rows || []).map((row) => (row || []).map((value) => toText(value)));
  const cells = [];
  if (headers.length) cells.push(headers.map((text) => ({ text, is_header: true })));
  for (const row of rows) cells.push(row.map((text) => ({ text })));
  return { cells, headers, rows, caption: table.caption ? toText(table.caption) : undefined };
}

/** Visible width: emoji and CJK count as two columns. */
function displayWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x1fa70 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Pad to `width` display columns. */
function padTo(value, width) {
  const text = String(value);
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Plain-text table for the `parse_mode: "HTML"` transport.
 * Wrapped in `<pre>` so the columns stay aligned in every client.
 */
function renderTableLegacy(table, options = {}) {
  const { headers, rows, caption } = normalizeTable(table);
  if (!headers.length && !rows.length) return "";
  const columns = Math.max(headers.length, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(
      displayWidth(headers[index] || ""),
      ...rows.map((row) => displayWidth(row[index] || "")),
      1,
    ),
  );
  const line = (values, bold) =>
    values
      .map((value, index) => {
        const padded = padTo(value || "", widths[index]);
        return bold ? `<b>${padded}</b>` : padded;
      })
      .join(" │ ")
      .replace(/\s+$/, "");
  const body = [];
  if (headers.length) body.push(line(headers, true));
  body.push(widths.map((width) => "─".repeat(width)).join("─┼─"));
  for (const row of rows) body.push(line(row, false));
  const text = body.join("\n");
  const note = caption ? `\n<i>${escapeMarkdown(caption)}</i>` : "";
  void options;
  return `<pre>${escapeMarkdown(text)}</pre>${note}`;
}

/** Accept a string, RichText node, or array of either. */
function asParts(value) {
  if (Array.isArray(value)) return value.map(richPart);
  return [richPart(value)];
}

/**
 * One `details`/`body` line → RichText.
 *
 * Data is escaped; author markup (`<b>`, `<code>`, `**bold**`) is preserved.
 * It must **not** become `text.raw()` for plain data: `__raw` bypasses escaping
 * entirely, which is how unescaped `&`/`<` reached Telegram and broke parsing.
 * `safeMarkup()` keeps real tags and escapes everything else, so the result is
 * already valid HTML and can safely be emitted as-is.
 */
function richPart(value) {
  if (Array.isArray(value)) return text.join(...value.map(richPart));
  if (value && typeof value === "object") return value;
  return text.raw(safeMarkup(value));
}

/* ------------------------------------------------------------------ *
 * Core builder                                                        *
 * ------------------------------------------------------------------ */

/**
 * Build one consistent Rich Message response (legacy HTML string).
 *
 * @param {object} options
 * @param {string} [options.title]    Header, rendered bold and large.
 * @param {string} [options.subtitle] Optional one-line context under the header.
 * @param {string|string[]} [options.body]    Free-form paragraph(s).
 * @param {string[]} [options.details]  Bulleted key/value rows.
 * @param {string|object} [options.example] Usage hint (plain or RichText).
 * @param {string|string[]} [options.note]    Footnote, rendered as a blockquote.
 * @param {string} [options.footer]     Dim closing line.
 * @param {boolean} [options.compact]   Skip the separator below the header.
 * @param {Array} [options.buttons]     RichMessageButton row (RichBlockButtons).
 * @param {Array<Array>} [options.buttonRows] Several button rows.
 * @param {object} [options.table]      RichBlockTable definition.
 * @param {Array} [options.quote]       RichBlockBlockQuotation content.
 * @param {Array} [options.expandableQuote] RichBlockExpandableBlockQuotation.
 * @param {object} [options.document]   RichBlockDocument (`{url, caption}`).
 * @returns {string}
 */
function formatMessage(options = {}) {
  return truncateMessage(rich.renderLegacy(messageBlocks(options)));
}

/**
 * Same options as `formatMessage`, but returns a full Rich Message object
 * carrying the `blocks` / `markdown` / `html` payloads next to the legacy
 * rendering. Handlers that embed buttons should use this.
 */
function formatRichMessage(options = {}) {
  const blocks = messageBlocks(options);
  const message = buildRichMessage(blocks);
  message.text = truncateMessage(message.legacy);
  message.blocks = message.blocks;
  return message;
}

/**
 * Keep a message inside Telegram's limit without cutting a block mid-way.
 *
 * Cuts on a tag boundary and re-opens the tags that were still open, so the
 * `parse_mode: "html"` payload never ends with a dangling `<b>` / `<tg-button>`.
 */
function truncateMessage(value, limit = MAX_MESSAGE_LENGTH) {
  const out = toText(value);
  if (out.length <= limit) return out;

  const notice = "\n<i>… pesan dipotong karena batas Telegram.</i>";
  let budget = Math.max(0, limit - notice.length);

  // Two passes: the first cut may leave tags open, whose closing tags consume
  // part of the budget, so shrink and retry once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let cut = out.slice(0, budget);
    // Drop a partially written tag / entity at the very end.
    cut = cut.replace(/<[^>]*$/, "").replace(/&[a-zA-Z#0-9]*$/, "");

    // Re-close any tags left open by the cut.
    const open = [];
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
    let match;
    while ((match = tagRe.exec(cut))) {
      const [, closing, name, , selfClosing] = match;
      const tag = name.toLowerCase();
      if (SELF_CLOSING_TAGS.has(tag) || selfClosing) continue;
      if (closing) {
        const index = open.lastIndexOf(tag);
        if (index !== -1) open.splice(index, 1);
      } else {
        open.push(tag);
      }
    }
    const closingTags = open
      .reverse()
      .map((tag) => `</${tag}>`)
      .join("");
    const result = `${cut}${closingTags}${notice}`;
    if (result.length <= limit) return result;
    budget -= result.length - limit;
    if (budget <= 0) return notice.trim();
  }
  return out.slice(0, limit);
}

/** HTML tags that never need a closing counterpart. */
const SELF_CLOSING_TAGS = new Set(["br", "hr", "img", "input", "tg-map", "tg-button-row"]);

/* ------------------------------------------------------------------ *
 * Status / result helpers                                             *
 * ------------------------------------------------------------------ */

/** Ensure even simple status text has visible Rich structure. */
function ensureRichMarkdown(value) {
  const out = toText(value);
  if (hasRichSyntax(out)) return truncateMessage(out);
  // Plain strings are promoted to a bold title; author-supplied legacy Markdown
  // (`**bold**`, `` `code` ``, links) is upgraded so nothing renders literally.
  if (/\*\*|`|\]\(|^>\s/m.test(out)) return truncateMessage(normalizeLegacy(out));
  return formatMessage({ title: out, compact: true });
}

/** A short progress/status line. */
function statusMessage(value, icon = "⏳") {
  // `value` may already contain markup (`inlineCode(query)`), so it goes
  // through `safeMarkup` instead of a blanket escape.
  return truncateMessage(`${icon} <b>${safeMarkup(value)}</b>`);
}

/** A success line. */
function successMessage(value = "Selesai") {
  return truncateMessage(`✅ <b>${safeMarkup(value)}</b>`);
}

/**
 * Consistent rate-limit / flood-wait card.
 *
 * Telegram returns `FLOOD_WAIT_<seconds>`; the wait is shown explicitly, both
 * as a duration and as a ready-to-copy reminder, using Rich Message blocks.
 *
 * @param {number|string} seconds      Wait time in seconds.
 * @param {object} [options]
 * @param {string} [options.action]    What was throttled (e.g. `.telesearch`).
 * @param {string} [options.footer]
 * @returns {object} Rich Message (usable with edit/respond/sendFile)
 */
function rateLimitMessage(seconds, options = {}) {
  const wait = Math.max(0, Math.trunc(Number(seconds) || 0));
  const human =
    wait >= 3600
      ? `${Math.floor(wait / 3600)} jam ${Math.floor((wait % 3600) / 60)} menit`
      : wait >= 60
        ? `${Math.floor(wait / 60)} menit ${wait % 60} detik`
        : `${wait} detik`;

  const blocks = [
    block.paragraph(
      text.raw(`<b>⏳ Waktu tunggu:</b> <code>${wait}s</code> (${escapeMarkdown(human)})`),
    ),
    block.paragraph(
      text.raw(
        `Coba lagi setelah hitungan di atas habis. Menunggu lebih lama dari yang diminta ` +
          `tidak mempercepat pemulihan dan berisiko menambah durasi pembatasan.`,
      ),
    ),
  ];
  if (options.action) {
    blocks.push(
      block.paragraph(
        text.example(
          "Ulangi command: ",
          text.button(richButton(options.action, { copy_text: options.action }, "link")),
        ),
      ),
    );
  }

  return formatRichMessage({
    title: "🚦 Rate Limit Telegram",
    blocks,
    footer: options.footer || "Batas ini ditetapkan oleh Telegram, bukan oleh userbot.",
  });
}

/**
 * An error card.
 *
 * `options.retry` / `options.example` add a Rich Message button that keeps the
 * suggested command inside the text.
 */
function errorMessage(error, title = "Terjadi Kesalahan", options = {}) {
  const example = options.example;
  // `details` are rendered through `richPart` → `normalizeLegacy`, which
  // escapes data itself. Pre-escaping here produced `&amp;lt;` (double escape).
  return formatMessage({
    title: `❌ ${title}`,
    details: [toText(error)],
    example,
    buttons: options.buttons,
  });
}

/* ------------------------------------------------------------------ *
 * Resolve the editable `Api.Message` from either an event or a message. *
 * ------------------------------------------------------------------ */
function resolveMessage(target) {
  if (!target) return null;
  if (typeof target.edit === "function" && typeof target.delete === "function") return target;
  if (target.message && typeof target.message.edit === "function") return target.message;
  return null;
}

/** Telegram's caption limit (media messages). */
const MAX_CAPTION_LENGTH = 1024;

/** Split an outgoing payload into its legacy text and Rich Message form. */
function normalizeOutgoing(value, limit = MAX_MESSAGE_LENGTH) {
  if (isRichMessage(value)) {
    return { legacy: truncateMessage(value.legacy ?? value.text ?? "", limit), rich: value };
  }
  return { legacy: truncateMessage(ensureRichMarkdown(value), limit), rich: null };
}

/**
 * Send a Rich Message reply to whatever chat the event/message came from.
 * Mirrors Telethon's `event.reply(...)`, quoting the triggering message.
 */
async function replyMarkdown(client, event, value, kwargs = {}) {
  const { legacy, rich: richMessage } = normalizeOutgoing(value);
  const options = { ...kwargs, message: legacy, parseMode: PARSE_MODE };
  if (options.link_preview !== undefined && options.linkPreview === undefined) {
    options.linkPreview = options.link_preview;
    delete options.link_preview;
  }
  const chat = resolveChatId(event);
  if (chat == null) throw new Error("Tidak dapat menentukan tujuan balasan.");
  if (options.replyTo === undefined) {
    const mid = resolveMessageId(event);
    if (mid != null) options.replyTo = mid;
  }
  if (richMessage && RICH_TRANSPORT === "bot") {
    const sent = await sendRich(client, chat, richMessage, options);
    if (sent) return sent;
  }
  return client.sendMessage(chat, options);
}

/**
 * Bot API Rich Message *renderer*.
 *
 * The bot token is **not** used to answer commands: a bot cannot post as the
 * user account, and `sendRichMessage` only reaches chats the bot itself is in
 * (and never the userbot's own private chat). It is therefore used to build and
 * validate the Rich Message payload, while the actual reply is always delivered
 * by the userbot through GramJS so the response stays in the userbot.
 *
 * When `USERBOT_RICH_TRANSPORT=bot` is set explicitly we additionally attempt
 * the Bot API delivery first and fall back to the userbot on any failure.
 *
 * @returns {Promise<object|null>} the sent Bot API message, or `null` when the
 *          caller must fall back to the GramJS transport.
 */
async function sendRich(client, chat, richMessage, options = {}) {
  if (RICH_TRANSPORT !== "bot") return null;
  const token = rich.getBotToken();
  if (!token) return null;
  try {
    return await rich.sendRichMessage(token, {
      chat_id: String(chat),
      rich_message: {
        blocks: richMessage.blocks,
        markdown: richMessage.markdown,
        html: richMessage.html,
      },
      link_preview_options: options.linkPreview === false ? { is_disabled: true } : undefined,
      reply_parameters:
        options.replyTo != null
          ? { message_id: Number(options.replyTo), allow_sending_without_reply: true }
          : undefined,
    });
  } catch {
    // Bot API cannot reach this chat (or the payload was rejected) — the
    // userbot transport answers instead so the response never goes missing.
    return null;
  }
}

/**
 * One-off startup check of the Bot API token.
 * Reports availability without ever failing the boot.
 */
async function botApiStatus() {
  if (RICH_TRANSPORT === "off") return { enabled: false, reason: "transport off" };
  const token = rich.getBotToken();
  if (!token) return { enabled: false, reason: "token tidak tersedia" };
  const result = await rich.verifyBotToken(token);
  if (!result.ok) return { enabled: false, reason: result.reason };
  return {
    enabled: true,
    username: result.me && result.me.username,
    id: result.me && result.me.id,
    transport: RICH_TRANSPORT,
  };
}

function resolveChatId(event) {
  return (
    event?.chatId ??
    event?.message?.chatId ??
    event?.message?.peerId ??
    event?.originalUpdate?.message?.peerId ??
    event?.peerId ??
    null
  );
}

function resolveMessageId(event) {
  return event?.id ?? event?.messageId ?? event?.message?.id ?? event?.msgId ?? null;
}

/**
 * Edit with Rich formatting; error responses mark the current command failed.
 * Accepts a GramJS event (`NewMessageEvent`), an `Api.Message`, or the message
 * returned by a previous `sendMessage`.
 *
 * If editing is not possible (no editable target, or Telegram rejects the edit)
 * and the caller passed an event that carries a client reference, the text is
 * delivered as a fresh reply instead — a command must never fail silently.
 */
async function editMarkdown(message, value, kwargs = {}) {
  const { legacy, rich: richMessage } = normalizeOutgoing(value);
  // Error cards carry an explicit marker so activity logging can flag failures.
  if (/^\s*(❌|<b>❌)/.test(legacy)) {
    try {
      const { markActivityFailed } = require("./activity_logging");
      markActivityFailed(plainText(legacy));
    } catch {
      /* ignore */
    }
  }
  const target = resolveMessage(message);
  const options = { ...kwargs };
  if (options.link_preview !== undefined && options.linkPreview === undefined) {
    options.linkPreview = options.link_preview;
    delete options.link_preview;
  }
  const client = message && message.__client;
  const payload = { text: legacy, parseMode: PARSE_MODE, ...options };
  if (target) {
    try {
      return await target.edit(payload);
    } catch (err) {
      // "message not modified" is harmless and common with throttled progress edits.
      if (/not modified/i.test(err.message || "")) return undefined;
      if (!client || !isEditableFailure(err)) throw err;
    }
  }
  if (client) {
    return replyMarkdown(client, message, richMessage || legacy, options);
  }
  return undefined;
}

/** Errors that mean "use a fresh message instead of editing". */
function isEditableFailure(err) {
  const message = String((err && err.message) || err || "");
  return /MESSAGE_ID_INVALID|MESSAGE_NOT_MODIFIED|MESSAGE_TOO_OLD|can't be edited|can not be edited|not editable|MESSAGE_EDIT_TIME_EXPIRED/i.test(
    message,
  );
}

/**
 * Display a Rich response for a command.
 *
 * Preference order:
 *   1. If `placeholder` (a message previously sent by the bot) is supplied, edit
 *      it in place — this is what progress/status edits use.
 *   2. Otherwise send a new reply to the command message.
 */
async function respondMarkdown(client, event, value, kwargs = {}) {
  if (kwargs.placeholder) {
    const { placeholder, ...rest } = kwargs;
    return editMarkdown(placeholder, value, rest);
  }
  return replyMarkdown(client, event, value, kwargs);
}

/**
 * Send media while rendering its caption with the project's design system.
 * Works with GramJS `client.sendFile(entity, {file, ...})`.
 */
async function sendFileMarkdown(client, entity, file, kwargs = {}) {
  const options = { ...kwargs, file };
  if (options.caption) {
    const { legacy } = normalizeOutgoing(options.caption, MAX_CAPTION_LENGTH);
    options.caption = legacy;
  }
  options.parseMode = PARSE_MODE;
  return client.sendFile(entity, options);
}

/** Strip Rich markup down to plain text (for logs). */
function plainText(value) {
  return toText(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|blockquote|pre|footer|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

module.exports = {
  PARSE_MODE,
  MAX_MESSAGE_LENGTH,
  MAX_CAPTION_LENGTH,
  RICH_TRANSPORT,
  divider,
  escapeMarkdown,
  inlineCode,
  codeBlock,
  markdownLink,
  underline,
  spoiler,
  button,
  inlineButton,
  copyButton,
  exampleButton,
  exampleWithButton,
  copyField,
  asPrefix,
  buttonParagraph,
  footerBlock,
  FOOTER,
  detailWithButton,
  paragraph,
  buttonRow,
  richButton,
  messageBlocks,
  formatMessage,
  formatRichMessage,
  normalizeTable,
  renderTableLegacy,
  displayWidth,
  ensureRichMarkdown,
  statusMessage,
  successMessage,
  errorMessage,
  rateLimitMessage,
  resolveMessage,
  replyMarkdown,
  respondMarkdown,
  botApiStatus,
  sendRich,
  editMarkdown,
  sendFileMarkdown,
  truncateMessage,
  plainText,
  richToPlain,
  toText,
  richText: text,
  richBlock: block,
  text,
  block,
  buildRichMessage,
  isRichMessage,
};

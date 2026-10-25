"use strict";
/**
 * Telegram Bot API 10.3 — Rich Messages
 * https://core.telegram.org/bots/api#rich-messages
 *
 * This module implements the Rich Message object model so every handler can
 * describe a message once and have it rendered for every transport the userbot
 * supports:
 *
 *   RichMessageButton  (richButton)      -> a button inside a Rich Message
 *   RichTextButton     (text.button)     -> an *inline* button inside the text
 *   RichBlock*         (block.paragraph) -> paragraph / heading / table / ...
 *
 * Renderers
 * ---------
 *   renderMarkdown(blocks)  Rich Markdown / Rich HTML  -> sendRichMessage
 *   renderBlocks(blocks)    Array of InputRichBlock    -> sendRichMessage
 *   renderLegacy(blocks)    legacy parse_mode "html"   -> GramJS sendMessage
 *
 * `renderLegacy()` is the graceful degradation path used by the userbot (an
 * MTProto *user* session, which cannot call the Bot API `sendRichMessage`
 * method): buttons stay inside the message text — URL buttons become real
 * inline links, callback buttons stay underlined — instead of being converted
 * to an `InlineKeyboardButton`, exactly as required for Rich Message buttons.
 *
 * Documentation notes that shaped this implementation:
 *   - `RichMessageButton.text` may contain only plain text, custom emoji and
 *     date-time entities, and exactly one of the action fields must be used.
 *   - `callback_data` is limited to 1-64 bytes.
 *   - `style` must be one of “danger”, “success”, “primary”, “link”.
 *   - `RichBlockButtons` renders one row of buttons (`<tg-button-row>`).
 *   - `RichBlockTable`, `RichBlockExpandableBlockQuotation` and
 *     `RichBlockDocument` map to `<table>`, `<blockquote expandable>` and
 *     `<tg-document>`.
 */

const MAX_CALLBACK_BYTES = 64;
const BUTTON_STYLES = new Set(["danger", "success", "primary", "link"]);
const BUTTON_ACTIONS = [
  "url",
  "callback_data",
  "web_app",
  "login_url",
  "switch_inline_query",
  "switch_inline_query_current_chat",
  "switch_inline_query_chosen_chat",
  "copy_text",
  "disabled",
];

/* ------------------------------------------------------------------ *
 * Escaping                                                            *
 * ------------------------------------------------------------------ */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return esc(value).replace(/"/g, "&quot;");
}

/** Collapse anything (string / number / RichText array) into one RichText. */
function toRichText(value) {
  if (value == null || value === false || value === true) return "";
  if (Array.isArray(value)) return value.map(toRichText).filter((part) => part !== "");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return value;
}

/** True when the value is a RichText node/array rather than a plain string. */
function isRichText(value) {
  if (Array.isArray(value)) return value.some(isRichText);
  return Boolean(value && typeof value === "object" && (value.type || value.__raw !== undefined));
}

/* ------------------------------------------------------------------ *
 * RichMessageButton                                                   *
 * ------------------------------------------------------------------ */

/**
 * Truncate callback data to the 64-byte limit documented for
 * `RichMessageButton.callback_data` (multi-byte safe).
 */
function clampCallbackData(value) {
  let data = typeof value === "string" ? value : JSON.stringify(value);
  if (data == null) data = "";
  while (Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) {
    data = data.slice(0, -1);
  }
  return data;
}

function normalizeStyle(style) {
  if (!style) return undefined;
  const value = String(style).toLowerCase();
  return BUTTON_STYLES.has(value) ? value : undefined;
}

/**
 * Build a `RichMessageButton`.
 *
 * @param {string|object} label   Button text (plain text / RichText).
 * @param {object} payload        Exactly one action:
 *                                `{ button }` (alias of callback_data),
 *                                `{ callback_data }`, `{ url }`, `{ web_app }`,
 *                                `{ copy_text }`, `{ switch_inline_query }`,
 *                                `{ switch_inline_query_current_chat }`,
 *                                `{ login_url }`, `{ disabled }`.
 * @param {string} [style]        “primary” | “success” | “danger” | “link”.
 * @returns {object} RichMessageButton
 */
function richButton(label, payload = {}, style) {
  const source = payload && typeof payload === "object" ? payload : { url: payload };
  const button = { text: toRichText(label) };

  const normalizedStyle = normalizeStyle(style ?? source.style);
  if (normalizedStyle) button.style = normalizedStyle;

  if (source.button !== undefined) {
    button.callback_data = clampCallbackData(source.button);
  } else if (source.callback_data !== undefined) {
    button.callback_data = clampCallbackData(source.callback_data);
  } else if (source.url) {
    button.url = String(source.url);
  } else if (source.web_app) {
    button.web_app = typeof source.web_app === "string" ? { url: source.web_app } : source.web_app;
  } else if (source.login_url) {
    button.login_url = typeof source.login_url === "string" ? { url: source.login_url } : source.login_url;
  } else if (source.switch_inline_query !== undefined) {
    button.switch_inline_query = String(source.switch_inline_query);
  } else if (source.switch_inline_query_current_chat !== undefined) {
    button.switch_inline_query_current_chat = String(source.switch_inline_query_current_chat);
  } else if (source.switch_inline_query_chosen_chat) {
    button.switch_inline_query_chosen_chat = source.switch_inline_query_chosen_chat;
  } else if (source.copy_text !== undefined) {
    button.copy_text = typeof source.copy_text === "string" ? { text: source.copy_text } : source.copy_text;
  } else if (source.disabled) {
    button.disabled = {};
  }

  return button;
}

/** Resolve which action a RichMessageButton carries. */
function buttonAction(button) {
  for (const action of BUTTON_ACTIONS) {
    if (button[action] !== undefined) return action;
  }
  return null;
}

/** Accept both RichMessageButton and RichTextButton inputs. */
function unwrapButton(value) {
  if (!value) return null;
  if (value.type === "button" && value.button) return value.button;
  return value;
}

/* ------------------------------------------------------------------ *
 * RichText                                                            *
 * ------------------------------------------------------------------ */
const text = {
  /** Plain text run. */
  plain(value) {
    return toRichText(value);
  },

  /** Concatenate any number of RichText parts. */
  join(...parts) {
    const out = [];
    const push = (part) => {
      if (part == null || part === false) return;
      if (Array.isArray(part)) {
        part.forEach(push);
        return;
      }
      out.push(toRichText(part));
    };
    parts.forEach(push);
    return out;
  },

  bold(value) {
    return { type: "bold", text: toRichText(value) };
  },
  italic(value) {
    return { type: "italic", text: toRichText(value) };
  },
  underline(value) {
    return { type: "underline", text: toRichText(value) };
  },
  strikethrough(value) {
    return { type: "strikethrough", text: toRichText(value) };
  },
  spoiler(value) {
    return { type: "spoiler", text: toRichText(value) };
  },
  marked(value) {
    return { type: "marked", text: toRichText(value) };
  },
  code(value) {
    return { type: "code", text: toRichText(value) };
  },
  subscript(value) {
    return { type: "subscript", text: toRichText(value) };
  },
  superscript(value) {
    return { type: "superscript", text: toRichText(value) };
  },

  /** RichTextUrl — a real inline link. */
  link(label, url) {
    return { type: "url", text: toRichText(label), url: String(url) };
  },
  /** RichTextMention — `@username` mention. */
  mention(label, username) {
    return {
      type: "mention",
      text: toRichText(label ?? `@${String(username).replace(/^@/, "")}`),
      username: String(username).replace(/^@/, ""),
    };
  },
  /** RichTextTextMention — mention by user identifier (`tg://user?id=`). */
  textMention(label, userId) {
    return {
      type: "text_mention",
      text: toRichText(label),
      user: typeof userId === "object" ? userId : { id: userId },
    };
  },
  email(label, emailAddress) {
    return { type: "email_address", text: toRichText(label), email_address: String(emailAddress) };
  },
  phone(label, phoneNumber) {
    return { type: "phone_number", text: toRichText(label), phone_number: String(phoneNumber) };
  },
  /** RichTextDateTime — `<tg-time unix=... format=...>`. */
  dateTime(label, unixTime, format) {
    return {
      type: "date_time",
      text: toRichText(label),
      unix_time: Number(unixTime),
      date_time_format: String(format),
    };
  },
  /** RichTextCustomEmoji. */
  customEmoji(emojiId, alternativeText = "") {
    return { type: "custom_emoji", custom_emoji_id: String(emojiId), alternative_text: String(alternativeText) };
  },
  /** RichTextMathematicalExpression — LaTeX source. */
  math(expression) {
    return { type: "mathematical_expression", expression: String(expression) };
  },
  botCommand(command) {
    return { type: "bot_command", text: command, bot_command: command };
  },
  hashtag(tag) {
    return { type: "hashtag", text: tag, hashtag: tag };
  },
  cashtag(tag) {
    return { type: "cashtag", text: tag, cashtag: tag };
  },
  anchor(name) {
    return { type: "anchor", name: String(name) };
  },
  anchorLink(label, anchorName) {
    return { type: "anchor_link", text: toRichText(label), anchor_name: String(anchorName) };
  },
  reference(label, name) {
    return { type: "reference", text: toRichText(label), name: String(name) };
  },
  referenceLink(label, referenceName) {
    return { type: "reference_link", text: toRichText(label), reference_name: String(referenceName) };
  },

  /**
   * RichTextButton — an *inline* button rendered inside the text.
   *
   *   text.button(richButton('contoh', { button: 'menu_1' }, 'primary'))
   */
  button(value) {
    const button = unwrapButton(value);
    if (!button) throw new TypeError("text.button() membutuhkan RichMessageButton");
    return { type: "button", button };
  },

  /** Convenience: build and wrap in one call. */
  richButton(label, payload, style) {
    return text.button(richButton(label, payload, style));
  },

  /** A row of inline buttons (`RichBlockButtons`). */
  buttons(list, options) {
    return block.buttons(list, options);
  },

  /**
   * Pre-rendered HTML passthrough.
   * Rich Markdown explicitly accepts arbitrary HTML, so a raw node renders
   * identically in the Rich Message and legacy transports. Used to keep the
   * project's existing HTML detail rows intact.
   */
  raw(html) {
    return { __raw: String(html == null ? "" : html) };
  },

  /**
   * Usage hint / example line, e.g.
   *
   *   text.example('EXAMPLE 1: ', text.button(richButton('contoh', { button: 'menu_1' }, 'primary')))
   */
  example(...parts) {
    return text.join(...parts);
  },
};

/* ------------------------------------------------------------------ *
 * RichBlock                                                           *
 * ------------------------------------------------------------------ */
function normalizeListItem(item) {
  if (item == null || item === false) return null;
  if (typeof item === "string" || typeof item === "number" || Array.isArray(item)) {
    return { blocks: [block.paragraph(item)] };
  }
  if (item.blocks) return item;
  if (item.text !== undefined) {
    return {
      blocks: [block.paragraph(item.text)],
      has_checkbox: item.checked !== undefined || item.has_checkbox,
      is_checked: item.checked,
      label: item.label,
      value: item.value,
      type: item.type,
    };
  }
  return { blocks: [block.paragraph(item)] };
}

/**
 * Split quotation arguments into RichText parts and a trailing options object
 * (`{ credit }`), so `block.quote('text', { credit: 'Author' })` works.
 */
function quoteArgs(parts) {
  const list = parts.slice();
  const last = list[list.length - 1];
  const isOptions =
    last &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    last.type === undefined &&
    last.__raw === undefined &&
    (last.credit !== undefined || last.open !== undefined);
  if (isOptions) list.pop();
  return { parts: list, options: isOptions ? last : {} };
}

const block = {
  /** RichBlockParagraph */
  paragraph(...parts) {
    return { type: "paragraph", text: text.join(...parts) };
  },

  /** RichBlockSectionHeading — size 1 (largest) .. 6 (smallest). */
  heading(size, ...parts) {
    // Both orders are accepted: `heading(1, text)` (canonical) and
    // `heading(text, 1)` (as written in some call sites).
    let level = Number(size);
    if (!Number.isFinite(level)) {
      parts = [size, ...parts];
      const last = parts[parts.length - 1];
      if (parts.length > 1 && Number.isInteger(Number(last)) && Number(last) >= 1 && Number(last) <= 6) {
        level = Number(parts.pop());
      } else {
        level = 3;
      }
    }
    level = Math.min(6, Math.max(1, Math.trunc(level)));
    return { type: "heading", size: level, text: text.join(...parts) };
  },

  /** RichBlockPreformatted */
  pre(content, language) {
    return { type: "pre", text: String(content == null ? "" : content), language: language || undefined };
  },

  /** RichBlockFooter */
  footer(...parts) {
    return { type: "footer", text: text.join(...parts) };
  },

  /** RichBlockDivider */
  divider() {
    return { type: "divider" };
  },

  /** RichBlockMathematicalExpression */
  math(expression) {
    return { type: "mathematical_expression", expression: String(expression) };
  },

  /** RichBlockAnchor */
  anchor(name) {
    return { type: "anchor", name: String(name) };
  },

  /** RichBlockList */
  list(items, options = {}) {
    const normalized = (items || []).map(normalizeListItem).filter(Boolean);
    return {
      type: "list",
      items: normalized,
      ordered: Boolean(options.ordered),
      start: options.start,
      type2: options.type,
    };
  },

  /**
   * RichBlockBlockQuotation — `{ blocks: [...] }` (verified against Bot API).
   * A `text` field is not accepted here; only blocks are.
   */
  blockquote(...parts) {
    const { parts: content, options } = quoteArgs(parts);
    return { type: "blockquote", blocks: [block.paragraph(...content)], credit: options.credit };
  },

  /** Alias of `blockquote` (shorter name used by call sites). */
  quote(...parts) {
    return block.blockquote(...parts);
  },

  /**
   * RichBlockExpandableBlockQuotation.
   * Verified: this block takes a `text` field, **not** nested `blocks`
   * (`{blocks}` → RICH_MESSAGE_CONTENT_REQUIRED). `summary` is optional.
   */
  expandableBlockquote(...parts) {
    const { parts: content, options } = quoteArgs(parts);
    const text_ = content.length === 1 ? content[0] : text.join(...content);
    const node = { type: "expandable_blockquote", text: text_ };
    if (options.credit !== undefined) node.credit = options.credit;
    if (options.summary !== undefined) node.summary = options.summary;
    return node;
  },

  /** RichBlockPullQuotation — `<aside>` (text based, like the expandable one). */
  pullquote(...parts) {
    const { parts: content, options } = quoteArgs(parts);
    const text_ = content.length === 1 ? content[0] : text.join(...content);
    return { type: "pullquote", text: text_, credit: options.credit };
  },

  /**
   * RichBlockTable
   *
   * @param {object} table
   * @param {string[]} [table.headers]
   * @param {Array<Array<string|object>>} table.rows
   * @param {string} [table.caption]
   * @param {boolean} [table.bordered]
   * @param {boolean} [table.striped]
   * @param {boolean} [table.compact]
   */
  table(table = {}) {
    const cells = [];
    if (Array.isArray(table.headers) && table.headers.length) {
      cells.push(table.headers.map((value) => ({ text: toRichText(value), is_header: true })));
    }
    for (const row of table.rows || []) {
      cells.push(
        (row || []).map((value) => {
          if (value && typeof value === "object" && !Array.isArray(value) && value.text !== undefined) return value;
          return { text: toRichText(value) };
        }),
      );
    }
    return {
      type: "table",
      cells,
      caption: table.caption ? toRichText(table.caption) : undefined,
      is_bordered: Boolean(table.bordered),
      is_striped: Boolean(table.striped),
      is_compact: Boolean(table.compact),
    };
  },

  /**
   * RichBlockButtons — one row of RichMessageButtons (`<tg-button-row>`).
   * Accepts RichMessageButton or RichTextButton values.
   */
  buttons(list, options = {}) {
    const buttons = (list || []).map(unwrapButton).filter(Boolean);
    return { type: "buttons", buttons, align: options.align };
  },

  /** Several button rows at once. */
  buttonRows(rows, options = {}) {
    return (rows || []).map((row) => block.buttons(row, options));
  },

  /** RichBlockDetails — `<details><summary>` */
  details(summary, blocks, options = {}) {
    const content = Array.isArray(blocks) ? blocks : [blocks].filter(Boolean);
    return {
      type: "details",
      summary: toRichText(summary),
      blocks: content,
      is_open: Boolean(options.open),
    };
  },

  /**
   * Media blocks (photo / video / audio / animation / voice_note / document).
   *
   * Verified Bot API shape:
   *   { type: "photo", photo: { type: "photo", media: "<url | attach://name>" },
   *     caption: { text: RichText }, credit: { text: RichText } }
   *
   * `media` accepts an HTTP(S) URL or `attach://<field>` for a multipart upload.
   * A bare `{ type: "photo", url }` is rejected (`Can't find field "photo"`),
   * which is what the previous implementation sent.
   */
  media(kind, media, options = {}) {
    const type = String(kind);
    const node = { type, [type]: { type, media: String(media) } };
    if (options.caption !== undefined) node.caption = { text: toRichText(options.caption) };
    if (options.credit !== undefined) node.credit = { text: toRichText(options.credit) };
    return node;
  },

  /** RichBlockDocument (HTTP/HTTPS URL or `attach://<field>`). */
  document(url, options = {}) {
    return block.media("document", url, options);
  },

  /** RichBlockPhoto */
  photo(url, options = {}) {
    return block.media("photo", url, options);
  },
  video(url, options = {}) {
    return block.media("video", url, options);
  },
  audio(url, options = {}) {
    return block.media("audio", url, options);
  },
  animation(url, options = {}) {
    return block.media("animation", url, options);
  },
  voiceNote(url, options = {}) {
    return block.media("voice_note", url, options);
  },
};

/* ------------------------------------------------------------------ *
 * RichText renderers                                                  *
 * ------------------------------------------------------------------ */
const HTML_TAGS = {
  bold: "b",
  italic: "i",
  underline: "u",
  strikethrough: "s",
  spoiler: "tg-spoiler",
  marked: "mark",
  code: "code",
  subscript: "sub",
  superscript: "sup",
};

function renderText(node, mode) {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map((part) => renderText(part, mode)).join("");
  if (typeof node === "number") return String(node);
  if (typeof node === "string") {
    if (mode === "legacy") return esc(node);
    return esc(node).replace(/\r?\n/g, "<br/>");
  }
  if (typeof node !== "object") return esc(String(node));
  if (node.__raw !== undefined) return node.__raw;

  const type = node.type;
  if (HTML_TAGS[type]) {
    const tag = HTML_TAGS[type];
    if (mode === "legacy" && (tag === "mark" || tag === "sub" || tag === "sup")) {
      return `<b>${renderText(node.text, mode)}</b>`;
    }
    return `<${tag}>${renderText(node.text, mode)}</${tag}>`;
  }

  switch (type) {
    case "url":
      if (mode === "legacy") return `<a href="${escAttr(node.url)}">${renderText(node.text, mode)}</a>`;
      return `<a href="${escAttr(node.url)}">${renderText(node.text, mode)}</a>`;
    case "mention":
      return `<a href="https://t.me/${escAttr(node.username)}">${renderText(node.text, mode)}</a>`;
    case "text_mention": {
      const id = node.user && (node.user.id ?? node.user.user_id);
      return `<a href="tg://user?id=${escAttr(id)}">${renderText(node.text, mode)}</a>`;
    }
    case "email_address":
      return `<a href="mailto:${escAttr(node.email_address)}">${renderText(node.text, mode)}</a>`;
    case "phone_number":
      return `<a href="tel:${escAttr(node.phone_number)}">${renderText(node.text, mode)}</a>`;
    case "date_time":
      if (mode === "legacy") return renderText(node.text, mode);
      return `<tg-time unix="${escAttr(node.unix_time)}" format="${escAttr(node.date_time_format)}">${renderText(
        node.text,
        mode,
      )}</tg-time>`;
    case "custom_emoji":
      if (mode === "legacy") return esc(node.alternative_text || "");
      return `<tg-emoji emoji-id="${escAttr(node.custom_emoji_id)}">${esc(node.alternative_text || "")}</tg-emoji>`;
    case "mathematical_expression":
      if (mode === "legacy") return `<code>${esc(node.expression)}</code>`;
      return `<tg-math>${esc(node.expression)}</tg-math>`;
    case "anchor":
      return mode === "legacy" ? "" : `<a name="${escAttr(node.name)}"></a>`;
    case "anchor_link":
      return mode === "legacy"
        ? renderText(node.text, mode)
        : `<a href="#${escAttr(node.anchor_name)}">${renderText(node.text, mode)}</a>`;
    case "reference":
      return mode === "legacy"
        ? renderText(node.text, mode)
        : `<tg-reference name="${escAttr(node.name)}">${renderText(node.text, mode)}</tg-reference>`;
    case "reference_link":
      return mode === "legacy"
        ? renderText(node.text, mode)
        : `<a href="#${escAttr(node.reference_name)}">${renderText(node.text, mode)}</a>`;
    case "bot_command":
    case "hashtag":
    case "cashtag":
      return renderText(node.text ?? "", mode);
    case "button":
      return mode === "legacy" ? renderLegacyButton(node.button) : renderButtonTag(node.button);
    default:
      if (node.text !== undefined) return renderText(node.text, mode);
      return esc(JSON.stringify(node));
  }
}

/* ------------------------------------------------------------------ *
 * Plain-text helpers for the legacy table fallback                    *
 * ------------------------------------------------------------------ */
/** Strip the inline tags the legacy renderer emits, keeping the text. */
function plainText(value) {
  return String(value == null ? "" : value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible width: emoji and CJK glyphs occupy two columns. */
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

/* ------------------------------------------------------------------ *
 * Button renderers                                                    *
 * ------------------------------------------------------------------ */
function renderButtonTag(button) {
  const action = buttonAction(button);
  const attrs = [];
  switch (action) {
    case "url":
      attrs.push('type="url"', `url="${escAttr(button.url)}"`);
      break;
    case "callback_data":
      attrs.push('type="callback_data"', `data="${escAttr(button.callback_data)}"`);
      break;
    case "web_app":
      attrs.push('type="web_app"', `url="${escAttr(button.web_app.url)}"`);
      break;
    case "login_url": {
      attrs.push('type="login_url"', `url="${escAttr(button.login_url.url)}"`);
      if (button.login_url.forward_text) attrs.push(`forward-text="${escAttr(button.login_url.forward_text)}"`);
      if (button.login_url.request_write_access) attrs.push("request-write-access");
      break;
    }
    case "switch_inline_query":
      attrs.push('type="switch_inline_query"', `query="${escAttr(button.switch_inline_query)}"`);
      break;
    case "switch_inline_query_current_chat":
      attrs.push(
        'type="switch_inline_query_current_chat"',
        `query="${escAttr(button.switch_inline_query_current_chat)}"`,
      );
      break;
    case "switch_inline_query_chosen_chat": {
      const chosen = button.switch_inline_query_chosen_chat;
      attrs.push('type="switch_inline_query_chosen_chat"', `query="${escAttr(chosen.query || "")}"`);
      if (chosen.allow_user_chats) attrs.push("allow-user-chats");
      if (chosen.allow_bot_chats) attrs.push("allow-bot-chats");
      if (chosen.allow_group_chats) attrs.push("allow-group-chats");
      if (chosen.allow_channel_chats) attrs.push("allow-channel-chats");
      break;
    }
    case "copy_text":
      attrs.push('type="copy_text"', `text="${escAttr(button.copy_text.text)}"`);
      break;
    case "disabled":
      attrs.push('type="disabled"');
      break;
    default:
      attrs.push('type="disabled"');
      break;
  }
  if (button.style) attrs.unshift(`style="${escAttr(button.style)}"`);
  return `<tg-button ${attrs.join(" ")}>${renderText(button.text, "markdown")}</tg-button>`;
}

/**
 * Legacy `parse_mode: "html"` rendering of a Rich Message button.
 *
 * MTProto user sessions cannot render `tg-button`, so each button degrades to
 * the closest native HTML entity that keeps the *action reachable inside the
 * text* — it is deliberately never converted to an `InlineKeyboardButton`:
 *
 *   url / web_app / login_url  -> real inline link
 *   copy_text                  -> monospace, one tap selects the value to copy
 *   disabled                   -> strikethrough
 *   callback / switch_inline   -> underline (no client-side equivalent)
 */
function renderLegacyButton(button) {
  if (!button) return "";
  const label = renderText(button.text, "legacy");
  switch (buttonAction(button)) {
    case "url":
      return `<a href="${escAttr(button.url)}">${label}</a>`;
    case "web_app":
      return `<a href="${escAttr(button.web_app.url)}">${label}</a>`;
    case "login_url":
      return `<a href="${escAttr(button.login_url.url)}">${label}</a>`;
    case "copy_text": {
      // `copy_text` has no MTProto entity. Show the label *and* the payload as
      // inline code, so a tap-to-select copy still works and the button keeps
      // its meaning. Showing the payload alone produced a bare `<code>` with no
      // hint of what it does.
      const value = String((button.copy_text && button.copy_text.text) || "");
      if (!value) return `<u>${label}</u>`;
      const shown = value.length > 64 ? `${value.slice(0, 61)}…` : value;
      if (label && label !== value) return `${label} <code>${esc(shown)}</code>`;
      return `<code>${esc(shown)}</code>`;
    }
    case "disabled":
      return `<s>${label}</s>`;
    case "switch_inline_query":
    case "switch_inline_query_current_chat":
    case "switch_inline_query_chosen_chat":
    case "callback_data":
    default:
      return `<u>${label}</u>`;
  }
}

/* ------------------------------------------------------------------ *
 * Block renderers                                                     *
 * ------------------------------------------------------------------ */
function renderBlocksLegacy(blocks) {
  const chunks = [];
  for (const item of blocks || []) {
    if (!item) continue;
    const rendered = renderBlockLegacy(item);
    if (rendered !== "" && rendered != null) chunks.push(rendered);
  }
  return chunks.join("\n\n");
}

function renderBlockLegacy(node) {
  switch (node.type) {
    case "paragraph":
      return renderText(node.text, "legacy");
    case "heading":
      return `<b>${renderText(node.text, "legacy")}</b>`;
    case "pre":
      return node.language
        ? `<pre><code class="language-${escAttr(node.language)}">${esc(node.text)}</code></pre>`
        : `<pre>${esc(node.text)}</pre>`;
    case "footer":
      return `<i>${renderText(node.text, "legacy")}</i>`;
    case "divider":
      return "┈".repeat(12);
    case "mathematical_expression":
      return `<code>${esc(node.expression)}</code>`;
    case "anchor":
      return "";
    case "list": {
      const marker = node.ordered ? (index) => `${index + 1}.` : () => "▸";
      return (node.items || [])
        .map((item, index) => {
          const body = renderBlocksLegacy(item.blocks);
          const checkbox =
            item.has_checkbox || item.is_checked !== undefined ? (item.is_checked ? "☑ " : "☐ ") : "";
          return `${marker(index)} ${checkbox}${body}`;
        })
        .join("\n");
    }
    case "blockquote":
    case "expandable_blockquote":
    case "pullquote": {
      const body = renderBlocksLegacy(node.blocks);
      const credit = node.credit ? `\n— ${renderText(node.credit, "legacy")}` : "";
      return `<blockquote>${body}${credit}</blockquote>`;
    }
    case "table": {
      // parse_mode HTML has no <table>, so the fallback is a width-aligned
      // <pre> block; columns stay readable in every client.
      const matrix = (node.cells || []).map((row) => (row || []).map((cell) => cell || {}));
      const plain = (cell) => plainText(renderText(cell.text ?? "", "legacy"));
      const columns = Math.max(0, ...matrix.map((row) => row.length));
      const widths = Array.from({ length: columns }, (_, index) =>
        Math.max(1, ...matrix.map((row) => displayWidth(plain(row[index] || {})))),
      );
      const lines = matrix.map((row) =>
        widths
          .map((width, index) => {
            const text = plain(row[index] || {});
            return text + " ".repeat(Math.max(0, width - displayWidth(text)));
          })
          .join(" │ ")
          .replace(/\s+$/, ""),
      );
      const caption = node.caption ? `\n<i>${renderText(node.caption, "legacy")}</i>` : "";
      if (!lines.length) return caption;
      return `<pre>${esc(lines.join("\n"))}</pre>${caption}`;
    }
    case "buttons":
      return (node.buttons || []).map(renderLegacyButton).join("  ");
    case "details": {
      const body = renderBlocksLegacy(node.blocks);
      return `<b>${renderText(node.summary, "legacy")}</b>\n${body}`;
    }
    case "document":
    case "photo":
    case "video":
    case "audio":
    case "animation":
    case "voice_note": {
      const label = node.caption ? renderText(node.caption, "legacy") : esc(node.url);
      return `<a href="${escAttr(node.url)}">${label}</a>`;
    }
    default:
      return node.text !== undefined ? renderText(node.text, "legacy") : "";
  }
}

function renderBlocksRich(blocks) {
  const chunks = [];
  for (const item of blocks || []) {
    if (!item) continue;
    const rendered = renderBlockRich(item);
    if (rendered) chunks.push(rendered);
  }
  return chunks.join("\n");
}

function figure(url, tag, node) {
  const caption = node.caption
    ? `<figcaption>${renderText(node.caption, "markdown")}${
        node.credit ? `<cite>${renderText(node.credit, "markdown")}</cite>` : ""
      }</figcaption>`
    : "";
  return `<figure><${tag} src="${escAttr(url)}"></${tag}>${caption}</figure>`;
}

function renderBlockRich(node) {
  switch (node.type) {
    case "paragraph":
      return `<p>${renderText(node.text, "markdown")}</p>`;
    case "heading":
      return `<h${node.size || 3}>${renderText(node.text, "markdown")}</h${node.size || 3}>`;
    case "pre":
      return node.language
        ? `<pre><code class="language-${escAttr(node.language)}">${esc(node.text)}</code></pre>`
        : `<pre>${esc(node.text)}</pre>`;
    case "footer":
      return `<footer>${renderText(node.text, "markdown")}</footer>`;
    case "divider":
      return "<hr/>";
    case "mathematical_expression":
      return `<tg-math-block>${esc(node.expression)}</tg-math-block>`;
    case "anchor":
      return `<a name="${escAttr(node.name)}"></a>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const items = (node.items || [])
        .map((item) => {
          const body = renderBlocksRich(item.blocks);
          const checkbox =
            item.has_checkbox || item.is_checked !== undefined
              ? `<input type="checkbox"${item.is_checked ? " checked" : ""}>`
              : "";
          return `<li>${checkbox}${body}</li>`;
        })
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "blockquote":
    case "expandable_blockquote":
    case "pullquote": {
      const body = renderBlocksRich(node.blocks);
      const credit = node.credit ? `<cite>${renderText(node.credit, "markdown")}</cite>` : "";
      if (node.type === "pullquote") return `<aside>${body}${credit}</aside>`;
      if (node.type === "expandable_blockquote") return `<blockquote expandable>${body}${credit}</blockquote>`;
      return `<blockquote>${body}${credit}</blockquote>`;
    }
    case "table": {
      const flags = [node.is_bordered ? "bordered" : "", node.is_striped ? "striped" : "", node.is_compact ? "compact" : ""]
        .filter(Boolean)
        .join(" ");
      const caption = node.caption ? `<caption>${renderText(node.caption, "markdown")}</caption>` : "";
      const rows = (node.cells || [])
        .map((row) => {
          const isHeaderRow = (row || []).every((cell) => cell.is_header);
          const cells = (row || [])
            .map((cell) => {
              const tag = cell.is_header || isHeaderRow ? "th" : "td";
              const attrs = [
                cell.colspan > 1 ? `colspan="${cell.colspan}"` : "",
                cell.rowspan > 1 ? `rowspan="${cell.rowspan}"` : "",
                cell.align ? `align="${escAttr(cell.align)}"` : "",
                cell.valign ? `valign="${escAttr(cell.valign)}"` : "",
              ]
                .filter(Boolean)
                .join(" ");
              return `<${tag}${attrs ? ` ${attrs}` : ""}>${renderText(cell.text ?? "", "markdown")}</${tag}>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table${flags ? ` ${flags}` : ""}>${caption}${rows}</table>`;
    }
    case "buttons": {
      const align = node.align ? ` align="${escAttr(node.align)}"` : "";
      return `<tg-button-row${align}>${(node.buttons || []).map(renderButtonTag).join("")}</tg-button-row>`;
    }
    case "details": {
      const body = renderBlocksRich(node.blocks);
      return `<details${node.is_open ? " open" : ""}><summary>${renderText(node.summary, "markdown")}</summary>${body}</details>`;
    }
    case "document":
      return figure(node.url, "tg-document", node);
    case "photo":
      return figure(node.url, "img", node);
    case "video":
    case "animation":
      return figure(node.url, "video", node);
    case "audio":
    case "voice_note":
      return figure(node.url, "audio", node);
    default:
      return node.text !== undefined ? `<p>${renderText(node.text, "markdown")}</p>` : "";
  }
}

/* ------------------------------------------------------------------ *
 * InputRichBlock renderer (sendRichMessage `blocks` field)            *
 * ------------------------------------------------------------------ */
function toInputBlocks(blocks) {
  const out = [];
  for (const item of blocks || []) {
    if (!item) continue;
    const mapped = toInputBlock(item);
    if (mapped) out.push(mapped);
  }
  return out;
}

function toInputBlock(node) {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", text: toInputText(node.text) };
    case "heading":
      return { type: "heading", text: toInputText(node.text), size: node.size || 3 };
    case "pre":
      return { type: "pre", text: toInputText(node.text), language: node.language };
    case "footer":
      return { type: "footer", text: toInputText(node.text) };
    case "divider":
      return { type: "divider" };
    case "mathematical_expression":
      return { type: "mathematical_expression", expression: node.expression };
    case "anchor":
      return { type: "anchor", name: node.name };
    case "list":
      return {
        type: "list",
        items: (node.items || []).map((item) => ({
          blocks: toInputBlocks(item.blocks),
          has_checkbox: item.has_checkbox,
          is_checked: item.is_checked,
          value: item.value,
          type: item.type,
        })),
      };
    case "blockquote":
      // Verified: blockquote takes nested blocks; the expandable variant takes
      // a `text` field. Mixing them up yields RICH_MESSAGE_CONTENT_REQUIRED.
      return {
        type: "blockquote",
        blocks: toInputBlocks(node.blocks),
        // Docs: RichBlockBlockQuotation.credit is RichText (plain).
        credit: node.credit !== undefined ? toInputText(node.credit) : undefined,
      };
    case "expandable_blockquote":
    case "pullquote": {
      // Verified: `credit` is plain RichText here (not a `{text}` wrapper);
      // passing an object yields "Can't find field \"type\"".
      const out = { type: node.type, text: toInputText(node.text) };
      if (node.credit !== undefined) out.credit = toInputText(node.credit);
      if (node.summary !== undefined) out.summary = toInputText(node.summary);
      return out;
    }
    case "table":
      // Verified: every cell must be an object (`RichBlockTableCell must be an
      // object`), so a bare string would reject the whole message.
      return {
        type: "table",
        cells: (node.cells || []).map((row) =>
          (row || []).map((cell) => {
            const source = cell && typeof cell === "object" ? cell : { text: cell };
            const out = { text: toInputText(source.text ?? "") };
            for (const key of ["is_header", "colspan", "rowspan", "align", "valign"]) {
              if (source[key] !== undefined) out[key] = source[key];
            }
            return out;
          }),
        ),
        is_bordered: node.is_bordered,
        is_striped: node.is_striped,
        is_compact: node.is_compact,
        caption: node.caption !== undefined ? toInputText(node.caption) : undefined,
      };
    case "buttons":
      return { type: "buttons", buttons: node.buttons, align: node.align };
    case "details":
      return {
        type: "details",
        summary: toInputText(node.summary),
        blocks: toInputBlocks(node.blocks),
        is_open: node.is_open,
      };
    case "document":
    case "photo":
    case "video":
    case "audio":
    case "animation":
    case "voice_note":
      return toInputMediaBlock(node);
    default:
      return node.text !== undefined ? { type: "paragraph", text: toInputText(node.text) } : null;
  }
}

/* ------------------------------------------------------------------ *
 * HTML -> RichText (for the `blocks` payload)                         *
 * ------------------------------------------------------------------ */
const HTML_TO_RICHTEXT = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
  code: "code",
  mark: "marked",
  sub: "subscript",
  sup: "superscript",
  "tg-spoiler": "spoiler",
};

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Parse the small HTML subset this project emits into a RichText tree.
 * Rich Markdown accepts arbitrary HTML, but the `blocks` field needs real
 * RichText entities — this keeps both payloads semantically identical.
 */
function htmlToRichText(html) {
  const source = String(html == null ? "" : html);
  const root = [];
  const stack = [{ children: root }];
  const tagRe = /<\/?[a-zA-Z][\w-]*(?:\s+[^>]*?)?\/?>/g;
  let lastIndex = 0;
  let match;

  const pushText = (value) => {
    if (!value) return;
    stack[stack.length - 1].children.push(decodeEntities(value));
  };

  while ((match = tagRe.exec(source))) {
    pushText(source.slice(lastIndex, match.index));
    lastIndex = tagRe.lastIndex;
    const token = match[0];

    if (/^<br\s*\/?>$/i.test(token)) {
      pushText("\n");
      continue;
    }
    if (/^<\/?\w[^>]*\/?>$/i.test(token) === false) continue;

    const closing = token.startsWith("</");
    const selfClosing = /\/>$/.test(token);
    const name = (/^<\/?([a-zA-Z][\w-]*)/.exec(token) || [])[1].toLowerCase();

    if (closing) {
      // Pop to the matching frame, tolerating unbalanced markup.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          const frame = stack[i];
          stack.length = i;
          const children = frame.children.filter((part) => part !== "");
          const inner = children.length === 1 ? children[0] : children;
          const node = frame.wrap(inner);
          if (node) stack[stack.length - 1].children.push(node);
          break;
        }
      }
      continue;
    }

    if (selfClosing || name === "hr") {
      if (name === "hr") stack[stack.length - 1].children.push("\n");
      continue;
    }

    let wrap = null;
    if (HTML_TO_RICHTEXT[name]) {
      const type = HTML_TO_RICHTEXT[name];
      wrap = (inner) => ({ type, text: inner });
    } else if (name === "a") {
      const href = (/href="([^"]*)"/i.exec(token) || [])[1];
      if (href) {
        const url = decodeEntities(href);
        if (url.startsWith("#")) {
          wrap = (inner) => ({ type: "anchor_link", text: inner, anchor_name: url.slice(1) });
        } else if (url.startsWith("mailto:")) {
          wrap = (inner) => ({ type: "email_address", text: inner, email_address: url.slice(7) });
        } else if (url.startsWith("tel:")) {
          wrap = (inner) => ({ type: "phone_number", text: inner, phone_number: url.slice(4) });
        } else if (url.startsWith("tg://user?id=")) {
          wrap = (inner) => ({
            type: "text_mention",
            text: inner,
            user: { id: Number(url.slice("tg://user?id=".length)) || 0 },
          });
        } else {
          wrap = (inner) => ({ type: "url", text: inner, url });
        }
      }
    } else if (name === "tg-emoji") {
      const id = (/emoji-id="([^"]*)"/i.exec(token) || [])[1];
      if (id) wrap = (inner) => ({ type: "custom_emoji", custom_emoji_id: id, alternative_text: inner });
    } else if (name === "tg-time") {
      const unix = (/unix="([^"]*)"/i.exec(token) || [])[1];
      const format = (/format="([^"]*)"/i.exec(token) || [])[1];
      if (unix && format) wrap = (inner) => ({ type: "date_time", text: inner, unix_time: Number(unix), date_time_format: format });
    }

    // Unknown tags are transparent containers (their text is still kept).
    stack.push({ name, children: [], wrap });
  }

  pushText(source.slice(lastIndex));

  // Flatten frames that were never closed.
  while (stack.length > 1) {
    const frame = stack.pop();
    const children = frame.children.filter((part) => part !== "");
    const inner = children.length === 1 ? children[0] : children;
    const node = frame.wrap ? frame.wrap(inner) : inner;
    if (node != null && node !== "") stack[stack.length - 1].children.push(node);
  }

  const out = root.filter((part) => part !== "");
  return out.length === 1 ? out[0] : out;
}

/** Convert a RichText tree into the plain JSON shape the Bot API expects. */
function toInputText(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    // Flatten nested arrays so the payload stays a flat RichText list.
    const parts = [];
    for (const item of node) {
      const mapped = toInputText(item);
      if (mapped === "" || mapped == null) continue;
      if (Array.isArray(mapped)) parts.push(...mapped);
      else parts.push(mapped);
    }
    if (parts.length === 1) return parts[0];
    return parts;
  }
  if (node.__raw !== undefined) return toInputText(htmlToRichText(node.__raw));
  // `{ text: ... }` wrappers (caption/credit) must be unwrapped, not re-wrapped:
  // otherwise the payload becomes `{ text: { text: "cap" } }` and Telegram
  // rejects the whole message with "Can't find field \"type\"".
  if (node.type === undefined && node.text !== undefined) return toInputText(node.text);
  if (node.type === "button") return { type: "button", button: node.button };
  if (node.type === "anchor") return node;
  if (node.type === "mathematical_expression") return node;
  if (node.text !== undefined) return { type: node.type, text: toInputText(node.text) };
  return node;
}

/**
 * Map a media block to its `InputRichBlock*` counterpart.
 * The Bot API expects an `InputMedia*` object (a URL is accepted through its
 * `media` field), with the caption moved into the block's own `caption`.
 */
/**
 * Media block → `InputRichBlock`.
 * Verified shape: `{ type, <kind>: { type: <kind>, media: "<url|attach://>" } }`
 * with `caption` / `credit` as `{ text: RichText }` objects.
 */
function toInputMediaBlock(node) {
  const kind = node.type;
  const holder = node[kind] || node.media || {};
  const media =
    (holder && typeof holder === "object" ? holder.media : undefined) ??
    node.url ??
    (typeof node.media === "string" ? node.media : undefined);
  const input = { type: kind, [kind]: { type: kind, media: String(media) } };
  if (node.caption !== undefined) input.caption = { text: toInputText(node.caption) };
  if (node.credit !== undefined) input.credit = { text: toInputText(node.credit) };
  return input;
}

/* ------------------------------------------------------------------ *
 * Public renderers                                                    *
 * ------------------------------------------------------------------ */
function renderMarkdown(blocks) {
  return renderBlocksRich(blocks);
}

function renderHtml(blocks) {
  return renderBlocksRich(blocks);
}

function renderLegacy(blocks) {
  return renderBlocksLegacy(blocks);
}

/**
 * A rendered Rich Message that can be handed to `sendRichMessage` /
 * `editMessageText` as-is, while still carrying the legacy HTML fallback.
 */
/* ------------------------------------------------------------------ *
 * Table pipeline                                                      *
 * ------------------------------------------------------------------ */
/**
 * Build a `RichBlockTable` from a header row and data rows.
 *
 * This is the single table builder: every table in the project goes through it
 * so the rich `<table>` and the plain fallback stay in sync.
 *
 * Cell values may be:
 *   - a plain string/number → escaped automatically (safe by default)
 *   - RichText (`text.bold(...)`, `text.raw(...)`, …) → rendered as-is
 *   - `{ text, is_header, align, colspan, rowspan }` → explicit cell control
 *
 * Ragged rows are padded to the header width so the rendered `<table>` never
 * has a hole, and a row wider than the header is truncated to keep columns
 * aligned (Telegram rejects nothing here, but misaligned tables look broken).
 *
 * @param {string[]|object} headers  header labels, or a `{ headers, rows }` object
 * @param {Array<Array>} [rows]      data rows
 * @param {object} [options]         `{ caption, bordered, striped, compact }`
 * @returns {object} RichBlockTable
 */
function pipelineTable(headers, rows, options = {}) {
  const source =
    headers && !Array.isArray(headers) && typeof headers === "object"
      ? headers
      : { headers, rows, ...options };

  const headerRow = Array.isArray(source.headers) ? source.headers : [];
  const width = headerRow.length || Math.max(0, ...(source.rows || []).map((row) => (row || []).length));

  const toCell = (value, index) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.text !== undefined) {
      return value;
    }
    return { text: toRichText(value) };
  };

  const cells = [];
  if (width > 0) {
    cells.push(
      Array.from({ length: width }, (_, index) => ({
        ...toCell(headerRow[index] === undefined ? "" : headerRow[index], index),
        is_header: true,
      })),
    );
  }
  for (const row of source.rows || []) {
    const list = Array.isArray(row) ? row : [row];
    cells.push(
      Array.from({ length: width }, (_, index) => toCell(list[index] === undefined ? "" : list[index], index)),
    );
  }

  return {
    type: "table",
    cells,
    is_bordered: Boolean(source.bordered),
    is_striped: Boolean(source.striped),
    is_compact: Boolean(source.compact),
    ...(source.caption ? { caption: toRichText(source.caption) } : {}),
  };
}

/**
 * Assemble a Rich Message value from a block list.
 * Thin wrapper over `buildRichMessage` so callers share one shape.
 */
function richBlocks(blocks, options = {}) {
  return buildRichMessage(blocks, options);
}

/**
 * Fallback for the `parse_mode: "HTML"` transport (a user session cannot send
 * Rich Messages). Only tags that parser accepts are emitted — `<table>` becomes
 * an aligned `<pre>` block, `<details>` becomes a bold title plus its body.
 */
function plainOf(blocks, options = {}) {
  return renderLegacy(Array.isArray(blocks) ? blocks : [blocks], options);
}

function buildRichMessage(blocks, options = {}) {
  return {
    __rich: true,
    blocks: toInputBlocks(blocks),
    markdown: options.markdown ?? renderMarkdown(blocks),
    html: options.html ?? renderHtml(blocks),
    legacy: renderLegacy(blocks),
  };
}

function isRichMessage(value) {
  return Boolean(value && typeof value === "object" && value.__rich === true);
}

/* ------------------------------------------------------------------ *
 * Bot API transport (sendRichMessage / editMessageText)               *
 * ------------------------------------------------------------------ */
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

/**
 * Bot token used by the Bot API Rich Message renderer.
 * Resolution is centralised in `config.resolveBotToken()`:
 * `BOT_TOKEN` env → `TELEGRAM_BOT_TOKEN` env → `session/config.json`.
 * There is deliberately **no** hard-coded fallback token.
 */
function getBotToken() {
  try {
    const { resolveBotToken } = require("../config");
    return resolveBotToken() || null;
  } catch {
    return null;
  }
}

/** True when a Bot API token is available. */
function hasBotToken() {
  return Boolean(getBotToken());
}

/**
 * Validate the configured token once per process (`getMe`).
 * Never throws: a bad token simply disables the Bot API renderer.
 */
async function verifyBotToken(token = getBotToken()) {
  if (!token) return { ok: false, reason: "no-token" };
  if (verifyBotToken.cache && verifyBotToken.cache.token === token) {
    return verifyBotToken.cache.result;
  }
  let result;
  try {
    const me = await callBotApi(token, "getMe", {});
    result = { ok: true, me };
  } catch (err) {
    result = { ok: false, reason: String((err && err.message) || err) };
  }
  verifyBotToken.cache = { token, result };
  return result;
}

async function callBotApi(token, method, params) {
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!payload.ok) throw new Error(payload.description || `${method} gagal`);
  return payload.result;
}

/** `sendRichMessage` — https://core.telegram.org/bots/api#sendrichmessage */
async function sendRichMessage(token, params) {
  return callBotApi(token, "sendRichMessage", params);
}

/** `editMessageText` with the `rich_message` parameter (Bot API 10.3). */
async function editRichMessage(token, params) {
  return callBotApi(token, "editMessageText", params);
}

module.exports = {
  MAX_CALLBACK_BYTES,
  BUTTON_STYLES,
  esc,
  escAttr,
  toRichText,
  isRichText,
  clampCallbackData,
  richButton,
  buttonAction,
  unwrapButton,
  text,
  block,
  renderText,
  renderMarkdown,
  renderHtml,
  renderLegacy,
  renderButtonTag,
  renderLegacyButton,
  toInputBlocks,
  toInputText,
  htmlToRichText,
  buildRichMessage,
  pipelineTable,
  richBlocks,
  plainOf,
  isRichMessage,
  getBotToken,
  hasBotToken,
  verifyBotToken,
  callBotApi,
  sendRichMessage,
  editRichMessage,
};

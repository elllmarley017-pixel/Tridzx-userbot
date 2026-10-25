# hytrix-userbot-telegram

A personal **Telegram userbot** built entirely on **Node.js** (CommonJS) with
[GramJS](https://github.com/gram-js/gramjs). It reuses an existing Telethon
`SQLite` session file directly, so no re-login is required while the session is
valid.

> No Python is required at runtime. The only external binary used is `ffmpeg`
> (for media conversion).

## Features

### Downloaders
| Command | Description |
| --- | --- |
| `.ytsearch <query>` | Search YouTube videos |
| `.ytmp4 <link> [resolusi]` | Download a YouTube video (MP4) |
| `.ytmp3 <link>` | Download YouTube audio (MP3) |
| `.fb <link>` | Download a Facebook video |
| `.spotify <link>` | Download a Spotify track (with ID3 tags) |
| `.videy <link>` | Download a Videy video |
| `.pin <link>` | Download Pinterest media |
| `.tt <link>` | Download a TikTok video |
| `.ttpic <link>` | Download TikTok photos / slides |
| `.mediafire <link>` | Download a MediaFire file |
| `.github <link>` | Download a GitHub repo / folder |

### Checkers & searchers
| Command | Description |
| --- | --- |
| `.id <username>` | Look up a Telegram ID |
| `.telesearch <text>` | Search Telegram users / channels / groups |
| `.getchat <id/username>` | Export accessible chat history |
| `.ttsearch <query> <account\|vt>` | Search TikTok accounts or videos |

### Stalkers
`.ttstalker`, `.githubstalker`, `.robloxstalker`, `.igstalker`, `.xstalker`,
`.fbstalker`, `.pinstalker`, `.ytstalker`, and `.extrastalker <username>`
(checks 38 public platforms).

The API-backed stalkers (`.githubstalker`, `.pinstalker`, `.robloxstalker`,
`.ttstalker`, `.xstalker`, `.ytstalker`) prefer the Nexray REST API and fall
back to the bundled native scrapers where one exists.

### Converters
| Command | Description |
| --- | --- |
| `.stiker` / `.s` | Add an image to the `tenzu_stick` pack |
| `.toimg` | Convert a static sticker to PNG |
| `.togif` | Convert an animated/video sticker to GIF |
| `.tomp3` | Convert video/audio/voice to MP3 |
| `.toqr <text>` | Turn text into a QR code |
| `.tovn` | Convert audio/video to a voice note |

### AI
| Command | Description |
| --- | --- |
| `.ai <text>` | AI chat & coding assistant (Krynox, with fallback) |
| `.infobot` | Bot, owner, and uptime information |

### Broadcast (owner only)
| Command | Description |
| --- | --- |
| `.bcall <text>` | Send text to **every chat the account can post to** |
| `.bcall` | Reply to a message to broadcast its text/media to every chat |
| `.bcall add [chat]` | Pin a curated target list (overrides auto-discovery) |
| `.bcall del <chat>` | Remove a target chat |
| `.bcall list` | Show targets and blacklist |
| `.bcall stop` | Stop the running broadcast |
| `.delay <ms>` | Inter-message delay (minimum 1000 ms) |
| `.addbl [chat]` | Blacklist a chat so `.bcall` always skips it |

### Bot API 10.3 — Rich Messages

Rich Messages are implemented for real, not emulated with `parse_mode: "HTML"`.

### Transport

```
sendRichMessage  { chat_id, rich_message: { blocks }, reply_markup? }
editMessageText  { chat_id, message_id, rich_message: { blocks }, reply_markup? }
answerInlineQuery{ results: [{ type: "article", input_message_content:
                              { rich_message: { blocks } } }] }
```

`InputRichMessage` requires **exactly one** of `html` / `markdown` / `blocks`, so
`rich_transport.buildRichPayload()` always returns a single field (blocks when
available, HTML otherwise).

### Verified block shapes

| Block | Shape | Gotcha |
| --- | --- | --- |
| `paragraph` / `heading` / `footer` / `pre` | `{ type, text }` | `heading.size` 1–6 |
| `divider` | `{ type }` | alone → `RICH_MESSAGE_EMPTY` |
| `list` | `{ type, items: [{ blocks }] }` | `has_checkbox`/`is_checked` optional |
| `blockquote` | `{ type, blocks, credit? }` | `text` → `RICH_MESSAGE_EMPTY` |
| `expandable_blockquote` | `{ type, text, credit? }` | `blocks` → `RICH_MESSAGE_CONTENT_REQUIRED` |
| `pullquote` | `{ type, text, credit? }` | — |
| `details` | `{ type, summary, blocks }` | — |
| `table` | `{ type, cells: [[{ text }]] }` | bare string cell → rejected |
| `buttons` | `{ type, buttons: [RichMessageButton] }` | max 8 per row |
| `photo`/`video`/`audio`/`animation`/`voice_note`/`document` | `{ type, <kind>: { type, media }, caption?: { text } }` | `media` = HTTP(S) URL, `file_id`, or `attach://field` |

`credit` is plain **RichText**, not `{ text }` — wrapping it yields
`Can't find field "type"`.

### Capability probe

There is no feature flag in `getMe`, so `richTransport.supportsRichMessages()`
probes `sendRichMessage` once (a `400` proves the method exists, a `404` proves
it does not) and caches the answer. When unavailable, everything degrades to
`parse_mode: "HTML"` + `InlineKeyboardMarkup` automatically.

### The MTProto limitation (verified live)

A Rich Message reaches an MTProto **user** session as
`botInlineMessageRichMessage#a617e7b` (constructor `174161531`). GramJS 2.26.22
(layer 198, the latest release) ships **no `Rich*` types at all**, so
`tgReadObject` throws:

```
TypeNotFoundError: Could not find a matching Constructor ID ... 174161531
```

Consequences, handled explicitly:

- The **userbot can never read or relay** a rich message — only the bot can
  deliver one.
- The **inline path** would break, so `userbot.js` retries automatically: a rich
  query that fails to parse is re-sent with the `!` prefix, and `bot.js` answers
  with plain `InputTextMessageContent`. The connection stays usable
  (verified: `getMe` still works after the error).

`USERBOT_INLINE_MODE=text` skips the failed attempt entirely.

## `.start` — one command, every page

`.start` is delivered through **Inline Mode**: the bot posts the main menu
(HTML + native `InlineKeyboardMarkup` + `via @bot` marker) and every page or
category is reachable from the buttons attached to that single message.

```
.start
  └─ messages.getInlineBotResults(bot, peer, "menu")
       └─ answerInlineQuery  →  article "🤖 Menu Utama" (HTML + keyboard)
            └─ messages.sendInlineBotResult  →  posted as the bot, "via @bot"
                 └─ button tap → callback_query → editMessageText(inline_message_id)
```

| Button | Action |
| --- | --- |
| ⬇️ 🔍 🕵️ 🔧 🤖 📢 🗂️ | open that category page |
| `.command` | run that command through the userbot |
| ⬅️ / 🏠 Menu / ➡️ | move between pages (edits the same message) |
| ✖️ Tutup | close the menu |

`.start 1` … `.start 7` are **no longer needed or advertised**. The page argument
is still accepted for backwards compatibility, but nothing in the UI mentions it.
`.start all` remains available as a plain-text summary.

Because an inline message has no `callbackQuery.message`, navigation is applied
with `editMessageText(inline_message_id)`, so paging never creates duplicate
messages (verified: 8 navigations → 1 keyboard message).

Delivery order in `handlers/start.js` (first success wins):

1. **inline** — bot posts the menu, buttons stay native (preferred)
2. **bot** — bot sends the same HTML + keyboard into the chat
3. **bridge** — userbot relays the bot's reply (buttons become text)
4. **local** — userbot renders the identical HTML itself, with a hint

## Inline Mode (owner only)

```sh
.inline                       # status katalog + kesiapan Inline Mode
.inline add <judul> [#tag]    # reply ke teks/foto/video/dokumen/audio → simpan
.inline list [kata] [hal]     # lihat katalog (dengan pencarian & paginasi)
.inline show <id>             # detail satu item
.inline del <id>              # hapus item (+ media lokal)
.inline clear                 # kosongkan katalog
.inline upload [id|all]       # unggah media lokal ke Bot API → file_id
.inline send <id> [chat]      # kirim item sebagai bot (channel/grup)
.inline search <kata>         # uji mesin pencari inline
.inline owner <user_id>       # simpan owner id untuk proses Bot API
```

Setelah katalog terisi, di chat mana pun ketik `@usernamebot` lalu pilih
kontennya — Telegram mengirimnya **sebagai bot**, bukan sebagai akun userbot.

## Requirements

- **Node.js ≥ 18** (tested on 20 and 26).
  - On Node ≥ 22.5 the built-in `node:sqlite` is used.
  - On older runtimes it transparently falls back to the pure-WASM
    `node-sqlite3-wasm` driver — no native build required.
- **ffmpeg** available on `PATH`.
- A Telethon `userbot.session` (SQLite) and `session/config.json` with
  `api_id` / `api_hash`.

## Installation

```sh
git clone <repo> telegram-userbot
cd telegram-userbot

# Install dependencies into Termux-internal storage (see note below)
mkdir -p "$HOME/telegram-userbot-node_modules"
cp package.json "$HOME/telegram-userbot-node_modules/"
( cd "$HOME/telegram-userbot-node_modules" && npm install --no-bin-links --ignore-scripts )
```

### Android / Termux note (native modules)

Android's SELinux policy forbids `dlopen()` of native addons stored on shared
storage (`/sdcard`). This project therefore keeps `node_modules` in
Termux-internal storage and redirects module resolution there at runtime via
[`native_bootstrap.js`](native_bootstrap.js), which is loaded before any native
dependency.

Set `USERBOT_NODE_MODULES` to override the location:

```sh
export USERBOT_NODE_MODULES="$HOME/telegram-userbot-node_modules/node_modules"
```

On a normal desktop/Linux host, a standard in-project `npm install` works and
`native_bootstrap.js` is a harmless no-op.

## Running

```sh
npm start        # node main.js
```

If the saved session has been revoked or expired, the bot falls back to an
interactive login (phone number + OTP + 2FA password) and persists the new
session back to the same SQLite file.

### Standalone inline bot + userbot (Rich Messages)

Two extra entry points implement the classic inline flow:

```sh
# terminal 1 — the bot answers inline queries with rich messages
export BOT_TOKEN="123456:ABC..."
npm run bot:inline        # node bot.js

# terminal 2 — the user account sends them
export TG_API_ID=12345
export TG_API_HASH=0123456789abcdef0123456789abcdef
export USERBOT_BOT=hanzgdbot
npm run userbot:login     # once: interactive login, saves session/userbot.session
npm run userbot:inline    # node userbot.js
```

Then, in any chat:

```
.bot status        # send the first inline result
.bot 2 menu        # send the second result
.botlist status    # list available results
```

`userbot.js` never uses the bot token — it talks to the bot purely over MTProto
(`messages.getInlineBotResults` → `messages.sendInlineBotResult`).

## Bot API ⇄ Userbot bridge

`.start` is answered by the **Bot API**, and the userbot relays the result to
whoever ran the command.

```
user ─".start"─> userbot ─"/start" (MTProto)─> @bot
                                                 │
                                         Bot API reply
                                                 │
user <──text + buttons + media── userbot bridge ─┘
```

Run the companion bot process alongside the userbot:

```sh
npm start     # userbot (MTProto)
npm run bot   # Bot API companion — answers /start, /menu, /id
```

### Why this architecture (verified live)

| Bot API call | What a userbot session actually receives |
| --- | --- |
| `sendMessage` + `parse_mode: HTML` | text + entities + `ReplyInlineMarkup` ✅ |
| `sendMessage` + `inline_keyboard` | buttons readable via `msg.replyMarkup` ✅ |
| `sendPhoto` / `sendDocument` | `MessageMediaPhoto` + caption ✅ |
| `sendRichMessage` | `MessageMediaUnsupported` ❌ |

`sendRichMessage` is a bot-client feature: a **user** session receives it as
unsupported media, so it can be neither read nor relayed. The bridge therefore
uses `sendMessage` + HTML + `reply_markup`, the richest form a user session can
receive and re-send.

Replies are captured over **MTProto**, not `getUpdates` — `getUpdates` returns
only messages *sent to* the bot, which would echo our own command and loop.

### Fidelity and safety

- **Text/entities** → converted to the MTProto HTML subset (bold, italic,
  underline, strike, code, pre, spoiler, links, blockquote).
- **Inline buttons** → a user account cannot attach an `inline_keyboard`, so
  buttons are rendered *inside the text*: URL → real link, callback → label +
  payload, copy → `<code>` (tap to select).
- **Media** → downloaded from the Bot API and re-uploaded with the formatted
  caption.
- **Routing** → each forwarded command is bound to the chat that issued it, so
  replies always return to the right user.
- **No loops/duplicates** → outgoing messages, non-bot senders and bare `/`
  commands are ignored; bot message ids are deduplicated; one reply per
  pending command; per-user cooldown.

## Bot API 10.3 — Rich Messages

Rich Messages are implemented for real, not emulated with `parse_mode: "HTML"`.

### Transport

```
sendRichMessage  { chat_id, rich_message: { blocks }, reply_markup? }
editMessageText  { chat_id, message_id, rich_message: { blocks }, reply_markup? }
answerInlineQuery{ results: [{ type: "article", input_message_content:
                              { rich_message: { blocks } } }] }
```

`InputRichMessage` requires **exactly one** of `html` / `markdown` / `blocks`, so
`rich_transport.buildRichPayload()` always returns a single field (blocks when
available, HTML otherwise).

### Verified block shapes

| Block | Shape | Gotcha |
| --- | --- | --- |
| `paragraph` / `heading` / `footer` / `pre` | `{ type, text }` | `heading.size` 1–6 |
| `divider` | `{ type }` | alone → `RICH_MESSAGE_EMPTY` |
| `list` | `{ type, items: [{ blocks }] }` | `has_checkbox`/`is_checked` optional |
| `blockquote` | `{ type, blocks, credit? }` | `text` → `RICH_MESSAGE_EMPTY` |
| `expandable_blockquote` | `{ type, text, credit? }` | `blocks` → `RICH_MESSAGE_CONTENT_REQUIRED` |
| `pullquote` | `{ type, text, credit? }` | — |
| `details` | `{ type, summary, blocks }` | — |
| `table` | `{ type, cells: [[{ text }]] }` | bare string cell → rejected |
| `buttons` | `{ type, buttons: [RichMessageButton] }` | max 8 per row |
| `photo`/`video`/`audio`/`animation`/`voice_note`/`document` | `{ type, <kind>: { type, media }, caption?: { text } }` | `media` = HTTP(S) URL, `file_id`, or `attach://field` |

`credit` is plain **RichText**, not `{ text }` — wrapping it yields
`Can't find field "type"`.

### Capability probe

There is no feature flag in `getMe`, so `richTransport.supportsRichMessages()`
probes `sendRichMessage` once (a `400` proves the method exists, a `404` proves
it does not) and caches the answer. When unavailable, everything degrades to
`parse_mode: "HTML"` + `InlineKeyboardMarkup` automatically.

### The MTProto limitation (verified live)

A Rich Message reaches an MTProto **user** session as
`botInlineMessageRichMessage#a617e7b` (constructor `174161531`). GramJS 2.26.22
(layer 198, the latest release) ships **no `Rich*` types at all**, so
`tgReadObject` throws:

```
TypeNotFoundError: Could not find a matching Constructor ID ... 174161531
```

Consequences, handled explicitly:

- The **userbot can never read or relay** a rich message — only the bot can
  deliver one.
- The **inline path** would break, so `userbot.js` retries automatically: a rich
  query that fails to parse is re-sent with the `!` prefix, and `bot.js` answers
  with plain `InputTextMessageContent`. The connection stays usable
  (verified: `getMe` still works after the error).

`USERBOT_INLINE_MODE=text` skips the failed attempt entirely.

## Inline Mode

The owner types `@usernamebot <keyword>` in any chat, picks a catalogue entry,
and Telegram delivers it **as the bot**. This is a Bot API feature, so it lives
in the companion process — the userbot's MTProto session is not involved in the
delivery (it is only used to *collect* the content).

```
owner ─reply media─> userbot  .inline add <judul>
                        │ downloadMedia (MTProto)
                        │ upload → file_id (Bot API)
                        ▼
              session/inline_catalog.json
                        │
owner ─"@bot promo"─> Telegram ─inline_query─> bot_api_server
                        │ catalog.search()      │
                        ▼                        ▼
                 answerInlineQuery ────────> owner memilih hasil
                                                 │
                                    Telegram mengirim konten SEBAGAI BOT
```

### Supported result types

| Katalog | `type` inline result | Field Bot API |
| --- | --- | --- |
| teks | `article` | `InputTextMessageContent` |
| foto | `photo` | `photo_file_id` + caption |
| video | `video` | `video_file_id` + caption |
| dokumen | `document` | `document_file_id` + caption |
| audio | `audio` | `audio_file_id` + `audio_title` |
| animasi/GIF | `gif` | `gif_file_id` + caption |
| voice note | `voice` | `voice_file_id` + caption |

Media is uploaded **once**; the returned `file_id` is cached in the catalogue, so
inline answers never re-upload. Un-uploaded items show a placeholder telling the
owner to run `.inline upload <id>` instead of returning a broken result.

### Search

`catalog.search(query)` supports:

| Syntax | Meaning |
| --- | --- |
| `promo` | match title (weight 12/8/6) → tag (5/3) → body (2) → description (1) |
| `promo diskon` | AND semantics — every term must match |
| `#promo` | tag filter |
| `type:foto`, `type:video`, `type:dokumen`, `type:audio`, `type:gif`, `type:voice`, `type:teks` | media-type filter |
| `foto` (single media word) | treated as `type:photo` |
| `promo -lama` | exclusion |
| *(empty)* | browse everything, newest first |

### Access control (owner only)

Inline results are **personal**:

- `ownerIds()` comes from `USERBOT_OWNER_ID` and `session/config.json → owner_id`
  (written automatically at userbot login by `saveOwnerId(me.id)`).
- A non-owner query gets an empty answer (`is_personal: true`, `cache_time: 0`) —
  no titles, no counts, no hints. An empty owner list denies **everyone**
  (fail closed).
- `.inline` is in `SENSITIVE_COMMANDS`, so the userbot refuses it for other
  users even before the handler runs, and `requireOwner()` checks again.

### Rate limits and testing

| Context | Behaviour |
| --- | --- |
| private chat | works; the selected result is delivered as the bot |
| group | works if the bot is a member (or the owner uses it from their own side) |
| channel | works when the owner has permission to post there; the message is attributed to the bot |
| non-owner | silently empty result set |

Telegram drops `answerInlineQuery` calls that arrive late, so answers are built
from the local catalogue and sent in a single request (verified round-trip
≈400–700 ms). `chosen_inline_result` is logged for auditing; delivery is done by
Telegram, not by this project.

```sh
npm run bot        # start the Bot API process (menu + inline)
npm test           # unit/integration tests (no network)
```

## Permissions

Commands are authorized centrally in `utils/permissions.js` (deny by default):

| Level | Commands | Who |
| --- | --- | --- |
| `public` | downloads, search, stalkers, converters, `.start`, `.infobot` | anyone, behind a per-user cooldown (`USERBOT_PUBLIC_COOLDOWN_MS`, default 3 s) |
| `owner` | `.bcall`, `.delay`, `.addbl`, `.getchat`, `.stiker`, `.s`, `.ai`, `.id`, `.telesearch`, `.inline`, and any unknown command | account owner only |

The owner is the logged-in account plus any id in `USERBOT_OWNER_ID` or
`session/config.json` → `owner_id`. Refused commands get a single rate-limited
"Access denied" notice per chat.

## Broadcast target resolution

`.bcall` sends to **every chat the userbot can actually post to**, discovered
from the account's dialog list (`utils/chat_discovery.js`) rather than a manual
registry. Dialogs that Telegram would reject are filtered out before queueing:

| Skipped | Reason |
| --- | --- |
| the account itself | cannot message yourself |
| bots | bots cannot receive user messages |
| deleted accounts | peer unreachable |
| left / deactivated groups | no longer a member |
| groups with `sendMessages` banned | muted for this account |
| broadcast channels without admin rights | read-only for non-admins |

On a real account this scanned **545 dialogs → 408 eligible** (343 supergroups,
60 users, 5 channels), correctly rejecting 33 bots, 30 deleted accounts, 28
muted groups and 43 read-only channels.

If `.bcall add` has entries, that curated list is used instead — an explicit
opt-in for targeted sends. Blacklisted chats are always skipped.

## Broadcast safety

`.bcall` is built around `utils/broadcast_queue.js`:

- **Queue** — targets are delivered sequentially with a fixed inter-message gap
  (`.delay`, floor 1000 ms) so the account is never pushed into `FLOOD_WAIT`.
- **Flood handling** — `FLOOD_WAIT_X` is honoured by sleeping; after 3
  consecutive floods (or a wait longer than 300 s) the run aborts on its own.
- **Per-chat isolation** — one failing chat never aborts the run; every result
  is recorded and summarized.
- **Progress & stop** — the placeholder message is edited in place (throttled)
  and `.bcall stop` cancels cooperatively after the in-flight message.
- **No duplicates** — identical content is suppressed for 10 minutes, target
  lists are de-duplicated, and blacklisted chats are skipped before queueing
  (and re-checked mid-run).
- **Bounded** — at most 200 chats per run (`USERBOT_BCALL_MAX_TARGETS`).

State is persisted atomically to `session/broadcast.json`.

## Architecture

```
main.js                 Entry point + handler registration + login/keep-alive
bot_api_server.js       Bot API companion (/start, /menu, /id, /inline, Inline Mode)
bot.js                  Standalone inline bot (Rich Messages, Bot API 10.3)
userbot.js              MTProto userbot: sends the bot's rich message inline
native_bootstrap.js     Redirects native-addon resolution to internal storage
config.js               Configuration (limits, paths, api credentials, BOT_TOKEN)

handlers/               One module per feature; each exports register(client)
  start, youtube, facebook, spotify, videy, pinterest, tiktok, ttpic,
  mediafire, github, telegram_tools, tiktok_search, getchat,
  social_stalker, sticker, sticker_tgs, converter, ai, infobot,
  broadcast, inline

downloaders/            Media/API clients (no Telegram coupling)
  youtube_engine.js     Custom VISIONOS Innertube client (replaces yt-dlp)
  youtube.js, engine.js shared download/merge/ffmpeg helpers
  nexray.js             Nexray REST API client (downloader + stalker endpoints)
  facebook, pinterest, mediafire, github, tiktok, tiktok_search,
  spotify, videy, social_stalker

utils/
  http.js               aiohttp-style HTTP client (undici/fetch)
  sqlite.js             Portable SQLite driver (node:sqlite → node-sqlite3-wasm)
  tl_session.js         SQLiteSession — reads/writes the Telethon session
  telegram.js           Telethon-style compat layer over GramJS
  rich_message.js       Rich Message engine (blocks, text, buttons, renderers)
  formatting.js         Rich Message design system + edit/send wrappers
  permissions.js        Per-command authorization (owner / public + cooldown)
  broadcast_store.js    Persistent targets, blacklist and delay (.bcall)
  broadcast_queue.js    Delivery queue, flood handling, stop, duplicates
  chat_discovery.js     Enumerates every chat the account can post to
  bot_bridge.js         Two-way Bot API <-> userbot relay (no loops)
  bot_api.js            Dependency-free Bot API client (JSON + multipart)
  rich_transport.js     Bot API 10.3 Rich Messages (send/edit/inline, probe)
  menu.js               Shared menu catalogue: HTML + Rich blocks + keyboard
  menu_delivery.js      Rich-first delivery with HTML/bridge/local fallback
  menu_queue.js         Bot → userbot command queue (atomic claim)
  menu_inline.js        `.start` via Inline Mode (menu article + inline edits)
  inline_catalog.js     Inline catalogue: storage, search, pagination, stats
  inline_upload.js      MTProto media → Bot API upload (file_id cache)
  inline_bot.js         answerInlineQuery builder + owner gate
  progress.js           Throttled progress edits
  process.js            child_process / ffmpeg wrappers
  updates_poller.js     Catch-up + getDifference poller (fixes silent commands)
  logging.js            Rotating file logger
  activity_logging.js   Per-command PENDING/SUCCESS/FAILED logging
  download_logging.js, cleanup.js, helpers.js, downloader_common.js
```

### Notable implementation choices

- **Nexray REST API** (`downloaders/nexray.js`): `.ytmp3`, `.ytmp4`, `.spotify`
  and `.github` resolve a direct media URL from `https://api.nexray.eu.cc`,
  validate the JSON envelope (`status`/`result`), then stream the media to a
  temp file and upload it. The same client powers the API-backed stalker
  commands. If the API is unreachable the downloader commands transparently
  fall back to the bundled native engine, so a third-party outage never takes
  a feature down. Override the base URL with `NEXRAY_BASE_URL`.

- **YouTube** uses a bespoke **VISIONOS Innertube** client
  (`downloaders/youtube_engine.js`) instead of `yt-dlp`. It bootstraps
  `VISITOR_DATA` / `STS` / `INNERTUBE_API_KEY` from a watch page, needs no PO
  token, and supports search + size-aware format selection.
- **TGS → GIF** (`handlers/sticker_tgs.js`): `.tgs` is gunzipped, rendered to
  SVG per frame with `lottie-web` inside `jsdom`, rasterized with
  `@resvg/resvg-js`, and encoded with `ffmpeg`.
- **Update synchronisation** (`utils/updates_poller.js`): Telegram does not
  reliably *push* updates for messages the account itself sends — the very
  messages a userbot reacts to. GramJS's `catchUp()` is an empty stub, so the
  poller performs an initial `updates.getDifference` catch-up and then polls on
  a short interval, feeding results back through GramJS's `_handleUpdate`. This
  is what makes `.start` and every other command respond instead of silently
  doing nothing.
- **Rich Messages** (`utils/rich_message.js`): messages are described once as
  Rich Message blocks and rendered to `markdown`, `html`, `blocks`, and the
  legacy `parse_mode: "html"` form. Inline buttons use `RichTextButton`
  (`text.button(richButton(...))`) and never become `InlineKeyboardButton`s.
- **Telethon session reuse** (`utils/tl_session.js` + `utils/sqlite.js`): a
  GramJS `MemorySession` backed by the Telethon SQLite file, maintaining
  per-DC auth keys for media/export. The SQLite driver auto-selects
  `node:sqlite` (Node ≥ 22.5) or `node-sqlite3-wasm` (pure WASM, older Node).

## License

ISC

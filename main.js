#!/usr/bin/env node
"use strict";
/**
 * Telegram Userbot — main entry point.
 * Node.js port of `main.py`.
 */
const fs = require("node:fs");
const path = require("node:path");

// Must load first: redirects native-addon resolution to Termux-internal storage.
require("./native_bootstrap");

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const {
  SESSION_NAME,
  BOT_TOKEN,
  INLINE_ENABLED,
  loadConfig,
  saveConfig,
  saveOwnerId,
  validateUserCredentials,
  BOT_VERSION,
} = require("./config");
const { ensureTempDir } = require("./utils/cleanup");
const { installCommandLogging } = require("./utils/activity_logging");
const { SQLiteSession } = require("./utils/tl_session");
const { startUpdatesPoller } = require("./utils/updates_poller");

/** Interactive login mirroring `setup_login()`. */
async function setupLogin() {
  console.log("=".repeat(50));
  console.log("  Telegram Userbot - Setup Login");
  console.log("=".repeat(50));

  const cfg = loadConfig();
  let apiId = cfg.api_id;
  let apiHash = cfg.api_hash;

  if (apiId && apiHash) {
    // Never let a BotFather token sneak in as MTProto credentials: the two
    // protocols are unrelated and the login would fail with AUTH_KEY_INVALID.
    try {
      ({ apiId, apiHash } = validateUserCredentials(apiId, apiHash));
    } catch (err) {
      console.log(`⚠️  Config tidak valid: ${err.message}`);
      apiId = null;
      apiHash = null;
    }
  }

  if (!apiId || !apiHash) {
    console.log("\nDapatkan API ID & API Hash dari https://my.telegram.org\n");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      apiId = parseInt((await rl.question("Masukkan API ID: ")).trim(), 10);
      apiHash = (await rl.question("Masukkan API Hash: ")).trim();
    } finally {
      rl.close();
    }
    try {
      saveConfig(apiId, apiHash);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    console.log("✅ Config tersimpan.\n");
  } else {
    console.log(`\n✅ Config ditemukan (API ID: ${apiId})`);
  }

  return { apiId: Number(apiId), apiHash };
}

/** Interactive code/phone prompts used only when no valid session exists. */
function sessionPrompts() {
  return {
    phoneNumber: async () => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        return (await rl.question("Masukkan nomor telepon (contoh +628123456789): ")).trim();
      } finally {
        rl.close();
      }
    },
    password: async () => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        return (await rl.question("Masukkan password 2FA (kosongkan jika tidak ada): ")).trim();
      } finally {
        rl.close();
      }
    },
    phoneCode: async () => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        return (await rl.question("Masukkan kode OTP dari Telegram: ")).trim();
      } finally {
        rl.close();
      }
    },
    onError: (err) => {
      console.error(`❌ Login gagal: ${err.message}`);
    },
  };
}

function registerHandlers(client) {
  installCommandLogging(client);
  const modules = [
    "start",
    "youtube",
    "facebook",
    "spotify",
    "ai",
    "videy",
    "pinterest",
    "tiktok",
    "ttpic",
    "mediafire",
    "github",
    "telegram_tools",
    "tiktok_search",
    "getchat",
    "social_stalker",
    "sticker",
    "converter",
    "infobot",
    "broadcast",
    "inline",
  ];
  for (const name of modules) {
    let handlerModule;
    try {
      handlerModule = require(`./handlers/${name}`);
    } catch (err) {
      if (err.code === "MODULE_NOT_FOUND" && String(err.message).includes(`handlers/${name}`)) {
        console.warn(`⚠️  Handler ${name} belum tersedia: ${err.message.split("\n")[0]}`);
        continue;
      }
      throw err;
    }
    if (typeof handlerModule.register === "function") {
      handlerModule.register(client);
    }
  }
}

async function main() {
  ensureTempDir();

  const { apiId, apiHash } = await setupLogin();

  fs.mkdirSync(path.dirname(SESSION_NAME), { recursive: true });

  const session = new SQLiteSession(SESSION_NAME);
  await session.load();

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    useWSS: false,
    retryDelay: 1000,
    autoReconnect: true,
  });

  console.log("🔐 Menghubungkan ke Telegram...");
  await client.connect();
  // Detect a revoked/expired saved session and fall back to interactive login.
  let needsLogin = true;
  try {
    await client.getMe();
    needsLogin = false;
  } catch (err) {
    const message = String(err && err.message);
    if (/SESSION_REVOKED|AUTH_KEY_UNREGISTERED|SESSION_EXPIRED|USER_DEACTIVATED/.test(message)) {
      console.log("⚠️  Sesi tersimpan sudah tidak berlaku, silakan login ulang.");
      needsLogin = true;
    } else {
      throw err;
    }
  }

  if (needsLogin) {
    await client.start(sessionPrompts());
  }

  const me = await client.getMe();
  // Record the owner identity so `utils/permissions.js` can distinguish the
  // account owner from other users who send commands to the bot.
  try {
    require("./utils/permissions").setOwner(client, me);
  } catch {
    /* permissions module is optional at boot */
  }
  // Persist the numeric owner id: the *separate* Bot API process (`npm run bot`)
  // has no MTProto session, so this is how Inline Mode learns who the owner is.
  try {
    saveOwnerId(me.id);
  } catch {
    /* a read-only config must not block login */
  }
  console.log(`\n✅ Login berhasil sebagai: ${me.firstName} (@${me.username || "N/A"})`);
  console.log(`📱 Userbot versi ${BOT_VERSION}`);
  // Two-way Bot API bridge: the userbot relays commands to @bot and forwards
  // the bot's replies (text, media, buttons) back to the requesting user.
  try {
    const bridge = require("./utils/bot_bridge").createBridge(client, { log: true });
    const attached = await bridge.attach();
    if (attached) {
      console.log(`🌉 Bridge Bot API aktif: @${bridge.botUsername} (dua arah)`);
    }
  } catch (err) {
    console.log(`🌉 Bridge Bot API tidak aktif: ${err.message}`);
  }

  // Rich Message renderer status (Bot API token is a renderer only — replies
  // are still delivered by the userbot account).
  try {
    const status = await require("./utils/formatting").botApiStatus();
    if (status.enabled) {
      console.log(`🖼️  Rich Message renderer: Bot API @${status.username || "?"} (${status.transport})`);
    } else {
      console.log(`🖼️  Rich Message renderer: lokal (${status.reason})`);
    }
  } catch {
    /* status reporting must never block startup */
  }

  // Inline Mode status: the catalogue lives here, the query answering happens in
  // the Bot API process. Report both so a missing token / owner id is obvious.
  try {
    const catalog = require("./utils/inline_catalog");
    const stats = catalog.stats();
    console.log(`🗂️  Katalog inline: ${stats.total} item (${stats.uploaded} siap, ${stats.pending} belum diunggah)`);
    if (!INLINE_ENABLED) {
      console.log("⚡ Inline Mode dimatikan (INLINE_ENABLED=0).");
    } else if (!BOT_TOKEN) {
      console.log("⚡ Inline Mode butuh BOT_TOKEN — set di environment atau .env.");
    } else {
      const botApi = require("./utils/bot_api");
      const verified = await botApi.verifyToken(BOT_TOKEN);
      if (!verified.ok) {
        console.log(`⚡ Token Bot API tidak valid: ${verified.reason}`);
      } else {
        const caps = botApi.capabilities(verified.me);
        console.log(
          `⚡ Inline Mode: @${caps.username} ${caps.inline ? "✅ aktif" : "❌ belum aktif (BotFather → /setinline)"}`,
        );
        if (!caps.inline) {
          console.log("   Aktifkan dengan @BotFather → /setinline.");
        }
      }
    }
  } catch (err) {
    console.log(`⚡ Status inline tidak tersedia: ${err.message}`);
  }

  console.log(`\n🤖 Userbot aktif! Ketik .start di chat Telegram mana saja.`);
  console.log("   Tekan Ctrl+C untuk berhenti.\n");

  registerHandlers(client);

  // Telegram does not reliably *push* updates for messages this account sends
  // (which is what a userbot reacts to), so we also drain
  // `updates.getDifference` on a short interval and feed the results back into
  // GramJS. Without this, commands like `.start` appear to do nothing.
  const poller = startUpdatesPoller(client, { log: true });

  // Native menu buttons are answered by the Bot API, which cannot execute
  // userbot commands itself. It enqueues them; this worker sends the command
  // text into the requesting chat so the handlers above run it for real.
  let menuQueueWorker = null;
  try {
    menuQueueWorker = require("./handlers/start").startMenuQueue(client, { log: true });
  } catch (err) {
    console.log(`🎛️  Menu queue tidak aktif: ${err.message}`);
  }

  process.on("SIGINT", async () => {
    console.log("\n👋 Userbot dihentikan.");
    try {
      poller.stop();
    } catch {
      /* ignore */
    }
    try {
      if (menuQueueWorker) menuQueueWorker.stop();
    } catch {
      /* ignore */
    }
    try {
      const bridge = require("./utils/bot_bridge").getBridge();
      if (bridge) bridge.detach();
    } catch {
      /* ignore */
    }
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  // Keep the process alive while GramJS runs its update loop.
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, registerHandlers, setupLogin };

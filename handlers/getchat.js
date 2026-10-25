'use strict';

/** Export accessible Telegram history for `.getchat <id/username>`. */

const fs = require('node:fs');
const path = require('node:path');

const {
  copyField,
  Api } = require('telegram');

const { MAX_FILE_SIZE, TEMP_DIR } = require('../config');
const { cleanupFile, ensureTempDir } = require('../utils/cleanup');
const {
  editMarkdown,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  formatMessage,
  formatRichMessage,
  rateLimitMessage,
  inlineCode,
  sendFileMarkdown,
  statusMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { sanitizeFilename } = require('../utils/helpers');
const { command, chatId } = require('../utils/telegram');

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const ITERATION_TIMEOUT = 60_000;
const OUTPUT_LIMIT = MAX_FILE_SIZE - 1024 * 1024;
const PROGRESS_INTERVAL = 4;

class GetChatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GetChatError';
  }
}
class OutputTooLarge extends GetChatError {}

function parseTarget(raw) {
  const value = String(raw).trim();
  if (!value) throw new GetChatError('Masukkan Telegram ID atau username');
  if (/^-?\d+$/.test(value)) {
    const targetId = Number(value);
    if (targetId === 0) throw new GetChatError('Telegram ID tidak valid');
    return targetId;
  }
  const username = value.replace(/^@/, '').trim();
  if (!USERNAME_RE.test(username)) {
    throw new GetChatError('Username harus 4–32 karakter dan hanya berisi huruf, angka, atau underscore');
  }
  return username;
}

function entityName(entity) {
  if (typeof entity === 'number') return String(entity);
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || 'Private Chat';
  }
  return entity.title || entity.username || 'Unknown Chat';
}

function chatType(entity) {
  if (typeof entity === 'number') return 'User ID';
  if (entity instanceof Api.User) return entity.bot ? 'Bot' : 'Private Chat';
  if (entity instanceof Api.Channel) return entity.broadcast ? 'Channel' : 'Supergroup';
  if (entity instanceof Api.Chat) return 'Group';
  return 'Unknown';
}

function markedId(entity) {
  if (typeof entity === 'number') return entity;
  const { getPeerId } = require('telegram/Utils');
  try {
    if (typeof getPeerId === 'function') return Number(getPeerId(entity));
  } catch {
    /* ignore */
  }
  return Number(entity.id);
}

function messageLink(entity, messageId) {
  const username = entity.username;
  if (username) return `https://t.me/${username}/${messageId}`;
  if (entity instanceof Api.Channel) {
    return `https://t.me/c/${entity.id}/${messageId}`;
  }
  return 'Unavailable';
}

function senderName(sender) {
  if (!sender) return 'Unavailable';
  if (sender.username) return `@${sender.username}`;
  return entityName(sender);
}

function utcStamp(date) {
  if (!date) return 'Unavailable';
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

function record(chat, message, sender) {
  let text = message.message || '';
  const bodyLabel = message.media && text ? 'Caption' : 'Message';
  if (!text) text = message.media ? '[Media/non-text message]' : '[Empty message]';
  return (
    '--- MESSAGE ---\n' +
    `Message ID: ${message.id}\n` +
    `Sender: ${senderName(sender)}\n` +
    `Sender ID: ${message.senderId || 'Unavailable'}\n` +
    `Date: ${utcStamp(message.date)}\n` +
    `Link: ${messageLink(chat, message.id)}\n\n` +
    `${bodyLabel}:\n${text}\n\n` +
    '========================================\n\n'
  );
}

function chatHeader(chat) {
  return (
    '=== CHAT ===\n' +
    `Name: ${entityName(chat)}\n` +
    `Type: ${chatType(chat)}\n` +
    `Chat ID: ${markedId(chat)}\n\n`
  );
}

function safeFilename(raw) {
  const value = String(raw).trim().replace(/^@/, '');
  const safe = sanitizeFilename(value, 50).replaceAll(' ', '_') || 'target';
  return `getchat_${safe}.txt`;
}

async function next(iterator) {
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new GetChatError('Telegram timeout saat membaca riwayat pesan')), ITERATION_TIMEOUT),
      ),
    ]);
  } catch (err) {
    if (err instanceof GetChatError) throw err;
    throw err;
  }
}

async function resolveTarget(client, parsed, dialogs) {
  if (typeof parsed === 'string') {
    try {
      return await client.getEntity(parsed);
    } catch (err) {
      throw new GetChatError('Username tidak ditemukan atau tidak dapat diakses');
    }
  }

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (parsed === Number(entity.id) || parsed === markedId(entity)) {
      return entity;
    }
  }
  try {
    return await client.getEntity(parsed);
  } catch {
    if (parsed > 0) return parsed;
    throw new GetChatError(
      'ID chat/channel tidak ditemukan pada dialog yang dapat diakses session',
    );
  }
}

async function loadDialogs(client) {
  const dialogs = [];
  for await (const dialog of client.iterDialogs({ limit: undefined })) {
    dialogs.push(dialog);
  }
  return dialogs;
}

function writeText(fd, text, written) {
  const encoded = Buffer.from(String(text), 'utf8');
  if (written + encoded.length > OUTPUT_LIMIT) {
    throw new OutputTooLarge(
      `Hasil melebihi batas aman \`${Math.floor(OUTPUT_LIMIT / 1024 / 1024)} MB\`; export dihentikan agar file dapat dikirim`,
    );
  }
  fd.write(encoded);
  return written + encoded.length;
}

function isFloodWait(err) {
  return /FLOOD_WAIT_(\d+)/.test(err.message || '');
}
function floodSeconds(err) {
  const m = /FLOOD_WAIT_(\d+)/.exec(err.message || '');
  return m ? m[1] : '0';
}

async function collectHistory(client, target, dialogs, filepath, progressCb) {
  const isResolvedUser = target instanceof Api.User;
  const isNumericUser = typeof target === 'number';
  const searchAllDialogs = isResolvedUser || isNumericUser;
  let candidates = searchAllDialogs
    ? dialogs
    : [dialogs.find((d) => Number(d.entity.id) === Number(target.id))];
  if (!searchAllDialogs && !candidates[0]) candidates = [target];

  let chatsProcessed = 0;
  let messagesFound = 0;
  const inaccessible = [];
  let truncated = false;
  let written = 0;
  let lastProgress = 0;

  const fd = fs.openSync(filepath, 'w');

  const intro =
    'GETCHAT TELEGRAM HISTORY EXPORT\n' +
    `Target: ${entityName(target)} (${markedId(target)})\n` +
    'Scope: Only chats and history accessible to this Telegram session.\n\n';
  written = writeText(fd, intro, written);

  try {
    for (const candidate of candidates) {
      const chat = candidate && candidate.entity ? candidate.entity : candidate;
      try {
        let chatMessages = 0;
        let headerWritten = false;
        const iterator = client
          .iterMessages(chat, {
            limit: undefined,
            fromUser: isResolvedUser ? target : undefined,
            waitTime: 1,
          })
          [Symbol.asyncIterator]();

        while (true) {
          const step = await next(iterator);
          if (step.done) break;
          const message = step.value;
          if (isNumericUser && Number(message.senderId) !== Number(target)) continue;
          if (!headerWritten) {
            written = writeText(fd, chatHeader(chat), written);
            headerWritten = true;
            chatsProcessed += 1;
          }
          let sender = null;
          try {
            sender = await message.getSender();
          } catch {
            sender = null;
          }
          written = writeText(fd, record(chat, message, sender), written);
          chatMessages += 1;
          messagesFound += 1;

          const now = Date.now();
          if (now - lastProgress >= PROGRESS_INTERVAL * 1000) {
            await progressCb(chatsProcessed, messagesFound);
            lastProgress = now;
          }
        }
      } catch (err) {
        if (err instanceof OutputTooLarge) {
          truncated = true;
          break;
        }
        if (isFloodWait(err)) {
          inaccessible.push(`${entityName(chat)}: rate limited (${floodSeconds(err)}s)`);
        } else if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN/.test(err.message || '')) {
          inaccessible.push(`${entityName(chat)}: history inaccessible/permission denied`);
        } else {
          inaccessible.push(`${entityName(chat)}: unavailable (${String(err.message).slice(0, 120)})`);
        }
      }
    }

    let summary =
      '\n=== SUMMARY ===\n' +
      `Total messages: ${messagesFound}\n` +
      `Total chats: ${chatsProcessed}\n` +
      `Inaccessible/unavailable: ${inaccessible.length}\n` +
      `Truncated by file limit: ${truncated ? 'Yes' : 'No'}\n`;
    if (inaccessible.length) {
      summary +=
        '\nSkipped chats:\n' +
        inaccessible.slice(0, 100).map((item) => `- ${item}`).join('\n') +
        '\n';
    }
    try {
      writeText(fd, summary, written);
    } catch (err) {
      if (!(err instanceof OutputTooLarge)) throw err;
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    messages: messagesFound,
    chats: chatsProcessed,
    inaccessible: inaccessible.length,
    truncated,
  };
}

function register(client) {
  command(client, /^\.getchat(?:\s+(.+))?$/, async (event) => {
    const raw = event.patternMatch.group(1) || '';
    let parsed;
    try {
      parsed = parseTarget(raw);
    } catch (err) {
      await editMarkdown(
        event,
        errorMessage(err.message, 'Target Tidak Valid'),
      );
      return;
    }

    await editMarkdown(event, statusMessage('Sedang mencari riwayat pesan...'));
    let filepath = null;
    try {
      const dialogs = await loadDialogs(client);
      const target = await resolveTarget(client, parsed, dialogs);
      const filename = safeFilename(raw);
      ensureTempDir();
      filepath = path.join(TEMP_DIR, filename);

      const progress = async (chats, messages) => {
        try {
          await editMarkdown(
            event,
            formatMessage({
              title: '⏳ Sedang Mencari Riwayat Pesan',
              details: [
                `<b>🔎 Chat ditemukan:</b> ${inlineCode(chats)}`,
                `<b>💬 Pesan ditemukan:</b> ${inlineCode(messages)}`,
              ],
            }),
          );
        } catch {
          /* ignore throttling errors */
        }
      };

      const result = await collectHistory(client, target, dialogs, filepath, progress);
      if (!result.messages) {
        await editMarkdown(
          event,
          errorMessage(
            `Tidak ada pesan target pada history yang dapat diakses session ini. (inaccessible: ${result.inaccessible})`,
            'Tidak Ada Pesan Ditemukan',
          ),
        );
        return;
      }

      await editMarkdown(event, statusMessage('Sedang membuat file...', '📦'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: formatRichMessage({
          title: '✅ GetChat Selesai',
          details: [
            `<b>💬 Total pesan:</b> ${inlineCode(result.messages)}`,
            `<b>🔎 Total chat:</b> ${inlineCode(result.chats)}`,
            `<b>⚠️ Inaccessible/unavailable:</b> ${inlineCode(result.inaccessible)}`,
            `<b>Terpotong batas ukuran:</b> ${inlineCode(result.truncated ? 'Ya' : 'Tidak')}`,
          ],
          blocks: [
            copyField('Nama file', filename),
          ],
          note: 'Hanya history yang dapat diakses oleh session Telegram ini.',
        }),
        attributes: [new Api.DocumentAttributeFilename({ fileName: filename })],
        forceDocument: true,
      });
      await editMarkdown(
        event,
        formatRichMessage({
          title: '✅ Selesai',
          details: [
            `<b>💬 Total pesan:</b> ${inlineCode(result.messages)}`,
            `<b>🔎 Total chat:</b> ${inlineCode(result.chats)}`,
            `<b>📄 File:</b> ${inlineCode(filename)}`,
          ],
          blocks: [copyField('Nama file', filename)],
        }),
      );
    } catch (err) {
      if (isFloodWait(err)) {
        await editMarkdown(
          event,
          rateLimitMessage(floodSeconds(err), { action: '.getchat' }),
        );
      } else if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/.test(err.message || '')) {
        await editMarkdown(
          event,
          errorMessage('Chat atau history tidak dapat diakses oleh session ini', 'Akses Ditolak'),
        );
      } else if (err instanceof GetChatError) {
        await editMarkdown(event, errorMessage(err.message, 'GetChat Gagal'));
      } else if (/timeout/i.test(err.message || '')) {
        await editMarkdown(event, errorMessage('Telegram tidak merespons tepat waktu', 'GetChat Timeout'));
      } else if (err.code === 'ENOENT' || err.code === 'EACCES') {
        await editMarkdown(
          event,
          errorMessage(`Gagal membuat atau mengirim file: ${err.message}`, 'File Error'),
        );
      } else {
        await editMarkdown(
          event,
          errorMessage('Terjadi kesalahan internal saat mengumpulkan history', 'GetChat Gagal'),
        );
      }
    } finally {
      cleanupFile(filepath);
    }
  });
}

module.exports = { register, parseTarget, safeFilename };

'use strict';

/** Asynchronous media converters: image, GIF, MP3, QR, voice note. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  copyField,
  Api, utils: tlUtils } = require('telegram');

const { MAX_FILE_SIZE, TEMP_DIR } = require('../config');
const { markActivityFailed } = require('../utils/activity_logging');
const { cleanupFile, ensureTempDir } = require('../utils/cleanup');
const {
  editMarkdown,
  errorMessage,
  exampleButton,
  statusMessage,
  sendFileMarkdown,
  successMessage,
  formatRichMessage,
  inlineCode,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { runProcess } = require('../utils/process');
const { command, chatId, filenameAttribute } = require('../utils/telegram');

const CONVERT_TIMEOUT = 180;
const MAX_DURATION = 15 * 60;
const MAX_GIF_DURATION = 30;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif']);
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']);
const AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/wav',
  'audio/flac',
  'audio/aac',
]);

function mime(message) {
  return (message && message.document && message.document.mimeType) || '';
}

function attributes(message) {
  return (message && message.document && message.document.attributes) || [];
}

function attribute(message, kind) {
  return attributes(message).find((item) => item instanceof kind) || null;
}

function size(message) {
  return (message && message.document && Number(message.document.size)) || 0;
}

function duration(message) {
  const attr =
    attribute(message, Api.DocumentAttributeVideo) || attribute(message, Api.DocumentAttributeAudio);
  return Number((attr && attr.duration) || 0);
}

function isImage(message) {
  return Boolean(message && (message.photo || IMAGE_MIMES.has(mime(message))));
}

function isVideo(message) {
  if (!message) return false;
  return Boolean(
    message.video ||
      mime(message).startsWith('video/') ||
      VIDEO_MIMES.has(mime(message)) ||
      attribute(message, Api.DocumentAttributeVideo),
  );
}

function isAudio(message) {
  if (!message) return false;
  return Boolean(
    message.audio ||
      message.voice ||
      mime(message).startsWith('audio/') ||
      AUDIO_MIMES.has(mime(message)) ||
      attribute(message, Api.DocumentAttributeAudio),
  );
}

function stickerKind(message) {
  if (!message || !message.sticker) return null;
  const value = mime(message).toLowerCase();
  if (value === 'application/x-tgsticker') return 'tgs';
  if (value.startsWith('video/') || value === 'video/webm') return 'video';
  if (value === 'image/webp' || value === 'image/png' || value === '') return 'static';
  return null;
}

function validateLimits(message, maxDuration = MAX_DURATION) {
  if (size(message) > MAX_FILE_SIZE) {
    throw new Error(`Media melebihi batas ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)} MB`);
  }
  const value = duration(message);
  if (value > maxDuration) {
    throw new Error(`Durasi media melebihi batas ${Math.floor(maxDuration / 60)} menit`);
  }
}

async function replyMessage(event) {
  if (!event.replyTo && event.replyToMsgId == null) return null;
  try {
    return await event.message.getReplyMessage();
  } catch {
    return null;
  }
}

async function sourceMedia(event, predicate, replyOnly = false) {
  const reply = await replyMessage(event);
  if (reply && predicate(reply)) return reply;
  if (replyOnly) return null;
  return predicate(event.message) ? event.message : null;
}

async function run(...argv) {
  let result;
  try {
    result = await runProcess(argv[0], argv.slice(1), { timeout: CONVERT_TIMEOUT * 1000 });
  } catch (err) {
    if (err && err.message && /ENOENT/.test(err.message)) {
      throw new Error(`Converter \`${argv[0]}\` belum terpasang`);
    }
    throw err;
  }
  if (result.code !== 0) {
    const lines = String(result.stderr || '').trim().split('\n').filter(Boolean);
    const reason = lines.length ? lines[lines.length - 1] : 'Converter gagal';
    throw new Error(reason.slice(0, 200));
  }
}

async function download(client, message, target) {
  const result = await Promise.race([
    client.downloadMedia(message, { outputFile: target }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Media gagal diunduh')), CONVERT_TIMEOUT * 1000)),
  ]);
  const out = typeof result === 'string' ? result : target;
  if (!out || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('Media gagal diunduh');
  }
  return out;
}

async function convertJob(client, event, sourceMessage, suffix, convert, sendKwargs = {}) {
  ensureTempDir();
  const token = crypto.randomBytes(16).toString('hex');
  let source = path.join(TEMP_DIR, `convert_${token}_source`);
  const output = path.join(TEMP_DIR, `convert_${token}${suffix}`);
  try {
    source = await download(client, sourceMessage, source);
    await convert(source, output);
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error('File hasil konversi kosong');
    }
    await sendFileMarkdown(client, chatId(event), output, {
      replyTo: event.replyToMsgId,
      ...sendKwargs,
    });
    if (event.out) {
      try {
        await event.message.delete({ revoke: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanupFile(source, output);
  }
}

async function toPng(source, output) {
  await run('ffmpeg', '-y', '-v', 'error', '-i', source, '-frames:v', '1', output);
}

async function toGif(source, output) {
  await run(
    'ffmpeg',
    '-y',
    '-v',
    'error',
    '-i',
    source,
    '-t',
    String(MAX_GIF_DURATION),
    '-vf',
    'fps=15,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
    '-loop',
    '0',
    output,
  );
}

async function tgsToGif(source, output) {
  await require('./sticker_tgs').tgsToGif(source, output);
}

async function toMp3(source, output) {
  await run('ffmpeg', '-y', '-v', 'error', '-i', source, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', output);
}

async function toVoice(source, output) {
  await run(
    'ffmpeg',
    '-y',
    '-v',
    'error',
    '-i',
    source,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'libopus',
    '-b:a',
    '48k',
    '-vbr',
    'on',
    '-application',
    'voip',
    output,
  );
}

async function qrJob(client, event, text) {
  ensureTempDir();
  const output = path.join(TEMP_DIR, `qr_${crypto.randomBytes(16).toString('hex')}.png`);
  try {
    let QRCode;
    try {
      QRCode = require('qrcode');
    } catch {
      throw new Error('Library QR Code belum terpasang');
    }
    await QRCode.toFile(output, text, { width: 512, margin: 1 });
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error('QR Code gagal dibuat');
    }
    await sendFileMarkdown(client, chatId(event), output, {
      replyTo: event.replyToMsgId,
      forceDocument: false,
      caption: formatRichMessage({
        title: '▣ QR Code',
        blocks: [
          copyField('Isi QR', text.slice(0, 256)),
        ],
      }),
    });
    if (event.out) {
      try {
        await event.message.delete({ revoke: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanupFile(output);
  }
}

function failureReason(err) {
  const reason = String(err.message || err).replace(/\n/g, ' ').trim();
  return reason.slice(0, 200) || err.constructor.name;
}

async function editFailure(event, reason, title) {
  await editMarkdown(event, errorMessage(reason, title));
  markActivityFailed(reason);
}

function register(client) {
  command(client, /^\.toimg$/, async (event) => {
    const reply = await replyMessage(event);
    const kind = stickerKind(reply);
    if (kind === 'tgs' || kind === 'video') {
      await editFailure(event, 'Sticker animasi/video belum didukung oleh .toimg', 'Format Belum Didukung');
      return;
    }
    if (kind !== 'static') {
      await editFailure(event, 'Reply bukan sticker statis', 'Media Tidak Valid');
      return;
    }
    await editMarkdown(event, statusMessage('Memproses media...'));
    try {
      validateLimits(reply);
      await convertJob(client, event, reply, '.png', toPng, { forceDocument: false });
    } catch (err) {
      await editFailure(event, failureReason(err), 'Conversion failed');
    }
  });

  command(client, /^\.togif$/, async (event) => {
    const source = await sourceMedia(event, (m) => ['video', 'tgs'].includes(stickerKind(m)), true);
    if (!source) {
      await editMarkdown(
        event,
        errorMessage('Reply ke sticker animasi/video dengan `.togif`', 'Media Tidak Valid', {
          example: text.example(
            'Format: ',
            text.button(richButton('.togif', { copy_text: '.togif' }, 'primary')),
          ),
        }),
      );
      return;
    }
    await editMarkdown(event, statusMessage('Memproses media...'));
    try {
      validateLimits(source, MAX_GIF_DURATION);
      const convert = stickerKind(source) === 'tgs' ? tgsToGif : toGif;
      await convertJob(client, event, source, '.gif', convert, { forceDocument: false });
    } catch (err) {
      await editMarkdown(event, errorMessage(failureReason(err), 'Conversion failed'));
    }
  });

  command(client, /^\.tomp3$/, async (event) => {
    const source = await sourceMedia(event, (m) => isVideo(m) || isAudio(m));
    if (!source) {
      await editFailure(event, 'Media bukan video, dokumen video, audio, atau voice note', 'Media Tidak Valid');
      return;
    }
    await editMarkdown(event, statusMessage('Memproses media...'));
    try {
      validateLimits(source);
      await convertJob(client, event, source, '.mp3', toMp3, { forceDocument: false });
    } catch (err) {
      await editFailure(event, failureReason(err), 'Conversion failed');
    }
  });

  command(client, /^\.toqr(?:\s+([\s\S]+))?$/, async (event) => {
    let text = String(event.patternMatch.group(1) || '').trim();
    if (!text) {
      const reply = await replyMessage(event);
      text = String((reply && (reply.rawText || reply.message)) || '').trim();
    }
    if (!text) {
      await editFailure(event, 'Teks QR kosong', 'Teks Tidak Valid');
      return;
    }
    await editMarkdown(event, statusMessage('Memproses media...'));
    try {
      await qrJob(client, event, text);
    } catch (err) {
      await editFailure(event, failureReason(err), 'Conversion failed');
    }
  });

  command(client, /^\.tovn$/, async (event) => {
    const source = await sourceMedia(event, (m) => isAudio(m) || isVideo(m));
    if (!source) {
      await editMarkdown(
        event,
        errorMessage('Reply audio/video atau kirim media dengan caption `.tovn`', 'Media Tidak Valid', {
          example: text.example(
            'Format: ',
            text.button(richButton('.tovn', { copy_text: '.tovn' }, 'primary')),
          ),
        }),
      );
      return;
    }
    await editMarkdown(event, statusMessage('Memproses media...'));
    try {
      validateLimits(source);
      await convertJob(client, event, source, '.ogg', toVoice, { voiceNote: true });
    } catch (err) {
      await editMarkdown(event, errorMessage(failureReason(err), 'Conversion failed'));
    }
  });
}

module.exports = { register };

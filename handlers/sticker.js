'use strict';

/** Image-to-Telegram-sticker commands: `.stiker` and photo-caption `.s`. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Api, utils: tlUtils } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');

const { TEMP_DIR } = require('../config');
const { cleanupFile, ensureTempDir } = require('../utils/cleanup');
const { editMarkdown, errorMessage, text } = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { runProcess } = require('../utils/process');
const { command, chatId } = require('../utils/telegram');

const STICKER_LIMIT = 512 * 1024;
const CONVERT_TIMEOUT = 60;
const STICKER_SET_SHORT_NAME = 'tenzu_stick';
const STICKER_SET_TITLE = 'Tenzu Stick';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif']);

/**
 * True when the message itself carries a real image.
 *
 * `message.photo` is not enough: GramJS also returns a Photo for the preview of
 * a link (`MessageMediaWebPage`), so a message that is just a URL looked like a
 * valid image. The media type is therefore checked first, then the document
 * mime type.
 */
function isImage(message) {
  if (!message) return false;
  const media = message.media && message.media.className;
  if (media === 'MessageMediaPhoto') return Boolean(message.photo);
  if (media === 'MessageMediaDocument') {
    const mime = String((message.document && message.document.mimeType) || '').toLowerCase();
    if (IMAGE_MIMES.has(mime)) return true;
    // A photo sent "as file" often has no mime but does have image attributes.
    const attributes = (message.document && message.document.attributes) || [];
    return attributes.some((a) => /ImageSize|StickerAttribute/i.test(a.className || ''));
  }
  // A sticker/static image that arrived as `MessageMediaDocument` subclass or
  // an empty media field still exposes a Photo object on some layers.
  return false;
}

/**
 * Resolve the media a command should act on, in this order:
 *   1. the replied-to message (`.s` as a reply),
 *   2. the command message itself (photo with caption `.s`),
 *   3. the message the button tap came from (Rich Button flow).
 *
 * @returns {Promise<object|null>}
 */
async function resolveMedia(event, client) {
  const message = event && event.message;

  // 1. reply
  if (message && (message.isReply || message.replyToMsgId != null)) {
    try {
      const reply = await message.getReplyMessage();
      if (reply && isImage(reply)) return reply;
    } catch {
      /* fall through to the other sources */
    }
  }

  // 2. the message carrying the command / caption
  if (isImage(message)) return message;

  // 3. a button tap: refetch the tapped message (it may be the photo itself)
  const id = event && event.id;
  const chat = event && event.chatId;
  if (client && id != null && chat != null) {
    try {
      const fetched = await client.getMessages(chat, { ids: [id] });
      const target = Array.isArray(fetched) ? fetched[0] : fetched;
      if (target && isImage(target)) return target;
      // A button on a text message: look at the message it replies to.
      if (target && target.replyToMsgId != null) {
        const parent = await target.getReplyMessage();
        if (parent && isImage(parent)) return parent;
      }
    } catch {
      /* no media available */
    }
  }

  return null;
}

function isOccupiedError(err) {
  return /PACK_SHORT_NAME_OCCUPIED|SHORT_NAME_OCCUPIED/.test(err.message || '');
}
function isInvalidSetError(err) {
  return /STICKERSET_INVALID/.test(err.message || '');
}

/** Static 512px WebP sticker, reducing quality until it fits 512 KiB. */
async function convertSticker(source, output) {
  let lastError = '';
  for (const quality of [90, 82, 74, 66, 58, 50]) {
    const command_ = [
      'ffmpeg',
      '-y',
      '-v',
      'error',
      '-i',
      source,
      '-vf',
      'scale=512:512:force_original_aspect_ratio=decrease',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-quality',
      String(quality),
      '-compression_level',
      '6',
      output,
    ];
    let result;
    try {
      result = await runProcess(command_[0], command_.slice(1), { timeout: CONVERT_TIMEOUT * 1000 });
    } catch (err) {
      throw new Error('Konversi sticker timeout');
    }
    lastError = String(result.stderr || '').trim();
    if (result.code === 0 && fs.existsSync(output)) {
      const size = fs.statSync(output).size;
      if (size > 0 && size <= STICKER_LIMIT) return;
    }
    cleanupFile(output);
  }
  throw new Error(lastError.slice(0, 300) || 'Ukuran sticker melebihi batas Telegram');
}

async function uploadStickerDocument(client, event, output) {
  const stat = fs.statSync(output);
  const uploaded = await client.uploadFile({
    file: new CustomFile('sticker.webp', stat.size, output),
    workers: 1,
  });

  const media = await client.invoke(
    new Api.messages.UploadMedia({
      peer: await client.getInputEntity(chatId(event)),
      media: new Api.InputMediaUploadedDocument({
        file: uploaded,
        mimeType: 'image/webp',
        attributes: [
          new Api.DocumentAttributeFilename({ fileName: 'sticker.webp' }),
          new Api.DocumentAttributeSticker({ alt: '🖼️', stickerset: new Api.InputStickerSetEmpty() }),
        ],
        forceFile: false,
      }),
    }),
  );

  const document = media && media.document;
  if (!document) throw new Error('Upload sticker ke Telegram gagal');
  return document;
}

/**
 * Create the shared sticker set on first use.
 *
 * A short name must end with `_by_<bot username>`; this runs on a user account,
 * which is allowed to own a pack, so the suffix is optional there — but the
 * documented shape is kept when a username is available.
 */
async function createStickerSet(client, sticker) {
  const me = client.__me || (await client.getMe());
  const shortName = STICKER_SET_SHORT_NAME;
  try {
    await client.invoke(
      new Api.stickers.CreateStickerSet({
        userId: tlUtils.getInputUser(me),
        title: STICKER_SET_TITLE,
        shortName,
        stickers: [sticker],
        // A user account owns the pack, so it is not a "masks"/"emoji" set.
        masks: false,
      }),
    );
  } catch (err) {
    // A concurrent request may have created it between our check and create.
    if (isOccupiedError(err)) return;
    throw err;
  }
}

async function getStickerSet(client) {
  return client.invoke(
    new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetShortName({ shortName: STICKER_SET_SHORT_NAME }),
      hash: 0,
    }),
  );
}

/** Add to `tenzu_stick`, then return the actual pack-linked sticker. */
async function saveToStickerSet(client, event, output) {
  const uploadedDocument = await uploadStickerDocument(client, event, output);

  const sticker = new Api.InputStickerSetItem({
    document: tlUtils.getInputDocument(uploadedDocument),
    emoji: '🖼️',
  });

  try {
    await client.invoke(
      new Api.stickers.AddStickerToSet({
        stickerset: new Api.InputStickerSetShortName({ shortName: STICKER_SET_SHORT_NAME }),
        sticker,
      }),
    );
  } catch (err) {
    // The pack does not exist yet on this account: create it on first use
    // instead of failing every sticker with STICKERSET_INVALID.
    if (isInvalidSetError(err)) {
      await createStickerSet(client, sticker);
    } else if (isOccupiedError(err)) {
      throw new Error('Sticker pack `tenzu_stick` bukan milik akun Telegram pada session ini');
    } else {
      throw err;
    }
  }

  let result;
  try {
    result = await getStickerSet(client);
  } catch (err) {
    if (isInvalidSetError(err)) {
      throw new Error('Sticker pack `tenzu_stick` gagal dibuat atau tidak dapat diakses');
    }
    throw err;
  }

  const documents = (result && result.documents) || [];
  const packed =
    documents.find((item) => String(item.id) === String(uploadedDocument.id)) ||
    (documents.length ? documents[documents.length - 1] : null);
  if (!packed) throw new Error('Sticker tidak ditemukan di pack `tenzu_stick`');
  return packed;
}

async function makeSticker(client, event, sourceMessage) {
  ensureTempDir();
  const jobId = crypto.randomBytes(16).toString('hex');
  let source = path.join(TEMP_DIR, `sticker_${jobId}_source`);
  const output = path.join(TEMP_DIR, `sticker_${jobId}.webp`);

  try {
    const result = await Promise.race([
      client.downloadMedia(sourceMessage, { outputFile: source }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Konversi sticker timeout')), CONVERT_TIMEOUT * 1000)),
    ]);
    if (typeof result === 'string' && result) source = result;
    if (!fs.existsSync(source)) throw new Error('Gambar gagal diunduh');

    await convertSticker(source, output);
    const packedDocument = await saveToStickerSet(client, event, output);
    await client.sendFile(chatId(event), { file: packedDocument, replyTo: event.replyToMsgId });
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

async function handleStickerError(event, err) {
  await editMarkdown(event, errorMessage(String(err.message || err) || 'Gagal membuat sticker pack.'));
}

function register(client) {
  command(client, /^\.stiker$/, async (event) => {
    const reply = await resolveMedia(event, client);
    if (!reply) {
      await editMarkdown(
        event,
        errorMessage('Reply sebuah foto/gambar dengan command `.stiker`', 'Media Tidak Valid', {
          example: text.example(
            'Format: ',
            text.button(richButton('.stiker', { copy_text: '.stiker' }, 'primary')),
          ),
        }),
      );
      return;
    }
    try {
      await makeSticker(client, event, reply);
    } catch (err) {
      await handleStickerError(event, err);
    }
  });

  command(client, /^\.s$/, async (event) => {
    const sourceMessage = await resolveMedia(event, client);
    if (!sourceMessage) {
      await editMarkdown(
        event,
        errorMessage('Reply foto/gambar dengan `.s`, atau kirim foto dengan caption `.s`.', 'Media Tidak Valid', {
          example: text.example(
            'Format: ',
            text.button(richButton('.s', { copy_text: '.s' }, 'primary')),
          ),
        }),
      );
      return;
    }
    try {
      await makeSticker(client, event, sourceMessage);
    } catch (err) {
      await handleStickerError(event, err);
    }
  });
}

module.exports = { register };

'use strict';

const fs = require('node:fs');

const {
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  errorMessage,
  inlineCode,
  statusMessage,
} = require('../utils/formatting');
const { downloadVidey } = require('../downloaders/videy');
const { progressCallback } = require('../utils/progress');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.videy\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();

    const msg = await editMarkdown(event, formatMessage({ title: '⏳ Memproses Videy', body: inlineCode(url) }));
    let filepath = null;

    try {
      const progressCb = async (current, total) =>
        progressCallback(event, current, total, 'Downloading Videy Video');
      filepath = await downloadVidey(url, { progressCb });

      await editMarkdown(msg, statusMessage('Mengupload video...', '⬆️'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: formatMessage({ title: '🎬 Videy Download', compact: true }),
        replyTo: event.replyToMsgId,
      });
      await msg.delete();
    } catch (err) {
      let errorText = String(err.message || err);
      if (errorText.length > 900) errorText = errorText.slice(0, 900) + '...';
      await editMarkdown(msg, errorMessage(errorText, 'Videy Gagal'));
      console.error(err.stack || err);
    } finally {
      if (filepath && fs.existsSync(filepath)) {
        try {
          fs.unlinkSync(filepath);
        } catch {
          /* ignore */
        }
      }
    }
  });
}

module.exports = { register };

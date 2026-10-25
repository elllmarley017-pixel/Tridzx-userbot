'use strict';

const {
  copyField,
  editMarkdown,
  sendFileMarkdown,
  formatRichMessage,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  statusMessage,
  successMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { fbDownload, isFacebookUrl } = require('../downloaders/facebook');
const { progressCallback, clearProgress } = require('../utils/progress');
const { cleanupFile } = require('../utils/cleanup');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.fb\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isFacebookUrl(url)) {
      await editMarkdown(event, errorMessage('URL tidak valid. Masukkan URL Facebook.', 'Input Tidak Valid'));
      return;
    }

    await editMarkdown(event, statusMessage('Memproses download Facebook... 0%'));
    let filepath = null;

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, 'Memproses download');
      };

      const result = await fbDownload(url, { progressCb: prog });
      filepath = result.filepath;

      await editMarkdown(event, statusMessage('Mengirim video...', '📤'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: formatRichMessage({
          title: '📘 Facebook Video',
          body: escapeMarkdown(result.title),
          blocks: [
            exampleButton('Sumber: ', 'Buka Video', { url }, 'link'),
            copyField('Tautan', url),
          ],
        }),
        supportsStreaming: true,
      });
      await editMarkdown(event, successMessage('Download selesai!'));
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message));
    } finally {
      clearProgress(event.id);
      if (filepath) cleanupFile(filepath);
    }
  });
}

module.exports = { register };

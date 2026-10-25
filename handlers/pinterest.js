'use strict';

const {
  copyField,
  editMarkdown,
  sendFileMarkdown,
  formatRichMessage,
  errorMessage,
  exampleButton,
  statusMessage,
  successMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { downloadPinterest, isPinterestUrl } = require('../downloaders/pinterest');
const { progressCallback, clearProgress } = require('../utils/progress');
const { cleanupFile } = require('../utils/cleanup');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.pin\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isPinterestUrl(url)) {
      await editMarkdown(event, errorMessage('URL tidak valid. Masukkan URL Pinterest.', 'Input Tidak Valid'));
      return;
    }

    await editMarkdown(event, statusMessage('Memproses URL Pinterest...'));
    let filepath = null;

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, 'Downloading Pinterest');
      };

      const result = await downloadPinterest(url, { progressCb: prog });
      filepath = result.filepath;

      await editMarkdown(event, statusMessage('Mengirim media...', '📤'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: formatRichMessage({
          title: result.isVideo ? '📌 Pinterest Video' : '📌 Pinterest Image',
          blocks: [
            exampleButton('Sumber: ', 'Buka Pin', { url }, 'link'),
            copyField('Tautan', url),
          ],
        }),
        supportsStreaming: Boolean(result.isVideo),
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

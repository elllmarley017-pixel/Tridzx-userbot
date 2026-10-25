'use strict';

const {
  copyField,
  editMarkdown,
  sendFileMarkdown,
  formatRichMessage,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  inlineCode,
  statusMessage,
  successMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { downloadMediafire, isMediafireUrl } = require('../downloaders/mediafire');
const { progressCallback, clearProgress } = require('../utils/progress');
const { cleanupFile } = require('../utils/cleanup');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.mediafire\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isMediafireUrl(url)) {
      await editMarkdown(event, errorMessage('URL tidak valid. Masukkan URL MediaFire.', 'Input Tidak Valid'));
      return;
    }

    await editMarkdown(event, statusMessage('Memproses URL MediaFire...'));
    let filepath = null;

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, 'Downloading MediaFire');
      };

      const result = await downloadMediafire(url, { progressCb: prog });
      filepath = result.filepath;
      const { filename, size } = result;

      const sizeStr =
        size > 1024 * 1024
          ? `${(size / (1024 * 1024)).toFixed(1)}MB`
          : `${(size / 1024).toFixed(1)}KB`;

      await editMarkdown(event, statusMessage('Mengirim file...', '📤'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: formatRichMessage({
          title: '📁 MediaFire File',
          blocks: [
            copyField('Nama file', filename),
            exampleButton('Sumber: ', 'Buka MediaFire', { url }, 'link'),
          ],
          details: [`<b>Ukuran:</b> ${inlineCode(sizeStr)}`],
        }),
        forceDocument: true,
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

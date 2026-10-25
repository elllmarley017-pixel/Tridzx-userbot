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
const { downloadTiktokVideo, isTikTokUrl } = require('../downloaders/tiktok');
const { progressCallback, clearProgress } = require('../utils/progress');
const { cleanupFile } = require('../utils/cleanup');
const { formatDuration } = require('../utils/helpers');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.tt\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isTikTokUrl(url)) {
      await editMarkdown(event, errorMessage('URL tidak valid. Masukkan URL TikTok.', 'Input Tidak Valid'));
      return;
    }

    await editMarkdown(event, statusMessage('Memproses URL TikTok...'));
    let filepath = null;

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, 'Downloading TikTok');
      };

      const result = await downloadTiktokVideo(url, { progressCb: prog });

      if (result.type === 'photo') {
        await editMarkdown(
          event,
          formatRichMessage({
            title: 'ℹ️ Konten Ini Berupa Foto/Slide',
            body: 'Gunakan command foto TikTok untuk mengunduhnya.',
            example: text.example(
              'Contoh: ',
              text.button(richButton('.ttpic <link>', { copy_text: `.ttpic ${url}` }, 'primary')),
            ),
          }),
        );
        return;
      }

      filepath = result.filepath;
      const creator = result.creator || '';
      const captionText = result.caption || '';
      const duration = result.duration || 0;

      const details = [];
      if (creator) details.push(`<b>Kreator:</b> ${escapeMarkdown(creator)}`);
      if (captionText) {
        const short = captionText.slice(0, 200) + (captionText.length > 200 ? '...' : '');
        details.push(`<b>Caption:</b> ${escapeMarkdown(short)}`);
      }
      if (duration) details.push(`<b>Durasi:</b> ${inlineCode(formatDuration(duration))}`);
      const cap = formatRichMessage({
        title: '🎵 TikTok Video',
        details,
        blocks: [
          exampleButton('Sumber: ', 'Buka Video', { url }, 'link'),
          copyField('Tautan', url),
        ],
      });

      await editMarkdown(event, statusMessage('Mengirim video...', '📤'));
      await sendFileMarkdown(client, chatId(event), filepath, {
        caption: cap,
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

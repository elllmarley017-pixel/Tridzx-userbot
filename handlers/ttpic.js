'use strict';

const {
  copyField,
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  formatRichMessage,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  inlineCode,
  statusMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const {
  TikTokResolveError,
  downloadTiktokPhotos,
  isTikTokUrl,
} = require('../downloaders/tiktok');
const { ClientError, TimeoutError } = require('../utils/http');
const { progressCallback, clearProgress } = require('../utils/progress');
const { cleanupFile } = require('../utils/cleanup');
const { command, chatId } = require('../utils/telegram');

function register(client) {
  command(client, /^\.ttpic\s+(.+)/, async (event) => {
    const url = String(event.patternMatch.group(1)).trim();
    if (!isTikTokUrl(url)) {
      await editMarkdown(event, errorMessage('URL tidak valid. Masukkan URL TikTok.', 'Input Tidak Valid'));
      return;
    }

    await editMarkdown(event, statusMessage('Memproses foto TikTok...'));
    let filepaths = [];

    try {
      const prog = async (current, total) => {
        await progressCallback(event, current, total, 'Downloading TikTok Photos');
      };

      const result = await downloadTiktokPhotos(url, { progressCb: prog });

      if (result.type === 'video') {
        await editMarkdown(
          event,
          formatRichMessage({
            title: '❌ Bukan TikTok Photo/Slide',
            body: 'Link tersebut mengarah ke video TikTok.',
            note: 'Gunakan `.tt <link>` untuk mengunduh video.',
            example: text.example(
              'Alternatif: ',
              text.button(richButton('.tt <link>', { copy_text: `.tt ${url}` }, 'primary')),
            ),
          }),
        );
        return;
      }

      filepaths = result.filepaths || [];
      if (!filepaths.length) {
        await editMarkdown(event, errorMessage('Tidak ada foto yang ditemukan.', 'Foto Tidak Ditemukan'));
        return;
      }

      const creator = result.creator || '';
      const captionText = result.caption || '';

      const details = [
        `<b>🖼️ Total Foto:</b> ${inlineCode(filepaths.length)}`,
        '<b>📦 Status:</b> Download selesai',
      ];
      if (creator) details.push(`<b>Kreator:</b> ${escapeMarkdown(creator)}`);
      if (captionText) {
        const short = captionText.slice(0, 200) + (captionText.length > 200 ? '...' : '');
        details.push(`<b>Caption:</b> ${escapeMarkdown(short)}`);
      }
      const cap = formatRichMessage({
        title: '📸 TikTok Photo Berhasil Diproses',
        details,
        blocks: [
          exampleButton('Sumber: ', 'Buka Post', { url }, 'link'),
          copyField('Tautan', url),
        ],
      });

      await editMarkdown(event, statusMessage(`Mengirim ${filepaths.length} foto...`, '📤'));

      // Send as album (max 10 per group).
      for (let i = 0; i < filepaths.length; i += 10) {
        const batch = filepaths.slice(i, i + 10);
        const batchCap = i === 0 ? cap : '';
        await sendFileMarkdown(client, chatId(event), batch, { caption: batchCap });
      }

      await editMarkdown(
        event,
        formatMessage({
          title: '📸 TikTok Photo Berhasil Diproses',
          details: [
            `<b>🖼️ Total Foto:</b> ${inlineCode(filepaths.length)}`,
            '<b>📦 Status:</b> Download selesai',
          ],
        }),
      );
    } catch (err) {
      if (err instanceof TikTokResolveError || err.name === 'TikTokResolveError') {
        await editMarkdown(
          event,
          formatMessage({
            title: '❌ Gagal Mengakses Link TikTok',
            body: 'Kemungkinan penyebab:',
            details: [
              'Link sudah tidak valid',
              'TikTok tidak merespons',
              'Koneksi ke TikTok timeout',
              'URL tidak dapat di-resolve',
            ],
            footer: 'Silakan coba lagi beberapa saat kemudian.',
          }),
        );
      } else if (err instanceof TimeoutError || err instanceof ClientError) {
        await editMarkdown(
          event,
          errorMessage(
            'Koneksi ke TikTok timeout atau sedang bermasalah. Silakan coba lagi beberapa saat kemudian.',
            'TikTok Tidak Dapat Diakses',
          ),
        );
      } else {
        const message = String(err.message || '').trim() || 'TikTok Photo/Slide gagal diproses';
        await editMarkdown(event, errorMessage(message, 'TikTok Photo Gagal'));
      }
    } finally {
      clearProgress(event.id);
      for (const fp of filepaths) cleanupFile(fp);
    }
  });
}

module.exports = { register };

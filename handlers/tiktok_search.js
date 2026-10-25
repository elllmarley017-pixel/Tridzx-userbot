'use strict';

const {
  editMarkdown,
  errorMessage,
  escapeMarkdown,
  formatRichMessage,
  inlineCode,
  markdownLink,
  statusMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const {
  TikTokSearchError,
  searchAccounts,
  searchVideos,
} = require('../downloaders/tiktok_search');
const { command } = require('../utils/telegram');

const QUERY_RE = /^(.+?)\s+(account|vt)$/is;
const RESULT_LIMIT = 5;

function number(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function register(client) {
  command(client, /^\.ttsearch(?:\s+(.+))?$/, async (event) => {
    const raw = String(event.patternMatch.group(1) || '').trim();
    const match = QUERY_RE.exec(raw);
    if (!match) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: '❌ Format TikTok Search Tidak Valid',
          body: 'Tipe pencarian hanya menerima `account` atau `vt`.',
          details: ['Akun: `.ttsearch <query> account`', 'Video: `.ttsearch <query> vt`'],
          example: text.example(
            'Contoh: ',
            text.button(richButton('.ttsearch video galau vt', { copy_text: '.ttsearch video galau vt' }, 'primary')),
          ),
        }),
      );
      return;
    }

    const query = match[1].trim();
    const searchType = match[2].toLowerCase();
    if (query.length < 2 || query.length > 100) {
      await editMarkdown(event, errorMessage('Query harus berisi 2–100 karakter', 'Query Tidak Valid'));
      return;
    }

    const label = searchType === 'account' ? 'akun' : 'video';
    await editMarkdown(event, statusMessage(`Mencari ${label} TikTok: ${inlineCode(query)}...`));

    try {
      let details = [];
      let title;
      if (searchType === 'account') {
        const results = await searchAccounts(query, RESULT_LIMIT);
        if (!results.length) {
          await editMarkdown(event, errorMessage('Akun TikTok tidak ditemukan', 'Hasil Kosong'));
          return;
        }
        results.forEach((item, i) => {
          const verified = item.verified ? ' ✓' : '';
          const avatar = item.avatar ? ` · ${markdownLink('Avatar', item.avatar)}` : '';
          details.push(
            text.example(
              text.raw(
                `<b>${i + 1}. ${escapeMarkdown(item.name)}${verified}</b>\n` +
                  `　${inlineCode('@' + item.username)} · Followers ${inlineCode(number(item.followers))}\n` +
                  `　${markdownLink('Profil TikTok', item.url)}${avatar} `,
              ),
              text.button(richButton('Profil', { url: item.url }, 'link')),
              ' ',
              text.button(richButton('Salin Username', { copy_text: '@' + String(item.username).replace(/^@/, '') }, 'primary')),
            ),
          );
        });
        title = '👤 Hasil Pencarian Akun TikTok';
      } else {
        const results = await searchVideos(query, RESULT_LIMIT);
        if (!results.length) {
          await editMarkdown(event, errorMessage('Video TikTok tidak ditemukan', 'Hasil Kosong'));
          return;
        }
        results.forEach((item, i) => {
          const cap =
            item.caption.slice(0, 160) + (item.caption.length > 160 ? '...' : '');
          const thumbnail = item.thumbnail ? ` · ${markdownLink('Thumbnail', item.thumbnail)}` : '';
          const creator =
            item.username !== 'Tidak diketahui'
              ? inlineCode('@' + String(item.username).replace(/^@/, ''))
              : '*Tidak tersedia*';
          details.push(
            text.example(
              text.raw(
                `<b>${i + 1}. ${escapeMarkdown(cap)}</b>\n` +
                  `　Kreator: ${creator}\n` +
                  `　👁 ${inlineCode(number(item.views))} · ♥ ${inlineCode(number(item.likes))} · 💬 ${inlineCode(number(item.comments))}\n` +
                  `　${markdownLink('Buka Video', item.url)}${thumbnail} `,
              ),
              text.button(richButton('Tonton', { url: item.url }, 'link')),
              ' ',
              text.button(richButton('Salin Link', { copy_text: item.url }, 'primary')),
            ),
          );
        });
        title = '🎬 Hasil Pencarian Video TikTok';
      }

      await editMarkdown(
        event,
        formatRichMessage({
          title,
          body: `Query: ${inlineCode(query)}`,
          details,
          note: `Menampilkan maksimal ${RESULT_LIMIT} hasil dari layanan pencarian publik TikTok.`,
          footer: 'Tombol di dalam teks tidak mengubah keyboard chat.',
        }),
        { linkPreview: false },
      );
    } catch (err) {
      if (err instanceof TikTokSearchError) {
        await editMarkdown(event, errorMessage(err.message, 'TikTok Search Gagal'));
      } else {
        await editMarkdown(
          event,
          errorMessage('Terjadi kesalahan internal saat mencari TikTok', 'TikTok Search Gagal'),
        );
      }
    }
  });
}

module.exports = { register };

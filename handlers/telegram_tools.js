'use strict';

const { Api } = require('telegram');

const {
  editMarkdown,
  errorMessage,
  escapeMarkdown,
  formatMessage,
  formatRichMessage,
  inlineCode,
  rateLimitMessage,
  markdownLink,
  statusMessage,
  text,
} = require('../utils/formatting');
const { richButton } = require('../utils/rich_message');
const { command } = require('../utils/telegram');

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SEARCH_LIMIT = 10;

function username(value) {
  const name = String(value).trim().replace(/^@/, '').trim();
  if (!USERNAME_RE.test(name)) {
    throw new Error('Username harus 4–32 karakter dan hanya berisi huruf, angka, atau underscore');
  }
  return name;
}

function displayName(entity) {
  if (entity instanceof Api.User) {
    return [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Tanpa nama';
  }
  return entity.title || 'Tanpa nama';
}

function entityKind(entity) {
  if (entity instanceof Api.User) return ['user', '👤 User'];
  if (entity instanceof Api.Channel && entity.broadcast) return ['channel', '📢 Channel'];
  return ['group', '👥 Group'];
}

function relevance(entity, keyword) {
  const needle = keyword.toLowerCase();
  const uname = String(entity.username || '').toLowerCase();
  const name = displayName(entity).toLowerCase();
  let score;
  if (uname === needle) score = 0;
  else if (name === needle) score = 1;
  else if (uname.startsWith(needle)) score = 2;
  else if (name.startsWith(needle)) score = 3;
  else if (uname.includes(needle)) score = 4;
  else if (name.includes(needle)) score = 5;
  else score = 6;
  return [score, name];
}

function isFloodWait(err) {
  return /FLOOD_WAIT_(\d+)/.test(err.message || '');
}

function floodSeconds(err) {
  const m = /FLOOD_WAIT_(\d+)/.exec(err.message || '');
  return m ? m[1] : '0';
}

function register(client) {
  command(client, /^\.id(?:\s+(.+))?$/, async (event) => {
    const raw = event.patternMatch.group(1) || '';
    let name;
    try {
      name = username(raw);
    } catch (err) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: '❌ Username Tidak Valid',
          body: escapeMarkdown(err.message),
          example: text.example(
            'Contoh: ',
            text.button(richButton('.id @username', { copy_text: '.id @username' }, 'primary')),
          ),
        }),
      );
      return;
    }

    await editMarkdown(event, statusMessage(`Mencari ${inlineCode('@' + name)}...`));
    try {
      const resolved = await client.invoke(
        new Api.contacts.ResolveUsername({ username: name }),
      );
      const all = [...(resolved.users || []), ...(resolved.chats || [])];
      const entity = all.find((item) => item.id);
      if (!entity) {
        throw new Error('Username tidak ditemukan');
      }

      const accountUsername = entity.username;
      const [, label] = entityKind(entity);
      const details = [
        `<b>Tipe:</b> ${label}`,
        `<b>Nama:</b> ${escapeMarkdown(displayName(entity))}`,
        `<b>Username:</b> ${accountUsername ? inlineCode('@' + accountUsername) : '*Tidak tersedia*'}`,
        `<b>ID:</b> ${inlineCode(entity.id)}`,
      ];
      const buttons = [richButton('Salin ID', { copy_text: String(entity.id) }, 'primary')];
      if (accountUsername) {
        buttons.push(richButton('Buka Profil', { url: `https://t.me/${accountUsername}` }, 'link'));
      }
      await editMarkdown(
        event,
        formatRichMessage({
          title: '🆔 Informasi Telegram',
          details,
          footer: 'Tombol di dalam teks menyalin ID atau membuka profil.',
          buttons,
        }),
      );
    } catch (err) {
      if (isFloodWait(err)) {
        await editMarkdown(
          event,
          rateLimitMessage(floodSeconds(err), { action: '.id' }),
        );
      } else if (/not found|not occupied|invalid|tidak ditemukan/i.test(err.message || '')) {
        await editMarkdown(
          event,
          errorMessage('Username tidak ditemukan atau tidak dapat diakses', 'Pencarian Gagal'),
        );
      } else {
        await editMarkdown(
          event,
          errorMessage('Telegram API gagal mengakses username tersebut', 'Pencarian Gagal'),
        );
      }
    }
  });

  command(client, /^\.telesearch(?:\s+(.+))?$/, async (event) => {
    const keyword = String(event.patternMatch.group(1) || '').trim();
    if (keyword.length < 2 || keyword.length > 64) {
      await editMarkdown(
        event,
        formatRichMessage({
          title: '❌ Keyword Tidak Valid',
          body: 'Keyword harus berisi `2–64` karakter.',
          example: text.example(
            'Contoh: ',
            text.button(richButton('.telesearch tenzu', { copy_text: '.telesearch tenzu' }, 'primary')),
          ),
        }),
      );
      return;
    }

    await editMarkdown(event, statusMessage(`Mencari Telegram: ${inlineCode(keyword)}...`));
    try {
      const result = await client.invoke(
        new Api.contacts.Search({ q: keyword, limit: 50 }),
      );
      const entities = [...(result.users || []), ...(result.chats || [])];
      const unique = new Map();
      for (const entity of entities) {
        unique.set(`${entityKind(entity)[0]}:${entity.id}`, entity);
      }
      const ranked = [...unique.values()]
        .sort((a, b) => {
          const [sa, na] = relevance(a, keyword);
          const [sb, nb] = relevance(b, keyword);
          return sa - sb || (na < nb ? -1 : na > nb ? 1 : 0);
        })
        .slice(0, SEARCH_LIMIT);

      if (!ranked.length) {
        await editMarkdown(
          event,
          errorMessage('Tidak ada hasil yang dapat diakses', 'Hasil Tidak Ditemukan'),
        );
        return;
      }

      // Search results are tabular: kind, name, username and id line up in
      // columns instead of a stack of free-form lines.
      const table = {
        headers: ['#', 'Jenis', 'Nama', 'Username', 'ID'],
        rows: ranked.map((entity, i) => {
          const [, kindLabel] = entityKind(entity);
          return [
            String(i + 1),
            kindLabel,
            displayName(entity),
            entity.username ? `@${entity.username}` : "—",
            String(entity.id),
          ];
        }),
        caption: `${ranked.length} hasil untuk "${keyword}"`,
      };

      await editMarkdown(
        event,
        formatRichMessage({
          title: '🔎 Hasil Telegram Search',
          table,
          note: `Menampilkan maksimal ${SEARCH_LIMIT} hasil yang tersedia melalui Telegram API; bukan seluruh database Telegram.`,
          footer: 'Salin ID langsung dari tabel.',
        }),
      );
    } catch (err) {
      if (isFloodWait(err)) {
        await editMarkdown(
          event,
          rateLimitMessage(floodSeconds(err), { action: '.telesearch' }),
        );
      } else {
        await editMarkdown(
          event,
          errorMessage('Telegram API gagal melakukan pencarian', 'Pencarian Gagal'),
        );
      }
    }
  });
}

module.exports = { register };

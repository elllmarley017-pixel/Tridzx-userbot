'use strict';

/** Bot and owner information command — Rich Message layout. */

const { BOT_VERSION, PROCESS_STARTED_AT } = require('../config');
const {
  editMarkdown,
  escapeMarkdown,
  formatRichMessage,
  inlineCode,
  markdownLink,
  text,
  block,
} = require('../utils/formatting');
const { buildRichMessage, richButton } = require('../utils/rich_message');
const { command } = require('../utils/telegram');

function formatUptime(seconds) {
  let total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  total -= days * 86400;
  const hours = Math.floor(total / 3600);
  total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const secs = total - minutes * 60;

  const parts = [];
  if (days) parts.push(`${days} Day${days !== 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} Hour${hours !== 1 ? 's' : ''}`);
  if (minutes) parts.push(`${minutes} Minute${minutes !== 1 ? 's' : ''}`);
  if (secs || !parts.length) parts.push(`${secs} Second${secs !== 1 ? 's' : ''}`);
  return parts.join(' ');
}

/**
 * One `Label: value` row that ends with an inline Rich Message button, using
 * the documented `text.example(prefix, text.button(richButton(...)))` shape.
 */
function row(label, value, button) {
  const prefix = text.raw(`<b>${escapeMarkdown(label)}:</b> ${value} `);
  if (!button) return block.paragraph(prefix);
  return block.paragraph(text.example(prefix, text.button(button)));
}

/** A Rich Message URL button (`RichMessageButton.url`). */
function linkButton(label, url) {
  return richButton(label, { url }, 'link');
}

function buildInfoBlocks(uptime) {
  const blocks = [
    block.heading(1, '🤖 Bot Information'),
    block.paragraph('┈'.repeat(12)),
    row('Nama Bot', 'Hytryx Userbot'),
    row('Versi', inlineCode(BOT_VERSION)),
    row('Status', `🟢 Running • ${inlineCode(uptime)}`),
    row('Tipe', 'Node.js'),
    row('Owner', markdownLink('@HanzTenzX', 'https://t.me/HanzTenzX'), linkButton('Chat Owner', 'https://t.me/HanzTenzX')),
    block.divider(),
    block.heading(3, '👤 Owner Information'),
    row('Portfolio', markdownLink('hanzx-portofolio.vercel.app', 'https://hanzx-portofolio.vercel.app/'), linkButton('Buka', 'https://hanzx-portofolio.vercel.app/')),
    row('Channel', markdownLink('@TenzXrepro', 'https://t.me/TenzXrepro'), linkButton('Join', 'https://t.me/TenzXrepro')),
    row('Archive', markdownLink('@despiselonelyy', 'https://t.me/despiselonelyy'), linkButton('Join', 'https://t.me/despiselonelyy')),
    block.divider(),
    block.heading(3, '🐙 GitHub Owner'),
    row('One', markdownLink('elllmarley017-pixel', 'https://github.com/elllmarley017-pixel'), linkButton('Repo', 'https://github.com/elllmarley017-pixel')),
    row('Two', markdownLink('hanztenzudv', 'https://github.com/hanztenzudv'), linkButton('Repo', 'https://github.com/hanztenzudv')),
    block.divider(),
    block.heading(3, '📬 Owner Telegram'),
    row('Owner', markdownLink('@HanzTenzX', 'https://t.me/HanzTenzX'), linkButton('Message', 'https://t.me/HanzTenzX')),
    // RichBlockTable — a compact runtime summary.
    block.table({
      headers: ['Metrik', 'Nilai'],
      rows: [
        ['Versi', BOT_VERSION],
        ['Uptime', uptime],
        ['Runtime', `Node.js ${process.versions.node}`],
      ],
      striped: true,
      compact: true,
      caption: 'Ringkasan runtime',
    }),
    // Inline RichTextButtons, each inside its own paragraph.
    block.paragraph(
      text.example(
        '🔗 Tautan: ',
        text.button(richButton('Channel', { url: 'https://t.me/TenzXrepro' }, 'primary')),
        ' ',
        text.button(richButton('Owner', { url: 'https://t.me/HanzTenzX' }, 'success')),
      ),
    ),
    block.paragraph(
      text.example(
        '📋 Versi: ',
        text.button(richButton('Salin Versi', { copy_text: BOT_VERSION }, 'link')),
      ),
    ),
    block.footer('Semua tombol berada di dalam teks Rich Message.'),
  ];
  return blocks;
}

function register(client) {
  command(client, /^\.infobot$/, async (event) => {
    // `PROCESS_STARTED_AT` is `performance.now()` in milliseconds; uptime is seconds.
    const uptime = formatUptime((performance.now() - PROCESS_STARTED_AT) / 1000) || formatUptime(0);
    await editMarkdown(event, buildRichMessage(buildInfoBlocks(uptime)), { linkPreview: false });
  });
}

module.exports = { register, formatUptime, formatRichMessage };

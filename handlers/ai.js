'use strict';

/** AI chat/coding assistant: `.ai <text>`. */

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const {
  copyField,
  TEMP_DIR } = require('../config');
const { cleanupFile, ensureTempDir } = require('../utils/cleanup');
const {
  editMarkdown,
  sendFileMarkdown,
  formatMessage,
  formatRichMessage,
  errorMessage,
  exampleButton,
  escapeMarkdown,
  inlineCode,
  statusMessage,
  successMessage,
  text,
  block,
} = require('../utils/formatting');
const { buildRichMessage, richButton } = require('../utils/rich_message');
const { sanitizeFilename } = require('../utils/helpers');
const { ClientSession } = require('../utils/http');
const { command, chatId, filenameAttribute } = require('../utils/telegram');

const KRYNOX_API_KEY = process.env.KRYNOX_API_KEY || 'sk-b6329b943f8c7918-cm6mm3-948f895c';
const KRYNOX_ENDPOINT = 'https://ai.krynox.dev/v1/chat/completions';
const KRYNOX_MODEL = 'kc/minimax/minimax-m3:free';

const FALLBACK_ENDPOINT = 'https://us-central1-conquer-apps-2ad61.cloudfunctions.net/prod/api.live';

const AI_TIMEOUT = 180;
const MAX_OUTPUT_LEN = 40960;

const SYSTEM_PROMPT =
  'Kamu adalah AI coding assistant yang sangat capable. ' +
  'Ketika user meminta dibuatkan project atau file coding:\n' +
  '1. Hasilkan source code LENGKAP dan siap pakai, bukan potongan.\n' +
  '2. Gunakan format khusus untuk setiap file:\n' +
  '   ===FILE: path/to/filename.ext===\n' +
  '   <isi file lengkap>\n' +
  '   ===END_FILE===\n' +
  '3. Tentukan nama file, ekstensi, dan struktur folder yang tepat.\n' +
  '4. Sertakan semua file yang dibutuhkan (config, requirements, README, dll).\n' +
  '5. Jika bukan permintaan coding/file, jawab langsung dengan teks biasa.\n' +
  '6. Jangan gunakan markdown code block (```) di dalam blok ===FILE===.\n' +
  '7. Pastikan setiap file memiliki kode yang lengkap dan fungsional.';

const FILE_BLOCK_RE = /===FILE:\s*(.+?)\s*===\s*\n([\s\S]*?)\n\s*===END_FILE===/g;

function globalFileBlockRe() {
  return new RegExp(FILE_BLOCK_RE.source, 'g');
}

function parseFiles(text) {
  const files = [];
  for (const m of text.matchAll(globalFileBlockRe())) {
    const filepath = m[1].trim().replace(/^["']|["']$/g, '');
    const content = m[2];
    if (filepath && content != null) files.push({ path: filepath, content });
  }
  return files;
}

function cleanTextResponse(text) {
  const cleaned = text.replace(globalFileBlockRe(), '').trim();
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

function parseSseJson(raw) {
  let text = String(raw).trim();
  if (text.endsWith('data: [DONE]')) {
    text = text.slice(0, text.lastIndexOf('data: [DONE]')).trim();
  }
  if (text.startsWith('data: ')) {
    text = text.slice('data: '.length).trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    throw new Error('Response AI tidak valid (bukan JSON)');
  }
}

function extractContent(data) {
  const err = data.error || {};
  if (typeof err === 'object' && err.message) {
    const message = err.message;
    if (/Rate limit/i.test(message) || String(message).includes('429')) {
      throw new Error('Rate limit tercapai');
    }
    throw new Error('AI error');
  }

  const choices = data.choices;
  if (!choices || !choices.length) throw new Error('AI tidak menghasilkan response');

  const content = ((choices[0].message || {}).content) || '';
  if (!content) throw new Error('AI menghasilkan response kosong');
  return content;
}

async function callKrynox(prompt) {
  const session = new ClientSession();
  try {
    const resp = await session.post(
      KRYNOX_ENDPOINT,
      {
        headers: { Authorization: `Bearer ${KRYNOX_API_KEY}`, 'Content-Type': 'application/json' },
        json: {
          model: KRYNOX_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 16000,
          temperature: 0.7,
        },
        timeout: AI_TIMEOUT,
      },
    );
    if (resp.status >= 400) throw new Error(`Krynox HTTP ${resp.status}`);
    const raw = await resp.text();
    return extractContent(parseSseJson(raw));
  } finally {
    await session.close();
  }
}

async function callFallback(prompt) {
  const fullPrompt = `${SYSTEM_PROMPT}\n\nUser: ${prompt}`;
  const session = new ClientSession();
  try {
    const resp = await session.post(FALLBACK_ENDPOINT, {
      json: {
        prompt: fullPrompt,
        max_tokens: 5_000_000,
        n: 1,
        temperature: 0.8,
        top_p: 0.1,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: AI_TIMEOUT,
    });
    if (resp.status >= 400) throw new Error(`Fallback HTTP ${resp.status}`);
    const raw = await resp.text();
    return extractContent(parseSseJson(raw));
  } finally {
    await session.close();
  }
}

async function callAi(prompt) {
  try {
    return await callKrynox(prompt);
  } catch {
    /* fall back below */
  }
  return callFallback(prompt);
}

function register(client) {
  command(client, /^\.ai\s+([\s\S]+)/, async (event) => {
    const prompt = String(event.patternMatch.group(1)).trim();
    if (!prompt) {
      await editMarkdown(event, errorMessage('Masukkan teks setelah `.ai`', 'Input Kosong'));
      return;
    }

    await editMarkdown(event, statusMessage('AI sedang memproses permintaan...', '🤖'));

    let aiResponse;
    try {
      aiResponse = await callAi(prompt);
    } catch (err) {
      if (err instanceof Error && /Rate limit|AI error|Response AI|kosong|HTTP/.test(err.message)) {
        await editMarkdown(event, errorMessage(err.message));
      } else if (/connect|ECONN|fetch|network|socket/i.test(err.message || '')) {
        await editMarkdown(event, errorMessage('Gagal terhubung ke server AI', 'Koneksi Gagal'));
      } else {
        await editMarkdown(event, errorMessage('Terjadi kesalahan saat menghubungi AI', 'AI Error'));
      }
      return;
    }

    const files = parseFiles(aiResponse);

    if (!files.length) {
      if (aiResponse.length <= MAX_OUTPUT_LEN) {
        // Inline Rich Message buttons keep the follow-up actions inside the text.
        await editMarkdown(
          event,
          formatRichMessage({
            title: '🤖 AI Response',
            body: escapeMarkdown(aiResponse),
            footer: `Model: ${escapeMarkdown(KRYNOX_MODEL)}`,
            buttons: [
              richButton('Salin Jawaban', { copy_text: aiResponse.slice(0, 256) }, 'primary'),
              richButton('Lanjutkan', { callback_data: 'ai:continue' }, 'link'),
            ],
          }),
        );
      } else {
        ensureTempDir();
        const txtPath = path.join(TEMP_DIR, 'ai_response.txt');
        try {
          fs.writeFileSync(txtPath, aiResponse, 'utf8');
          await editMarkdown(event, statusMessage('Response terlalu panjang, mengirim sebagai file...', '📤'));
          await sendFileMarkdown(client, chatId(event), txtPath, {
            caption: formatMessage({ title: '🤖 AI Response', note: 'Terlalu panjang untuk chat, dikirim sebagai file.' }),
          });
          await editMarkdown(event, successMessage('Selesai! File telah dikirim.'));
        } finally {
          cleanupFile(txtPath);
        }
      }
      return;
    }

    await editMarkdown(event, statusMessage('AI sedang membuat source code...', '⚙️'));
    ensureTempDir();

    const explanation = cleanTextResponse(aiResponse);
    const createdPaths = [];

    try {
      if (files.length === 1) {
        const f = files[0];
        const filename = path.basename(f.path);
        const safeName = sanitizeFilename(path.parse(filename).name) || 'ai_file';
        const ext = path.parse(filename).ext || '.txt';
        const outPath = path.join(TEMP_DIR, `${safeName}${ext}`);
        createdPaths.push(outPath);

        fs.writeFileSync(outPath, f.content, 'utf8');
        await editMarkdown(event, statusMessage('Menyiapkan file...', '📦'));

        const caption = formatRichMessage({
          title: '🤖 File AI',
          blocks: [
            copyField('Nama file', filename),
          ],
          note: explanation ? escapeMarkdown(explanation.slice(0, 700)) : undefined,
        });

        await sendFileMarkdown(client, chatId(event), outPath, { caption });
        await editMarkdown(event, successMessage('Selesai! File telah dikirim.'));
      } else {
        const firstPath = files[0].path;
        let projectName = firstPath.includes('/') ? firstPath.split('/')[0] : 'ai_project';
        projectName = sanitizeFilename(projectName) || 'ai_project';

        const zipPath = path.join(TEMP_DIR, `${projectName}.zip`);
        createdPaths.push(zipPath);

        await editMarkdown(event, statusMessage('Membuat struktur project...', '⚙️'));

        const zip = new JSZip();
        for (const f of files) zip.file(f.path, f.content);
        const buffer = await zip.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        });
        fs.writeFileSync(zipPath, buffer);

        if (buffer.length > 50 * 1024 * 1024) {
          await editMarkdown(event, errorMessage('File terlalu besar untuk dikirim via Telegram (>50MB)', 'File Terlalu Besar'));
          return;
        }

        await editMarkdown(event, statusMessage('Menyiapkan file...', '📦'));

        const structure = files.map((f) => `📄 ${inlineCode(f.path)}`);
        const caption = formatRichMessage({
          title: '🤖 Project AI',
          blocks: [
            copyField('Arsip', `${projectName}.zip`),
          ],
          details: [
            `<b>Jumlah file:</b> ${inlineCode(files.length)}`,
            ...structure,
          ],
          note: explanation ? escapeMarkdown(explanation.slice(0, 300)) : undefined,
        });
        if (caption.text.length > 1024) caption.text = caption.text.slice(0, 1020) + '...';

        await sendFileMarkdown(client, chatId(event), zipPath, { caption });
        await editMarkdown(event, successMessage('Selesai! File telah dikirim.'));
      }
    } catch (err) {
      await editMarkdown(event, errorMessage(err.message, 'Gagal Membuat atau Mengirim File'));
    } finally {
      for (const p of createdPaths) cleanupFile(p);
    }
  });
}

module.exports = { register };

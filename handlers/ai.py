"""AI Chat handler - .ai <text> command"""
import os
import re
import zipfile
import aiohttp
from telethon import events
from utils.formatting import (
    edit_markdown, send_file_markdown, format_message, error_message, escape_markdown, inline_code,
)
from config import TEMP_DIR
from utils.cleanup import ensure_temp_dir, cleanup_file
from utils.helpers import sanitize_filename

# API config via environment variable
KRYNOX_API_KEY = os.environ.get("KRYNOX_API_KEY", "sk-b6329b943f8c7918-cm6mm3-948f895c")
KRYNOX_ENDPOINT = "https://ai.krynox.dev/v1/chat/completions"
KRYNOX_MODEL = "kc/minimax/minimax-m3:free"

# Fallback API (auto-switch when Krynox fails)
FALLBACK_ENDPOINT = "https://us-central1-conquer-apps-2ad61.cloudfunctions.net/prod/api.live"

AI_TIMEOUT = 180  # seconds
MAX_OUTPUT_LEN = 40960  # Telegram message limit


SYSTEM_PROMPT = (
    "Kamu adalah AI coding assistant yang sangat capable. "
    "Ketika user meminta dibuatkan project atau file coding:\n"
    "1. Hasilkan source code LENGKAP dan siap pakai, bukan potongan.\n"
    "2. Gunakan format khusus untuk setiap file:\n"
    "   ===FILE: path/to/filename.ext===\n"
    "   <isi file lengkap>\n"
    "   ===END_FILE===\n"
    "3. Tentukan nama file, ekstensi, dan struktur folder yang tepat.\n"
    "4. Sertakan semua file yang dibutuhkan (config, requirements, README, dll).\n"
    "5. Jika bukan permintaan coding/file, jawab langsung dengan teks biasa.\n"
    "6. Jangan gunakan markdown code block (```) di dalam blok ===FILE===.\n"
    "7. Pastikan setiap file memiliki kode yang lengkap dan fungsional."
)

# Regex to extract ===FILE: ...=== blocks
FILE_BLOCK_RE = re.compile(
    r'===FILE:\s*(.+?)\s*===\s*\n(.*?)\n\s*===END_FILE===',
    re.DOTALL
)


def _parse_files(text: str) -> list[dict]:
    """Extract file blocks from AI response. Returns list of {path, content}."""
    files = []
    for m in FILE_BLOCK_RE.finditer(text):
        filepath = m.group(1).strip().strip('"').strip("'")
        content = m.group(2)
        if filepath and content is not None:
            files.append({"path": filepath, "content": content})
    return files


def _clean_text_response(text: str) -> str:
    """Remove file blocks from text, return the remaining explanation."""
    cleaned = FILE_BLOCK_RE.sub('', text).strip()
    # Collapse multiple blank lines
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned


def _parse_sse_json(raw: str) -> dict:
    """Parse response that may be SSE (text/event-stream) or plain JSON."""
    import json as _json

    text = raw.strip()
    # Strip SSE tail
    if text.endswith("data: [DONE]"):
        text = text[: text.rfind("data: [DONE]")].strip()
    # Strip SSE prefix
    if text.startswith("data: "):
        text = text[len("data: "):].strip()

    try:
        return _json.loads(text)
    except _json.JSONDecodeError:
        m = re.search(r'(\{.*\})', text, re.DOTALL)
        if m:
            try:
                return _json.loads(m.group(1))
            except _json.JSONDecodeError:
                pass
        raise RuntimeError("Response AI tidak valid (bukan JSON)")


def _extract_content(data: dict) -> str:
    """Extract content from OpenAI-compatible response dict."""
    # Check for error
    err = data.get("error", {})
    if isinstance(err, dict) and err.get("message"):
        msg = err["message"]
        if "Rate limit" in msg or "429" in str(msg):
            raise RuntimeError("Rate limit tercapai")
        raise RuntimeError("AI error")

    choices = data.get("choices")
    if not choices:
        raise RuntimeError("AI tidak menghasilkan response")

    content = choices[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("AI menghasilkan response kosong")
    return content


async def _call_krynox(prompt: str) -> str:
    """Call Krynox AI API (primary)."""
    headers = {
        "Authorization": f"Bearer {KRYNOX_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": KRYNOX_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 16000,
        "temperature": 0.7,
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            KRYNOX_ENDPOINT,
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=AI_TIMEOUT),
        ) as resp:
            if resp.status >= 400:
                raise RuntimeError(f"Krynox HTTP {resp.status}")
            raw = await resp.text()

    data = _parse_sse_json(raw)
    return _extract_content(data)


async def _call_fallback(prompt: str) -> str:
    """Call fallback API (conquer-apps). No auth needed, uses 'prompt' field."""
    full_prompt = f"{SYSTEM_PROMPT}\n\nUser: {prompt}"
    payload = {
        "prompt": full_prompt,
        "max_tokens": 5000000,
        "n": 1,
        "temperature": 0.8,
        "top_p": 0.10,
    }

    import ssl
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    connector = aiohttp.TCPConnector(ssl=ssl_ctx)
    async with aiohttp.ClientSession(connector=connector) as session:
        async with session.post(
            FALLBACK_ENDPOINT,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=aiohttp.ClientTimeout(total=AI_TIMEOUT),
        ) as resp:
            if resp.status >= 400:
                raise RuntimeError(f"Fallback HTTP {resp.status}")
            raw = await resp.text()

    data = _parse_sse_json(raw)
    return _extract_content(data)


async def _call_ai(prompt: str) -> str:
    """
    Call AI with auto-fallback:
    1. Try Krynox (primary)
    2. If fails → switch to fallback API
    """
    # Try primary (Krynox)
    try:
        return await _call_krynox(prompt)
    except Exception:
        pass  # fallback below

    # Auto-switch to fallback
    return await _call_fallback(prompt)


def register(client):

    @client.on(events.NewMessage(pattern=r'^\.ai\s+(.+)', outgoing=True))
    async def ai_handler(event):
        prompt = event.pattern_match.group(1).strip()
        if not prompt:
            await edit_markdown(event, "❌ Masukkan teks setelah `.ai`")
            return

        await edit_markdown(event, "🤖 AI sedang memproses permintaan...")

        try:
            ai_response = await _call_ai(prompt)
        except RuntimeError as e:
            await edit_markdown(event, error_message(e))
            return
        except aiohttp.ClientError:
            await edit_markdown(event, "❌ Gagal terhubung ke server AI")
            return
        except Exception:
            await edit_markdown(event, "❌ Terjadi kesalahan saat menghubungi AI")
            return

        # Parse file blocks
        files = _parse_files(ai_response)

        if not files:
            # Text-only response
            if len(ai_response) <= MAX_OUTPUT_LEN:
                await edit_markdown(event, format_message("🤖 AI Response", escape_markdown(ai_response)))
            else:
                # Too long for message — send as .txt file
                ensure_temp_dir()
                txt_path = os.path.join(TEMP_DIR, "ai_response.txt")
                try:
                    with open(txt_path, "w", encoding="utf-8") as f:
                        f.write(ai_response)
                    await edit_markdown(event, "📤 Response terlalu panjang, mengirim sebagai file...")
                    await send_file_markdown(client, 
                        event.chat_id, txt_path,
                        caption="🤖 AI Response (terlalu panjang untuk chat)",
                    )
                    await edit_markdown(event, "✅ Selesai! File telah dikirim.")
                finally:
                    cleanup_file(txt_path)
            return

        # Has file blocks — create files
        await edit_markdown(event, "⚙️ AI sedang membuat source code...")
        ensure_temp_dir()

        explanation = _clean_text_response(ai_response)
        created_paths = []

        try:
            if len(files) == 1:
                # Single file — send directly
                f = files[0]
                filename = os.path.basename(f["path"])
                safe_name = sanitize_filename(os.path.splitext(filename)[0]) or "ai_file"
                ext = os.path.splitext(filename)[1] or ".txt"
                out_path = os.path.join(TEMP_DIR, f"{safe_name}{ext}")
                created_paths.append(out_path)

                with open(out_path, "w", encoding="utf-8") as fh:
                    fh.write(f["content"])

                await edit_markdown(event, "📦 Menyiapkan file...")

                caption = format_message(
                    "🤖 File AI",
                    details=[f"**Nama:** {inline_code(filename)}"],
                    note=escape_markdown(explanation[:700]) if explanation else None,
                )

                await send_file_markdown(client, 
                    event.chat_id, out_path,
                    caption=caption,
                )
                await edit_markdown(event, "✅ Selesai! File telah dikirim.")

            else:
                # Multiple files — create zip
                # Determine project name from common root or first directory
                first_path = files[0]["path"]
                project_name = first_path.split("/")[0] if "/" in first_path else "ai_project"
                project_name = sanitize_filename(project_name) or "ai_project"

                zip_path = os.path.join(TEMP_DIR, f"{project_name}.zip")
                created_paths.append(zip_path)

                await edit_markdown(event, "⚙️ Membuat struktur project...")

                with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                    for f in files:
                        zf.writestr(f["path"], f["content"])

                zip_size = os.path.getsize(zip_path)
                if zip_size > 50 * 1024 * 1024:
                    await edit_markdown(event, "❌ File terlalu besar untuk dikirim via Telegram (>50MB)")
                    return

                await edit_markdown(event, "📦 Menyiapkan file...")

                # Build structure preview
                structure = [f"📄 {inline_code(f['path'])}" for f in files]
                caption = format_message(
                    "🤖 Project AI",
                    details=[
                        f"**Arsip:** {inline_code(f'{project_name}.zip')}",
                        f"**Jumlah file:** `{len(files)}`",
                        *structure,
                    ],
                    note=escape_markdown(explanation[:300]) if explanation else None,
                )

                # Telegram caption limit
                if len(caption) > 1024:
                    caption = caption[:1020] + "..."

                await send_file_markdown(client, 
                    event.chat_id, zip_path,
                    caption=caption,
                )
                await edit_markdown(event, "✅ Selesai! File telah dikirim.")

        except Exception as e:
            await edit_markdown(event, error_message(e, "Gagal Membuat atau Mengirim File"))
        finally:
            for p in created_paths:
                cleanup_file(p)

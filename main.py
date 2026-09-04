#!/usr/bin/env python3
"""Telegram Userbot - Main Entry Point"""
import os
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from telethon import TelegramClient
from config import SESSION_NAME, load_config, save_config
from utils.cleanup import ensure_temp_dir
from utils.activity_logging import install_command_logging


async def setup_login():
    """Interactive login: API ID, API Hash, phone, OTP, 2FA."""
    print("=" * 50)
    print("  Telegram Userbot - Setup Login")
    print("=" * 50)

    cfg = load_config()
    api_id = cfg.get("api_id")
    api_hash = cfg.get("api_hash")

    if not api_id or not api_hash:
        print("\nDapatkan API ID & API Hash dari https://my.telegram.org\n")
        api_id = int(input("Masukkan API ID: ").strip())
        api_hash = input("Masukkan API Hash: ").strip()
        save_config(api_id, api_hash)
        print("✅ Config tersimpan.\n")
    else:
        print(f"\n✅ Config ditemukan (API ID: {api_id})")

    return api_id, api_hash


def register_handlers(client):
    """Register all command handlers behind centralized activity logging."""
    install_command_logging(client)
    from handlers import start, youtube, facebook, spotify, ai, videy
    from handlers import pinterest, tiktok, ttpic, mediafire, github
    from handlers import telegram_tools, tiktok_search, getchat, social_stalker, sticker, converter, infobot

    start.register(client)
    youtube.register(client)
    facebook.register(client)
    spotify.register(client)
    ai.register(client)
    videy.register(client)
    pinterest.register(client)
    tiktok.register(client)
    ttpic.register(client)
    mediafire.register(client)
    github.register(client)
    telegram_tools.register(client)
    tiktok_search.register(client)
    getchat.register(client)
    social_stalker.register(client)
    sticker.register(client)
    converter.register(client)
    infobot.register(client)


async def main():
    ensure_temp_dir()

    api_id, api_hash = await setup_login()

    os.makedirs(os.path.dirname(SESSION_NAME), exist_ok=True)

    client = TelegramClient(SESSION_NAME, api_id, api_hash)

    await client.start()

    me = await client.get_me()
    print(f"\n✅ Login berhasil sebagai: {me.first_name} (@{me.username or 'N/A'})")
    print(f"📱 Phone: +{me.phone}")
    print(f"\n🤖 Userbot aktif! Ketik .start di chat Telegram mana saja.")
    print("   Tekan Ctrl+C untuk berhenti.\n")

    register_handlers(client)

    await client.run_until_disconnected()


if __name__ == "__main__":
    import asyncio

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Userbot dihentikan.")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)

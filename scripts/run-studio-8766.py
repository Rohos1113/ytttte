"""Запуск Studio из этого checkout на порту 8766 (не трогая .env)."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

# До импорта настроек: порт фиксирован, иначе сервер займёт 8765.
os.environ["WEB_PORT"] = "8766"
os.environ.setdefault("WEB_HOST", "127.0.0.1")

import app.bootstrap_env  # noqa: E402,F401
from app.main import main  # noqa: E402

if __name__ == "__main__":
    asyncio.run(main())

"""Оптимизация MP4-видео для мгновенного веб-стриминга (moov atom faststart)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from loguru import logger


def optimize_mp4_faststart(path: Path) -> bool:
    """Перемещает moov-атом в начало файла MP4 без перекодирования (-c copy).

    Это позволяет браузеру мгновенно начинать воспроизведение онлайн без
    предварительного скачивания всего файла целиком.
    """
    if not isinstance(path, Path):
        path = Path(path)

    if path.suffix.lower() != ".mp4" or not path.is_file():
        return False

    try:
        if path.stat().st_size < 32:
            return False
    except OSError:
        return False

    # Быстрая проверка: если moov уже в первых 64 КБ, файл уже оптимизирован
    try:
        with path.open("rb") as f:
            header = f.read(65536)
            if b"moov" in header:
                return True
    except Exception:
        return False

    tmp_out = path.with_suffix(".faststart.mp4")
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(tmp_out),
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=60)
        if res.returncode == 0 and tmp_out.is_file() and tmp_out.stat().st_size > 0:
            shutil.move(str(tmp_out), str(path))
            logger.debug("video_faststart: успешно оптимизирован {}", path.name)
            return True
        logger.debug("video_faststart: ffmpeg завершился с кодом {}: {}", res.returncode, res.stderr.decode("utf-8", errors="ignore"))
    except FileNotFoundError:
        # ffmpeg не установлен в PATH — пропускаем без ошибки
        logger.debug("video_faststart: ffmpeg не найден в PATH, пропускаем")
    except Exception as exc:  # noqa: BLE001
        logger.debug("video_faststart: ошибка при оптимизации {}: {}", path.name, exc)
    finally:
        if tmp_out.is_file():
            try:
                tmp_out.unlink()
            except OSError:
                pass

    return False

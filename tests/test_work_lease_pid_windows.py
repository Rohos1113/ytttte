"""BUG-011: живость pid на Windows и TTL шага.

Windows отвечает на ``os.kill(pid, 0)`` для мёртвого pid не
``ProcessLookupError``, а ``OSError`` [WinError 87] «Параметр задан неверно».
Старый ``_pid_alive`` считал любой ``OSError`` признаком живого процесса,
поэтому lease мёртвого процесса жил до конца TTL (час для шага) и проект
стоял: «advance: … занят живым step-lease (другой процесс) — пропуск такта».
"""

from __future__ import annotations

import errno

import app.services.work_lease as wl


def _win_error(winerror: int) -> OSError:
    exc = OSError(22, "Параметр задан неверно")
    exc.winerror = winerror  # type: ignore[attr-defined]
    return exc


def test_windows_dead_pid_is_not_alive(monkeypatch):
    monkeypatch.setattr(wl.os, "kill", lambda pid, sig: (_ for _ in ()).throw(_win_error(87)))
    assert wl._pid_alive(27960) is False


def test_windows_not_found_pid_is_not_alive(monkeypatch):
    monkeypatch.setattr(wl.os, "kill", lambda pid, sig: (_ for _ in ()).throw(_win_error(1168)))
    assert wl._pid_alive(27960) is False


def test_windows_access_denied_pid_is_alive(monkeypatch):
    """WinError 5 — процесс есть, просто чужой: lease трогать нельзя."""

    def _kill(pid: int, sig: int) -> None:
        raise _win_error(5)

    monkeypatch.setattr(wl.os, "kill", _kill)
    assert wl._pid_alive(4) is True


def test_posix_dead_pid_is_not_alive(monkeypatch):
    def _kill(pid: int, sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(wl.os, "kill", _kill)
    assert wl._pid_alive(999999) is False


def test_oserror_without_winerror_uses_errno(monkeypatch):
    def _kill(pid: int, sig: int) -> None:
        raise OSError(errno.EINVAL, "Invalid argument")

    monkeypatch.setattr(wl.os, "kill", _kill)
    assert wl._pid_alive(123) is False


def test_live_pid_is_alive(monkeypatch):
    monkeypatch.setattr(wl.os, "kill", lambda pid, sig: None)
    assert wl._pid_alive(4321) is True


def test_non_positive_pid_is_not_alive():
    assert wl._pid_alive(0) is False
    assert wl._pid_alive(-5) is False


def test_step_lease_ttl_is_short_enough_for_renew_loop():
    """Шаг продлевается каждые 10 минут (`pipeline._renew_loop`): TTL должен
    перекрывать два пропущенных продления, но не морозить проект час."""
    assert 20 * 60 <= wl.STEP_LEASE_TTL_S <= 40 * 60
    assert wl.DEFAULT_TTL_S["step"] == wl.STEP_LEASE_TTL_S

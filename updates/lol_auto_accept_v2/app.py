#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
롤 · 롤토체스 자동 수락 v2.1  (무콘솔 GUI)
==========================================

* 이 파일은 `app.pyw` 입니다. .pyw 로 저장되어 있어 더블클릭해도
  검은 CMD 창이 뜨지 않고 이 창만 뜹니다.
* 동작 원리는 engine.py 참고: 롤 클라이언트의 로컬 API(LCU)만 사용합니다.
  로그인 정보·토큰·화면 캡처를 쓰지 않고, 매칭 [수락] 버튼만 대신 눌러 줍니다.

v2.1 에서 달라진 점 — 원클릭 자동 업데이트
------------------------------------------
* 화면 맨 아래 줄의 [업데이트 확인] 을 누르면 새 버전이 있는지 확인합니다.
  (앱을 켤 때도 백그라운드에서 조용히 한 번 확인만 합니다. 실패·오프라인은 무시)
* 새 버전이 있으면 창 위쪽에 파란 배너로 알려 주기만 합니다.
* 실제 파일 교체는 **사용자가 [업데이트] 를 눌렀을 때만** 일어납니다.
* 받은 파일은 SHA-256 해시가 version.json 과 같고, ast.parse 문법 검사와
  APP_VERSION 확인까지 통과할 때만 app.pyw.bak 으로 백업한 뒤 교체합니다.
  어느 하나라도 어긋나면 원본을 그대로 두고 취소합니다.
* 통신은 오직 https://coo714.github.io/pickle-games/updates/lol_auto_accept_v2/
  의 version.json 과 app.py 두 곳뿐입니다. 설정(settings.json)은 건드리지 않습니다.
"""

import ast
import hashlib
import hmac
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
from pathlib import Path
from tkinter import messagebox
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

# 어디서 실행하든 같은 폴더의 engine.py 를 찾을 수 있게 한다
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from engine import AutoAcceptEngine, ACCEPT_DELAY, LEVEL_DONE, LEVEL_FOUND, LEVEL_IDLE, LEVEL_OK, LEVEL_WARN

APP_TITLE = "롤 · 롤토체스 자동 수락"
APP_VERSION = "2.1.0"

# --- 자동 업데이트 (GitHub Pages 고정 주소) ---------------------------------
UPDATE_SITE_LABEL = "coo714.github.io"
UPDATE_PATH_PREFIX = "/pickle-games/updates/lol_auto_accept_v2/"
UPDATE_BASE_URL = "https://" + UPDATE_SITE_LABEL + UPDATE_PATH_PREFIX.rstrip("/")
UPDATE_VERSION_URL = UPDATE_BASE_URL + "/version.json"
UPDATE_APP_URL = UPDATE_BASE_URL + "/app.py"
UPDATE_TIMEOUT = 6.0
UPDATE_CHECK_DELAY_MS = 1100     # 앱이 뜬 뒤 조용히 한 번 확인하는 시점
UPDATE_FIRST_POLL_MS = 400
UPDATE_POLL_MS = 300
UPDATE_RESTART_DELAY_MS = 700    # 교체 후 다시 시작까지 (1초 안)
BANNER_H = 40

# ---------------------------------------------------------------------------
# 색 (롤 클라이언트 감성 다크 + 골드 포인트)
# ---------------------------------------------------------------------------
BG = "#0A1428"
CARD = "#0F1B31"
CARD_SOFT = "#0C1628"
BORDER = "#22304C"
GOLD = "#C8AA6E"
GOLD_DEEP = "#3A3222"
GREEN = "#38D97C"
GREEN_DEEP = "#12351F"
BLUE = "#5AA0FF"
BLUE_DEEP = "#123055"
BANNER_BG = "#1F5BD8"
BANNER_TEXT = "#FFFFFF"
RED = "#FF6F6F"
TEXT = "#E8EEF9"
MUTED = "#7E8CA8"
TRACK_OFF = "#182742"
KNOB_OFF = "#5C6B88"

LEVEL_COLORS = {
    LEVEL_IDLE: MUTED,
    LEVEL_OK: BLUE,
    LEVEL_FOUND: GOLD,
    LEVEL_DONE: GREEN,
    LEVEL_WARN: RED,
}

WIDTH = 424
HEADER_H = 62
BODY_H = 496
FOOTER_H = 58
HEIGHT = HEADER_H + BODY_H + FOOTER_H
PAD = 20
CONTENT_W = WIDTH - PAD * 2

SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")


# ---------------------------------------------------------------------------
# 자동 업데이트 (GitHub Pages version.json + SHA-256 검증)
# ---------------------------------------------------------------------------
class UpdateError(Exception):
    """업데이트 실패 (사용자에게 그대로 보여 줄 한국어 안내)."""


_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){0,3}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_APP_VERSION_LINE_RE = re.compile(
    r"^APP_VERSION\s*=\s*[\"']([0-9]+(?:\.[0-9]+){0,3})[\"']", re.MULTILINE)


def parse_version(text):
    """'2.1.0' / 'v2.1' → (2, 1, 0). 형식이 아니면 UpdateError."""
    raw = str(text or "").strip().lower()
    if raw.startswith("v"):
        raw = raw[1:].strip()
    if not _VERSION_RE.match(raw):
        raise UpdateError("버전 형식을 읽을 수 없어요: {}".format(text))
    numbers = [int(part) for part in raw.split(".")]
    while len(numbers) < 3:
        numbers.append(0)
    return tuple(numbers)


def real_version(text):
    """버전 문자열로 인정할 수 있는 형식인지."""
    raw = str(text or "").strip().lower()
    if raw.startswith("v"):
        raw = raw[1:].strip()
    return bool(_VERSION_RE.match(raw))


def is_newer_version(latest, current=APP_VERSION):
    """latest 가 current 보다 새 버전인지."""
    try:
        return parse_version(latest) > parse_version(current)
    except UpdateError:
        return False


def version_text(version):
    """'2.1.0' → 'v2.1.0' (이미 v 가 있으면 그대로)."""
    raw = str(version or "").strip()
    return raw if raw.lower().startswith("v") else "v" + raw


def is_official_update_url(url):
    """공식 주소(https + coo714.github.io + 정해진 경로)인지 확인합니다."""
    try:
        parts = urlsplit(str(url or "").strip())
    except ValueError:
        return False
    if parts.scheme.lower() != "https":
        return False
    if (parts.hostname or "").lower() != UPDATE_SITE_LABEL:
        return False
    if parts.username or parts.password or parts.port:
        return False
    if ".." in parts.path.split("/"):
        return False
    return parts.path.startswith(UPDATE_PATH_PREFIX)


def fetch_url(url, timeout=UPDATE_TIMEOUT):
    """업데이트 파일을 HTTPS 로 받아 옵니다 (공식 주소만)."""
    if not is_official_update_url(url):
        raise UpdateError("공식 주소가 아니라서 받지 않습니다: {}".format(url))
    request = Request(url, headers={"User-Agent": "LolAutoAccept/{}".format(APP_VERSION)})
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - https 고정 주소
            return response.read()
    except Exception as error:
        raise UpdateError("업데이트 서버에 연결하지 못했어요: {}".format(error))


def parse_manifest(raw):
    """version.json 을 검증해서 필요한 값만 꺼냅니다.

    형식: {"version": "2.2.0", "url": "https://.../app.py", "sha256": "...", "notes": "..."}
    """
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            raise UpdateError("업데이트 정보를 읽을 수 없어요(인코딩 오류).")
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except ValueError:
            raise UpdateError("업데이트 정보(version.json)를 읽을 수 없어요.")
    else:
        data = raw
    if not isinstance(data, dict):
        raise UpdateError("업데이트 정보 형식이 올바르지 않아요.")

    version = str(data.get("version") or "").strip()
    if not real_version(version):
        raise UpdateError("업데이트 정보에 올바른 버전이 없어요.")

    app_url = str(data.get("url") or data.get("app_url") or "").strip()
    if not app_url:
        raise UpdateError("업데이트 정보에 파일 주소가 없어요.")
    if not is_official_update_url(app_url):
        raise UpdateError(
            "업데이트 주소가 공식 주소({})가 아니라서 받지 않습니다.".format(UPDATE_SITE_LABEL))

    sha256 = str(data.get("sha256") or "").strip().lower()
    if not _SHA256_RE.match(sha256):
        raise UpdateError("업데이트 정보의 SHA-256 값이 없거나 올바르지 않아요.")

    notes = str(data.get("notes") or "").strip()
    return {"version": version, "url": app_url, "sha256": sha256, "notes": notes}


def fetch_manifest(fetch=None, url=UPDATE_VERSION_URL):
    """version.json 을 받아 검증합니다. 실패하면 UpdateError."""
    fetch = fetch or fetch_url
    return parse_manifest(fetch(url))


def check_for_update(current=APP_VERSION, fetch=None, url=UPDATE_VERSION_URL):
    """새 버전이 있으면 version.json 정보를, 없거나 실패하면 None.

    네트워크 오류·서버 오류는 모두 조용히 무시합니다 (앱 실행을 방해하지 않음).
    """
    try:
        manifest = fetch_manifest(fetch, url)
    except Exception:
        return None
    return manifest if is_newer_version(manifest["version"], current) else None


def check_for_update_status(current=APP_VERSION, fetch=None, url=UPDATE_VERSION_URL):
    """확인 결과를 'new' / 'latest' / 'error' 로 나누어 돌려줍니다.

    실패를 "최신 버전" 이라고 잘못 안내하지 않기 위해 따로 둡니다.
    """
    try:
        manifest = fetch_manifest(fetch, url)
    except Exception:
        return "error", None
    if is_newer_version(manifest["version"], current):
        return "new", manifest
    return "latest", None


def source_version(data):
    """받은 파이썬 파일 안의 APP_VERSION 문자열."""
    if isinstance(data, (bytes, bytearray)):
        try:
            text = bytes(data).decode("utf-8")
        except UnicodeDecodeError:
            raise UpdateError("새 파일을 읽을 수 없어요(인코딩 오류). 업데이트를 취소했어요.")
    else:
        text = str(data)
    match = _APP_VERSION_LINE_RE.search(text)
    return match.group(1) if match else ""


def verify_python_source(data, expected_version=""):
    """받은 파일이 올바른 파이썬 코드이고 이 앱인지 확인 (ast.parse + APP_VERSION)."""
    if isinstance(data, (bytes, bytearray)):
        try:
            text = bytes(data).decode("utf-8")
        except UnicodeDecodeError:
            raise UpdateError("새 파일을 읽을 수 없어요(인코딩 오류). 업데이트를 취소했어요.")
    else:
        text = str(data)
    try:
        ast.parse(text)
    except SyntaxError as error:
        raise UpdateError(
            "새 파일이 올바른 코드가 아니에요({}). 업데이트를 취소했어요.".format(error.msg))
    if "APP_VERSION" not in text or "def main(" not in text:
        raise UpdateError("새 파일이 이 프로그램이 맞는지 확인하지 못했어요. 업데이트를 취소했어요.")
    found = source_version(text)
    if not found:
        raise UpdateError("새 파일에서 버전(APP_VERSION)을 찾지 못했어요. 업데이트를 취소했어요.")
    if expected_version and parse_version(found) != parse_version(expected_version):
        raise UpdateError(
            "새 파일의 버전({})이 안내된 버전({})과 달라요. 업데이트를 취소했어요.".format(
                version_text(found), version_text(expected_version)))


def verify_update_payload(data, expected_sha256, expected_version=""):
    """SHA-256 + 코드 검증. 통과하면 실제 해시값을 돌려줍니다."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    if not expected_sha256:
        raise UpdateError("SHA-256 값이 없어 검증할 수 없어요. 업데이트를 취소했어요.")
    digest = hashlib.sha256(data).hexdigest()
    if not hmac.compare_digest(digest, str(expected_sha256).strip().lower()):
        raise UpdateError(
            "받은 파일이 원본과 달라요(SHA-256 불일치). 안전을 위해 업데이트를 취소했어요.")
    verify_python_source(data, expected_version)
    return digest


def download_update(manifest, fetch=None, app_path=None):
    """업데이트 파일을 받아 검증한 뒤 임시 파일로 저장합니다.

    검증에 실패하면 아무 파일도 바꾸지 않고 UpdateError 를 냅니다.
    """
    fetch = fetch or fetch_url
    manifest = parse_manifest(manifest)
    data = fetch(manifest["url"])
    verify_update_payload(data, manifest["sha256"], manifest["version"])

    base = Path(app_path).parent if app_path else Path(tempfile.gettempdir())
    try:
        base.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            mode="wb", prefix="app_update_", suffix=".py", dir=str(base), delete=False)
        with handle:
            handle.write(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))
        return Path(handle.name)
    except OSError as error:
        raise UpdateError("업데이트 파일을 저장하지 못했어요: {}".format(error))


def install_update(new_file, app_path, backup=True, expected_version=""):
    """검증된 새 파일로 app.pyw 를 교체합니다. 실패하면 원래 파일을 되돌립니다."""
    app_path = Path(app_path)
    backup_path = app_path.with_name(app_path.name + ".bak")
    staged = app_path.with_name(app_path.name + ".new")
    had_original = app_path.is_file()
    original = app_path.read_bytes() if had_original else b""

    try:
        shutil.copyfile(str(new_file), str(staged))
        verify_python_source(staged.read_bytes(), expected_version)
        if backup and had_original:
            shutil.copy2(str(app_path), str(backup_path))
        os.replace(str(staged), str(app_path))
    except UpdateError:
        _safe_unlink(staged)
        raise
    except OSError as error:
        # 롤백: 원래 파일을 그대로 되돌립니다
        if had_original:
            try:
                app_path.write_bytes(original)
            except OSError:
                pass
        _safe_unlink(staged)
        raise UpdateError(
            "파일을 바꾸지 못했어요({}). 원래 파일을 그대로 되돌렸어요.".format(error))

    return {
        "path": str(app_path),
        "backup": str(backup_path) if backup and had_original else "",
    }


def perform_update(manifest, app_path, fetch=None):
    """다운로드 → 검증 → 교체를 한 번에. 어느 단계라도 실패하면 원본 유지."""
    new_file = download_update(manifest, fetch=fetch, app_path=app_path)
    try:
        return install_update(new_file, app_path, expected_version=manifest["version"])
    finally:
        _safe_unlink(new_file)


def _safe_unlink(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def _no_window_flags():
    """검은 CMD 창이 뜨지 않게 하는 윈도우 프로세스 플래그."""
    if os.name != "nt":
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)) | \
        int(getattr(subprocess, "DETACHED_PROCESS", 0x00000008))


def restart_application(app_path=None, python_executable=None, popen=None, exists=None):
    """업데이트한 앱을 새 프로세스로 다시 띄웁니다 (콘솔 창 없이)."""
    app_path = Path(app_path or __file__).resolve()
    exists = exists or os.path.exists
    popen = popen or subprocess.Popen
    executable = str(python_executable or sys.executable)
    if os.name == "nt":
        windowless = str(Path(executable).with_name("pythonw.exe"))
        if exists(windowless):
            executable = windowless
    argv = [executable, str(app_path)]
    kwargs = {"cwd": str(app_path.parent), "close_fds": True}
    flags = _no_window_flags()
    if flags:
        kwargs["creationflags"] = flags
    popen(argv, **kwargs)
    return argv


# ---------------------------------------------------------------------------
# 작은 도형 도우미
# ---------------------------------------------------------------------------
def rounded_rect(canvas, x1, y1, x2, y2, radius, **kwargs):
    """모서리가 둥근 사각형."""
    radius = min(radius, abs(x2 - x1) / 2, abs(y2 - y1) / 2)
    points = [
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
    ]
    return canvas.create_polygon(points, smooth=True, **kwargs)


def pick_font(families, candidates, default="TkDefaultFont"):
    lowered = {name.lower(): name for name in families}
    for candidate in candidates:
        found = lowered.get(candidate.lower())
        if found:
            return found
    return default


# ---------------------------------------------------------------------------
# 캔버스 버튼 (플랫폼 상관없이 같은 모양)
# ---------------------------------------------------------------------------
class CanvasButton(tk.Canvas):
    def __init__(self, master, text, command, family, width=96, height=26,
                 bg=CARD_SOFT, fg=GOLD, line=BORDER, hover=None, font_size=9,
                 bold=True, radius=11, parent_bg=BG):
        super().__init__(master, width=width, height=height, bg=parent_bg,
                         highlightthickness=0, bd=0, cursor="hand2")
        self.text = text
        self.command = command
        self.family = family
        self.w = width
        self.h = height
        self.bg_color = bg
        self.fg_color = fg
        self.line_color = line
        self.hover_color = hover or bg
        self.font_size = font_size
        self.bold = bold
        self.radius = radius
        self.enabled = True
        self.bind("<Button-1>", self._clicked)
        self.bind("<Enter>", lambda e: self._paint(self.hover_color))
        self.bind("<Leave>", lambda e: self._paint(self.bg_color))
        self.draw()

    def _paint(self, fill):
        self.itemconfigure("body", fill=fill if self.enabled else self.bg_color)

    def _clicked(self, _event=None):
        if self.enabled:
            self.invoke()

    def invoke(self):
        """버튼 명령을 실행합니다 (테스트에서도 같은 경로)."""
        if self.enabled and self.command:
            return self.command()
        return None

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        self.configure(cursor="hand2" if self.enabled else "arrow")
        self.itemconfigure("label", fill=self.fg_color if self.enabled else MUTED)
        self._paint(self.bg_color)

    def set_text(self, text):
        self.text = text
        self.itemconfigure("label", text=text)

    def draw(self):
        self.delete("all")
        rounded_rect(self, 1, 1, self.w - 1, self.h - 1, self.radius,
                     fill=self.bg_color, outline=self.line_color, width=1, tags="body")
        self.create_text(self.w / 2, self.h / 2, text=self.text, fill=self.fg_color,
                         font=(self.family, self.font_size, "bold" if self.bold else "normal"),
                         tags="label")


# ---------------------------------------------------------------------------
# 스위치 (캔버스로 그린 큰 ON/OFF 토글)
# ---------------------------------------------------------------------------
class ToggleSwitch(tk.Canvas):
    TRACK_W = 300
    TRACK_H = 62
    KNOB_R = 24

    def __init__(self, master, family, command=None, on=False):
        super().__init__(master, width=self.TRACK_W, height=self.TRACK_H,
                         bg=BG, highlightthickness=0, bd=0, cursor="hand2")
        self.family = family
        self.command = command
        self.on = bool(on)
        self._knob_x = None
        self._anim_job = None
        self.bind("<Button-1>", self._clicked)
        self.bind("<Enter>", lambda e: self.config(cursor="hand2"))
        self.draw(animate=False)

    # -- 좌표 -------------------------------------------------------------
    def _left_knob_x(self):
        return self.KNOB_R + 7

    def _right_knob_x(self):
        return self.TRACK_W - self.KNOB_R - 7

    def _clicked(self, _event=None):
        self.on = not self.on
        self.draw(animate=True)
        if self.command:
            self.command(self.on)

    def set_state(self, on, animate=True):
        if self.on == bool(on):
            return
        self.on = bool(on)
        self.draw(animate=animate)

    # -- 그리기 -----------------------------------------------------------
    def draw(self, animate=True):
        self.delete("all")
        target = self._right_knob_x() if self.on else self._left_knob_x()
        if self._knob_x is None or not animate:
            self._knob_x = target

        track_fill = GREEN_DEEP if self.on else TRACK_OFF
        track_line = GREEN if self.on else BORDER
        rounded_rect(self, 1, 1, self.TRACK_W - 1, self.TRACK_H - 1, self.TRACK_H / 2,
                     fill=track_fill, outline=track_line, width=2)

        # 상태 글자
        label = "ON" if self.on else "OFF"
        color = GREEN if self.on else MUTED
        text_x = 68 if self.on else self.TRACK_W - 68
        self.create_text(text_x, self.TRACK_H / 2, text=label, fill=color,
                         font=(self.family, 15, "bold"))

        # 손잡이
        knob_color = GREEN if self.on else KNOB_OFF
        cy = self.TRACK_H / 2
        self.create_oval(self._knob_x - self.KNOB_R, cy - self.KNOB_R,
                         self._knob_x + self.KNOB_R, cy + self.KNOB_R,
                         fill=knob_color, outline="", tags="knob")

        if animate:
            self._slide_to(target)

    def _slide_to(self, target):
        if self._anim_job:
            try:
                self.after_cancel(self._anim_job)
            except Exception:
                pass
            self._anim_job = None
        step = max(6.0, abs(target - self._knob_x) / 4.0)
        if abs(target - self._knob_x) <= step:
            self._knob_x = target
            self.draw(animate=False)
            return
        self._knob_x += step if target > self._knob_x else -step
        cy = self.TRACK_H / 2
        self.coords("knob",
                    self._knob_x - self.KNOB_R, cy - self.KNOB_R,
                    self._knob_x + self.KNOB_R, cy + self.KNOB_R)
        self._anim_job = self.after(16, lambda: self._slide_to(target))


# ---------------------------------------------------------------------------
# 지연 선택 (두 칸짜리 세그먼트 버튼)
# ---------------------------------------------------------------------------
class SegmentedDelay(tk.Canvas):
    HEIGHT = 46

    def __init__(self, master, family, command=None, delay=ACCEPT_DELAY):
        super().__init__(master, width=CONTENT_W, height=self.HEIGHT,
                         bg=BG, highlightthickness=0, bd=0, cursor="hand2")
        self.family = family
        self.command = command
        self.delay = 0.0 if delay <= 0 else ACCEPT_DELAY
        self.options = [(ACCEPT_DELAY, "1.0초 지연"), (0.0, "즉시 수락")]
        self.bind("<Button-1>", self._clicked)
        self.draw()

    def set_delay(self, delay):
        self.delay = 0.0 if delay <= 0 else ACCEPT_DELAY
        self.draw()

    def _clicked(self, event):
        half = CONTENT_W / 2
        index = 0 if event.x < half else 1
        value = self.options[index][0]
        if value != self.delay:
            self.delay = value
            self.draw()
            if self.command:
                self.command(value)

    def draw(self):
        self.delete("all")
        half = CONTENT_W / 2
        for index, (value, label) in enumerate(self.options):
            x1 = index * half + 1
            x2 = x1 + half - 2
            selected = (value == self.delay)
            rounded_rect(self, x1, 1, x2, self.HEIGHT - 1, 12,
                         fill=GOLD_DEEP if selected else CARD_SOFT,
                         outline=GOLD if selected else BORDER,
                         width=2 if selected else 1)
            self.create_text((x1 + x2) / 2, self.HEIGHT / 2, text=label,
                             fill=GOLD if selected else MUTED,
                             font=(self.family, 11, "bold" if selected else "normal"))


# ---------------------------------------------------------------------------
# 앱
# ---------------------------------------------------------------------------
class AutoAcceptApp(tk.Tk):
    def __init__(self, fetch=None):
        super().__init__()
        self.withdraw()
        self.title("{} {}".format(APP_TITLE, version_text(APP_VERSION)))
        self.configure(bg=BG)
        self.resizable(False, False)
        self.geometry("{}x{}".format(WIDTH, HEIGHT))
        self._center_window()

        families = set(tkfont.families(self))
        self.family = pick_font(families, ["Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR",
                                           "AppleGothic", "NanumGothic"])
        self.mono = pick_font(families, ["Consolas", "D2Coding", "Noto Sans Mono CJK KR", "Courier New"],
                              default=self.family)

        self._events = queue.Queue()
        self._last_accept_time = None
        self._log_lines = []
        self.engine = AutoAcceptEngine(accept_delay=self._load_delay(), on_event=self._on_engine_event)
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self.engine.run_forever,
                                        args=(self._stop,), daemon=True)

        # --- 업데이트 상태 -------------------------------------------------
        self.app_file = Path(os.path.abspath(__file__))
        self.fetch = fetch or fetch_url
        self.latest_update = None
        self._update_queue = queue.Queue()
        self._update_busy = False
        self._dialog = None
        self._banner_visible = False
        self._closed = False

        self._build()
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.bind("<Escape>", lambda e: self._close())
        self.bind("<space>", lambda e: self.switch._clicked())

        self.deiconify()
        self._worker.start()
        self._log("준비 완료. 스위치를 켜면 매칭을 감시합니다.")
        self._drain_job = self.after(120, self._drain_events)
        self._poll_job = self.after(UPDATE_FIRST_POLL_MS, self._poll_update_queue)
        self._check_job = self.after(UPDATE_CHECK_DELAY_MS, self.start_update_check)

    # -- 창 ---------------------------------------------------------------
    def _center_window(self):
        self.update_idletasks()
        try:
            screen_w = self.winfo_screenwidth()
            screen_h = self.winfo_screenheight()
            x = max(0, (screen_w - WIDTH) // 2)
            y = max(0, (screen_h - HEIGHT) // 3)
        except Exception:
            x = y = 100
        self._pos = (x, y)
        self.geometry("{}x{}+{}+{}".format(WIDTH, HEIGHT, x, y))

    def _label(self, master, text, size, color, bold=False, bg=None, anchor="w"):
        return tk.Label(master, text=text, bg=bg or BG, fg=color,
                        font=(self.family, size, "bold" if bold else "normal"),
                        anchor=anchor, justify="left")

    # -- 화면 -------------------------------------------------------------
    def _build(self):
        self._build_update_banner()
        self._build_header()
        self._build_body()
        self._build_footer()

    def _build_header(self):
        header = tk.Frame(self, bg=BG, height=HEADER_H)
        header.pack(side="top", fill="x")
        header.pack_propagate(False)
        self._header = header

        self._label(header, "롤 · 롤토체스 자동 수락", 16, TEXT, bold=True).place(x=PAD, y=14)
        self._label(header, "LoL · TFT 모두 자동 수락 · 로그인/토큰 불필요", 9, MUTED).place(x=PAD, y=42)
        self._label(header, version_text(APP_VERSION), 9, GOLD, bold=True, anchor="e").place(
            x=WIDTH - PAD - 48, y=18, width=48)
        tk.Frame(header, bg=BORDER, height=1).place(x=PAD, y=HEADER_H - 1, width=CONTENT_W)

    def _build_body(self):
        body = tk.Frame(self, bg=BG, height=BODY_H)
        body.pack(side="top", fill="x")
        body.pack_propagate(False)
        self.body = body

        # 상태 카드
        card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        card.place(x=PAD, y=6, width=CONTENT_W, height=96)
        self.dot = tk.Canvas(card, width=14, height=14, bg=CARD, highlightthickness=0, bd=0)
        self.dot.place(x=16, y=22)
        self._dot_item = self.dot.create_oval(2, 2, 12, 12, fill=MUTED, outline="")
        self.status_title = self._label(card, "자동 수락 꺼짐", 14, TEXT, bold=True, bg=CARD)
        self.status_title.place(x=38, y=16, width=CONTENT_W - 150)
        self.status_detail = self._label(card, "스위치를 켜면 매칭을 감시합니다.", 9, MUTED, bg=CARD)
        self.status_detail.place(x=38, y=44, width=CONTENT_W - 40)

        self.chip = tk.Canvas(card, width=110, height=24, bg=CARD, highlightthickness=0, bd=0)
        self.chip.place(x=CONTENT_W - 126, y=16)
        self._chip_text = self.chip.create_text(55, 12, text="모드 대기", fill=MUTED,
                                                font=(self.family, 9))

        # 수락 지연
        self._label(body, "수락 지연", 9, MUTED).place(x=PAD, y=116)
        self.segment = SegmentedDelay(body, self.family, command=self._change_delay,
                                      delay=self.engine.accept_delay)
        self.segment.place(x=PAD, y=134)

        # 자동 수락 스위치
        self._label(body, "자동 수락", 10, TEXT, bold=True).place(x=PAD, y=196)
        self.switch_hint = self._label(body, "꺼짐", 9, MUTED, anchor="e")
        self.switch_hint.place(x=WIDTH - PAD - 90, y=197, width=90)
        self.switch = ToggleSwitch(body, self.family, command=self._toggle, on=False)
        self.switch.place(x=(WIDTH - ToggleSwitch.TRACK_W) // 2, y=220)

        # 누적 수락 카드
        counter = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        counter.place(x=PAD, y=296, width=CONTENT_W, height=78)
        self._label(counter, "누적 수락", 9, MUTED, bg=CARD).place(x=16, y=12)
        self.count_value = self._label(counter, "0", 24, GOLD, bold=True, bg=CARD)
        self.count_value.place(x=16, y=30)
        self.count_unit = self._label(counter, "회", 10, MUTED, bg=CARD)
        self.count_unit.place(x=36, y=44)
        self._label(counter, "마지막 수락", 9, MUTED, bg=CARD, anchor="e").place(
            x=CONTENT_W - 150, y=14, width=134)
        self.last_value = self._label(counter, "—", 12, TEXT, bold=True, bg=CARD, anchor="e")
        self.last_value.place(x=CONTENT_W - 150, y=34, width=134)

        # 기록
        self._label(body, "기록", 9, MUTED).place(x=PAD, y=384)
        log_card = tk.Frame(body, bg=CARD_SOFT, highlightbackground=BORDER, highlightthickness=1)
        log_card.place(x=PAD, y=402, width=CONTENT_W, height=88)
        self.log = tk.Text(log_card, bg=CARD_SOFT, fg=MUTED, bd=0, highlightthickness=0,
                           font=(self.mono, 8), wrap="none", cursor="arrow",
                           padx=10, pady=8, spacing1=1, spacing3=1)
        self.log.place(x=1, y=1, width=CONTENT_W - 2, height=86)
        self.log.configure(state="disabled")

    def _build_footer(self):
        """화면 맨 아래 고정 줄: 버전 + 업데이트 상태 + [업데이트 확인] + 안내."""
        footer = tk.Frame(self, bg=BG, height=FOOTER_H)
        footer.pack(side="bottom", fill="x")
        footer.pack_propagate(False)
        self._footer = footer

        tk.Frame(footer, bg=BORDER, height=1).place(x=PAD, y=4, width=CONTENT_W)

        row = tk.Frame(footer, bg=BG, height=30)
        row.place(x=PAD, y=6, width=CONTENT_W)
        self.version_label = self._label(row, version_text(APP_VERSION), 9, GOLD, bold=True)
        self.version_label.pack(side="left", padx=(0, 10))

        self.update_status_var = tk.StringVar(
            value="업데이트는 누를 때만 바뀝니다")
        self.update_status = tk.Label(row, textvariable=self.update_status_var, bg=BG,
                                      fg=MUTED, font=(self.family, 8), anchor="w", justify="left")
        self.update_status.pack(side="left", fill="x", expand=True)

        self.button_check = CanvasButton(
            row, "업데이트 확인", self.on_update_check, self.family,
            width=92, height=24, bg=CARD_SOFT, fg=GOLD, line=BORDER, hover=GOLD_DEEP,
            font_size=8, parent_bg=BG)
        self.button_check.pack(side="right")

        self._label(footer, "창을 닫으면 종료됩니다 · 매칭 수락만 하고 게임은 건드리지 않습니다",
                    8, MUTED).place(x=PAD, y=39)

    # -- 로그 -------------------------------------------------------------
    def _log(self, message):
        stamp = time.strftime("%H:%M:%S")
        line = "{}  {}".format(stamp, message)
        self._log_lines.append(line)
        if len(self._log_lines) > 40:
            self._log_lines = self._log_lines[-40:]
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.insert("1.0", "\n".join(self._log_lines[-5:]))
        self.log.see("end")
        self.log.configure(state="disabled")

    # -- 엔진 → 화면 -------------------------------------------------------
    def _on_engine_event(self, kind, payload):
        self._events.put((kind, payload))

    def _drain_events(self):
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == "status":
                    self._apply_status(payload)
                elif kind == "log":
                    self._log(payload)
                elif kind == "accepted":
                    self.count_value.configure(text=str(payload))
                    self._place_count_unit()
                    self._last_accept_time = time.strftime("%H:%M:%S")
                    self.last_value.configure(text=self._last_accept_time)
                    self._flash_count()
                elif kind == "found":
                    self._flash_dot(GOLD)
        except queue.Empty:
            pass
        if not self._closed:
            self._drain_job = self.after(120, self._drain_events)

    def _apply_status(self, status):
        color = LEVEL_COLORS.get(status.get("level"), MUTED)
        self.dot.itemconfigure(self._dot_item, fill=color)
        self.status_title.configure(text=status.get("title") or "", fg=TEXT)
        detail = status.get("detail") or ""
        self.status_detail.configure(text=detail[:46])
        queue_name = status.get("queue")
        if queue_name:
            self.chip.itemconfigure(self._chip_text, text=str(queue_name)[:14],
                                    fill=GOLD if status.get("level") == LEVEL_FOUND else MUTED)
        else:
            self.chip.itemconfigure(self._chip_text, text="모드 대기", fill=MUTED)

    def _place_count_unit(self):
        try:
            self.update_idletasks()
            x = 16 + self.count_value.winfo_reqwidth() + 2
        except Exception:
            x = 36
        self.count_unit.place(x=x, y=44)

    def _flash_dot(self, color):
        for index in range(3):
            self.after(index * 140, lambda c=color: self.dot.itemconfigure(self._dot_item, fill=c))

    def _flash_count(self):
        for color, delay_ms in ((GREEN, 0), (GOLD, 220), (GOLD, 440)):
            self.after(delay_ms, lambda c=color: self.count_value.configure(fg=c))

    # -- 조작 -------------------------------------------------------------
    def _toggle(self, on):
        self.switch_hint.configure(text="켜짐" if on else "꺼짐", fg=GREEN if on else MUTED)
        if on:
            self._apply_status({"title": "시작하는 중...", "detail": "롤 클라이언트를 찾습니다.",
                                "level": LEVEL_OK, "queue": None})
        else:
            self._apply_status({"title": "자동 수락 꺼짐", "detail": "매칭을 지켜보지 않습니다.",
                                "level": LEVEL_IDLE, "queue": None})
        self.engine.submit("enabled", on)

    def _change_delay(self, delay):
        self.engine.submit("delay", delay)
        self.switch_hint.configure(text="켜짐" if self.switch.on else "꺼짐",
                                   fg=GREEN if self.switch.on else MUTED)
        self._save_delay(delay)

    # -- 설정 저장 ---------------------------------------------------------
    def _load_delay(self):
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            delay = float(data.get("accept_delay", ACCEPT_DELAY))
            return 0.0 if delay <= 0 else ACCEPT_DELAY
        except (OSError, ValueError, TypeError):
            return ACCEPT_DELAY

    def _save_delay(self, delay):
        try:
            with open(SETTINGS_PATH, "w", encoding="utf-8") as fp:
                json.dump({"accept_delay": delay}, fp)
        except OSError:
            pass

    # -- 새 버전 배너 ------------------------------------------------------
    def _build_update_banner(self):
        """새 버전이 있을 때만 창 맨 위에 붙는 파란 줄 (처음에는 숨어 있음)."""
        banner = tk.Frame(self, bg=BANNER_BG, height=BANNER_H)
        self._banner = banner
        self.banner_var = tk.StringVar(value="")
        tk.Label(banner, textvariable=self.banner_var, bg=BANNER_BG, fg=BANNER_TEXT,
                 font=(self.family, 10, "bold"), anchor="w").place(x=PAD, y=11)

        self.banner_button = CanvasButton(
            banner, "업데이트 보기", self.on_banner_click, self.family,
            width=98, height=24, bg="#FFFFFF", fg=BANNER_BG, line="#FFFFFF",
            hover="#DCE7FF", font_size=8, parent_bg=BANNER_BG)
        self.banner_button.place(x=WIDTH - PAD - 98, y=8)

    def show_banner(self, manifest):
        """새 버전이 있음을 창 위쪽에 알립니다 (자동 교체는 하지 않음)."""
        self.latest_update = manifest
        text = "새 버전 {} 있음".format(version_text(manifest["version"]))
        self.banner_var.set(text)
        self.update_status_var.set("{} · [업데이트 보기]".format(text))
        if not self._banner_visible:
            self._banner.pack(side="top", fill="x", before=self._header)
            self._banner_visible = True
            self._resize_for_banner(True)

    def hide_banner(self):
        if not self._banner_visible:
            return
        try:
            self._banner.pack_forget()
        except Exception:
            pass
        self._banner_visible = False
        self._resize_for_banner(False)

    def _resize_for_banner(self, visible):
        """배너가 붙으면 창 높이를 그만큼 늘려 내용이 가려지지 않게 한다."""
        x, y = getattr(self, "_pos", (100, 100))
        height = HEIGHT + (BANNER_H if visible else 0)
        try:
            self.geometry("{}x{}+{}+{}".format(WIDTH, height, x, y))
        except Exception:
            pass

    def on_banner_click(self):
        if self.latest_update:
            self._open_update_dialog(self.latest_update)

    # -- 업데이트 확인 / 적용 ---------------------------------------------
    def _queue_update(self, kind, payload=None):
        self._update_queue.put((kind, payload))

    def _poll_update_queue(self):
        """백그라운드 스레드 결과를 화면 스레드에서 반영합니다."""
        try:
            while True:
                kind, payload = self._update_queue.get_nowait()
                try:
                    self._handle_update_event(kind, payload)
                except Exception:
                    pass
        except queue.Empty:
            pass
        if not self._closed:
            try:
                self._poll_job = self.after(UPDATE_POLL_MS, self._poll_update_queue)
            except Exception:
                pass

    def _handle_update_event(self, kind, payload):
        if kind == "check":
            status, manifest, interactive = payload
            self._after_check(status, manifest, interactive)
        elif kind == "download_ok":
            self._after_download_ok(payload)
        elif kind == "download_fail":
            self._after_download_fail(str(payload))

    def start_update_check(self, interactive=False):
        """앱이 뜬 뒤 조용히 한 번 확인 (네트워크 실패는 무시)."""
        self._run_check(interactive)

    def on_update_check(self):
        if self._update_busy:
            return
        self.update_status_var.set("업데이트 확인 중… 잠시만요")
        self._run_check(True)

    def _run_check(self, interactive):
        def worker():
            try:
                status, manifest = check_for_update_status(APP_VERSION, fetch=self.fetch)
            except Exception:
                status, manifest = "error", None
            self._queue_update("check", (status, manifest, interactive))

        try:
            threading.Thread(target=worker, daemon=True).start()
        except Exception:
            # 스레드를 못 만들면 화면을 멈추지 않도록 그냥 포기합니다.
            return
        self._update_busy = True

    def _after_check(self, status, manifest, interactive):
        self._update_busy = False
        if status == "error":
            if interactive:
                self.update_status_var.set("확인 실패 · 인터넷 연결을 확인해 주세요")
                self._log("업데이트 확인 실패: 업데이트 서버에 연결하지 못했습니다.")
            return
        if status != "new" or not manifest:
            self.update_status_var.set("지금이 최신 버전이에요")
            if interactive:
                self._log("업데이트 확인: 최신 버전({})입니다.".format(version_text(APP_VERSION)))
            return
        self.show_banner(manifest)
        self._log("새 버전 {} 이 있습니다.".format(version_text(manifest["version"])))
        if interactive:
            self._open_update_dialog(manifest)

    def _open_update_dialog(self, manifest):
        if self._dialog is not None:
            try:
                self._dialog.destroy()
            except Exception:
                pass
        dialog = tk.Toplevel(self)
        self._dialog = dialog
        dialog.title("업데이트 - " + APP_TITLE)
        dialog.configure(bg=CARD)
        dialog.resizable(False, False)
        dialog.transient(self)

        frame = tk.Frame(dialog, bg=CARD)
        frame.pack(fill="both", expand=True, padx=20, pady=16)

        self._label(frame, "새 버전이 나왔어요", 14, TEXT, bold=True, bg=CARD).pack(anchor="w")
        self._label(frame, "{}  →  {}".format(version_text(APP_VERSION),
                                              version_text(manifest["version"])),
                    12, GOLD, bold=True, bg=CARD).pack(anchor="w", pady=(6, 0))

        notes = manifest.get("notes") or "새 버전이 준비되었습니다."
        box = tk.Frame(frame, bg=CARD_SOFT, highlightbackground=BORDER, highlightthickness=1)
        box.pack(fill="x", pady=(12, 0))
        self._label(box, "업데이트 내용", 8, MUTED, bg=CARD_SOFT).pack(fill="x", padx=10, pady=(8, 0))
        self._label(box, notes, 9, TEXT, bg=CARD_SOFT).pack(fill="x", padx=10, pady=(2, 9))

        self._label(frame, "출처: {}".format(UPDATE_SITE_LABEL), 8, MUTED, bg=CARD).pack(
            fill="x", pady=(10, 0))
        self._label(frame, "SHA-256 지문을 대조해 원본과 같고 문법 검사도 통과할 때만\n"
                           "app.pyw.bak 으로 백업한 뒤 파일을 바꿉니다.\n"
                           "설정(settings.json)은 그대로 유지됩니다.",
                    8, MUTED, bg=CARD).pack(fill="x", pady=(2, 0))

        self.dialog_status_var = tk.StringVar(value="")
        self.dialog_status = tk.Label(frame, textvariable=self.dialog_status_var, bg=CARD,
                                      fg=GREEN, font=(self.family, 8), anchor="w",
                                      justify="left", wraplength=400)
        self.dialog_status.pack(fill="x", pady=(8, 0))

        buttons = tk.Frame(frame, bg=CARD)
        buttons.pack(fill="x", pady=(12, 0))
        self.dialog_update_button = CanvasButton(
            buttons, "업데이트", lambda: self.on_start_update(manifest), self.family,
            width=96, height=30, bg=GOLD_DEEP, fg=GOLD, line=GOLD, hover="#4A4030",
            font_size=10, parent_bg=CARD)
        self.dialog_update_button.pack(side="right")
        CanvasButton(buttons, "나중에", self._close_dialog, self.family,
                     width=76, height=30, bg=CARD_SOFT, fg=MUTED, line=BORDER,
                     hover=CARD_SOFT, font_size=9, parent_bg=CARD).pack(side="right", padx=(0, 8))

        dialog.update_idletasks()
        try:
            x = self.winfo_rootx() + (self.winfo_width() - dialog.winfo_reqwidth()) // 2
            y = self.winfo_rooty() + 140
            dialog.geometry("+{}+{}".format(max(0, x), max(0, y)))
        except Exception:
            pass
        try:
            dialog.grab_set()
        except Exception:
            pass

    def _close_dialog(self):
        try:
            if self._dialog is not None:
                self._dialog.grab_release()
        except Exception:
            pass
        try:
            if self._dialog is not None:
                self._dialog.destroy()
        except Exception:
            pass
        self._dialog = None

    def on_start_update(self, manifest):
        """사용자가 [업데이트] 를 누른 뒤에만 진행. 다운로드·검증은 백그라운드."""
        if self._update_busy:
            return
        self._update_busy = True
        self.dialog_status_var.set("내려받는 중…")
        try:
            self.dialog_update_button.set_enabled(False)
        except Exception:
            pass

        def worker():
            try:
                new_file = download_update(manifest, fetch=self.fetch, app_path=self.app_file)
                self._queue_update("download_ok", new_file)
            except UpdateError as error:
                self._queue_update("download_fail", str(error))
            except Exception as error:
                self._queue_update(
                    "download_fail", "업데이트 파일을 받지 못했어요: {}".format(error))

        threading.Thread(target=worker, daemon=True).start()

    def _after_download_ok(self, new_file):
        try:
            self.dialog_status_var.set("검증 완료 · 파일을 바꾸고 다시 시작합니다")
            install_update(new_file, self.app_file, expected_version=self.latest_update["version"]
                           if self.latest_update else "")
        except UpdateError as error:
            self._after_download_fail(str(error))
            return
        finally:
            _safe_unlink(new_file)
        self._update_busy = False
        self.update_status_var.set("업데이트 완료 · 다시 시작 중")
        self._log("업데이트를 마쳤어요. 잠시 뒤 새 버전으로 다시 시작합니다.")
        self._restart_job = self.after(UPDATE_RESTART_DELAY_MS, self._restart_after_update)

    def _after_download_fail(self, message):
        self._update_busy = False
        try:
            self.dialog_update_button.set_enabled(True)
        except Exception:
            pass
        try:
            if self._dialog is not None:
                self.dialog_status_var.set(message)
        except Exception:
            pass
        self.update_status_var.set("업데이트를 하지 않았어요 · 원래 버전 그대로")
        self._log(message)

    def _restart_after_update(self):
        try:
            restart_application(self.app_file)
        except Exception as error:
            self._log("다시 시작하지 못했어요: {}. 앱을 직접 다시 열어 주세요.".format(error))
            return
        self._close()

    # -- 종료 -------------------------------------------------------------
    def _close(self):
        if self._closed:
            return
        self._closed = True
        for job in (getattr(self, "_drain_job", None), getattr(self, "_poll_job", None),
                    getattr(self, "_check_job", None), getattr(self, "_restart_job", None)):
            if job:
                try:
                    self.after_cancel(job)
                except Exception:
                    pass
        try:
            self._save_delay(self.engine.accept_delay)
        except Exception:
            pass
        self._stop.set()
        self.engine.stop()
        try:
            self.destroy()
        except Exception:
            pass


def enable_dpi_awareness():
    """윈도우 고해상도에서 글자가 흐려지지 않게 한다."""
    if os.name != "nt":
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def main():
    enable_dpi_awareness()
    try:
        app = AutoAcceptApp()
        app.mainloop()
    except Exception as exc:  # 콘솔이 없으므로 오류를 창으로 알린다
        try:
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror(APP_TITLE,
                                 "실행 중 문제가 생겼습니다.\n\n{}\n\n"
                                 "파이썬 3 가 설치되어 있는지 확인해 주세요.".format(exc))
            root.destroy()
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

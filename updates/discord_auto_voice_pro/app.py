# -*- coding: utf-8 -*-
"""디스코드 음성방 자동 입장기 PRO (Discord Auto Voice Pro)

PC를 켜면 디스코드의 지정한 음성 채널에 자동으로 들어가는 Windows용 도우미입니다.

PRO 기능
- 음성방 프리셋 3개 저장 + 클릭 한 번에 전환
- "컴 켜질 때 항상" / "지정 시간대만" 예약 입장 (요일 선택)
- 입장할 때 게임·프로그램 같이 실행
- [롤 자동 찾기] · [롤체 자동 찾기] 원클릭 (바로가기 → 라이엇 클라이언트 순서로 탐색)
- 입장 후 마이크 음소거 안내 팝업(선택)
- 설정 자동 저장(config.json), 부팅 시 자동 시작(.vbs) 켜기/끄기
- 원클릭 자동 업데이트 (GitHub Pages · SHA-256 검증 · 사용자가 눌러야만 교체)

- 토큰/로그인 정보를 쓰지 않습니다. 디스코드 공식 URL 스킴(discord://)만 사용합니다.
- 파이썬 표준 라이브러리(tkinter)만 사용합니다.
"""

from __future__ import annotations

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
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

APP_TITLE = "디스코드 음성방 자동 입장 PRO"
APP_SUBTITLE = "Discord Auto Voice Pro"
APP_VERSION = "1.2.0"
APP_DIR_NAME = "DiscordAutoVoice"
CONFIG_FILENAME = "config.json"
STARTUP_FILENAME = "DiscordAutoVoice.vbs"

# --- 자동 업데이트 (GitHub Pages 고정 주소) ---------------------------------
UPDATE_SITE_LABEL = "coo714.github.io"
UPDATE_BASE_URL = "https://coo714.github.io/pickle-games/updates/discord_auto_voice_pro"
UPDATE_VERSION_URL = UPDATE_BASE_URL + "/version.json"
UPDATE_APP_URL = UPDATE_BASE_URL + "/app.py"
UPDATE_TIMEOUT = 6.0
UPDATE_CHECK_DELAY_MS = 900      # 앱이 뜬 뒤 조용히 한 번 확인하는 시점
UPDATE_FIRST_POLL_MS = 400
UPDATE_RESTART_DELAY_MS = 700    # 교체 후 재시작까지 (1초 안)

# 부팅 후 대기/디스코드 프로세스 확인 설정
DEFAULT_WAIT_SECONDS = 12          # 네트워크와 디스코드가 뜰 때까지 기본 대기
DISCORD_WAIT_LOOP_COUNT = 30       # 디스코드 프로세스 확인 반복 횟수 (30회 x 2초 = 60초)
DISCORD_WAIT_INTERVAL_MS = 2000    # 반복 간격(밀리초)
POST_DISCORD_WAIT_SECONDS = 3      # 디스코드를 찾은 뒤 한 번 더 기다리는 시간

MIC_NOTICE_TEXT = "입장 완료! 마이크 음소거는 Ctrl+Shift+M"

GUIDE_TEXT = "디스코드에서 음성 채널 우클릭 → 링크 복사 후 붙여넣으세요"
LINK_EXAMPLE = "https://discord.com/channels/123456789012345678/123456789012345678"

# 링크로 인정하는 호스트 (서버/채널 링크)
ALLOWED_HOSTS = {
    "discord.com",
    "ptb.discord.com",
    "canary.discord.com",
    "discordapp.com",
    "ptb.discordapp.com",
    "canary.discordapp.com",
}
ALLOWED_DISCORD_SCHEME_HOSTS = {"", "-", "discord.com", "discordapp.com",
                                "ptb.discord.com", "ptb.discordapp.com",
                                "canary.discord.com", "canary.discordapp.com"}

DEFAULT_PRESET_NAMES = ("1번 롤방", "2번 수다방", "3번 배그방")
PRESET_COUNT = 3
PRESET_NAME_MAX = 18

WEEKDAY_LABELS = ("월", "화", "수", "목", "금", "토", "일")

_ID_RE = re.compile(r"^\d{16,21}$")
_LINK_IN_VBS_RE = re.compile(r"discord://[^\s\"']+")
_TIME_RE = re.compile(r"^(\d{1,2})\s*[:시]\s*(\d{2})\s*분?$")
_TIME_BARE_RE = re.compile(r"^(\d{1,2})\s*시?$")

# 다크 테마 색 (디스코드 공식 다크 팔레트)
COLOR_BG = "#313338"        # 메인 배경
COLOR_CARD = "#2B2D31"      # 카드/패널
COLOR_CARD_DEEP = "#232428"  # 입력란
COLOR_HEADER = "#1E1F22"    # 상단 바
COLOR_BLURPLE = "#5865F2"   # 주요 버튼
COLOR_BLURPLE_HOVER = "#4752C4"
COLOR_GREEN = "#23A55A"     # 정상 상태
COLOR_TEXT = "#F2F3F5"      # 본문
COLOR_MUTED = "#B5BAC1"     # 보조 문구
COLOR_RED = "#F23F43"       # 경고
COLOR_YELLOW = "#F0B232"
COLOR_BORDER = "#3F4147"
COLOR_BLURPLE_PALE = "#A7B0FF"   # 버튼 위 보조 안내 문구


class LinkError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 한국어 안내 문구를 담은 오류."""


class TimeFormatError(ValueError):
    """시간 입력 형식 오류 (한국어 안내)."""


# ---------------------------------------------------------------------------
# 링크 처리
# ---------------------------------------------------------------------------

def normalize_link(raw: str) -> str:
    """사용자가 붙여넣은 링크를 discord:// 딥링크로 바꿉니다.

    https://discord.com/channels/{서버}/{채널}, ptb, canary, discordapp,
    그리고 이미 discord:// 로 시작하는 링크를 모두 받아들입니다.
    문제가 있으면 LinkError(한국어 안내)를 냅니다.
    """
    text = (raw or "").strip()

    # 복사하면서 따라온 따옴표/꺾쇠/공백 정리
    while len(text) >= 2 and text[0] in "\"'<" and text[-1] in "\"'>":
        text = text[1:-1].strip()
    text = text.strip("\"'<>").strip()

    if not text:
        raise LinkError(
            "링크가 비어 있어요.\n"
            "디스코드에서 음성 채널 우클릭 → '링크 복사' 를 누른 뒤 붙여넣어 주세요."
        )

    if any(ch.isspace() for ch in text):
        # 붙여넣기에 공백이 섞인 경우: 첫 덩어리만 사용
        text = text.split()[0]

    lowered = text.lower()
    if "://" not in lowered:
        if lowered.startswith(tuple(h + "/" for h in ALLOWED_HOSTS)):
            text = "https://" + text
            lowered = text.lower()
        else:
            raise LinkError(
                "디스코드 채널 링크가 아니에요.\n"
                "예시: " + LINK_EXAMPLE + "\n"
                "디스코드에서 음성 채널 우클릭 → '링크 복사' 로 다시 복사해 주세요."
            )

    try:
        parts = urlsplit(text)
    except ValueError:
        raise LinkError("링크 형식을 읽을 수 없어요. 채널 링크를 다시 복사해 주세요.")

    scheme = parts.scheme.lower()
    host = parts.netloc.lower().split("@")[-1]
    if ":" in host:  # 포트가 붙은 경우
        host = host.split(":")[0]

    if scheme == "discord":
        if host not in ALLOWED_DISCORD_SCHEME_HOSTS:
            raise LinkError("디스코드 앱 링크가 아니에요. 채널 링크를 다시 복사해 주세요.")
    elif scheme in ("http", "https"):
        if host in ("discord.gg", "www.discord.gg", "discord.me"):
            raise LinkError(
                "초대 링크(discord.gg)는 음성 채널로 바로 들어갈 수 없어요.\n"
                "음성 채널을 우클릭 → '링크 복사' 로 채널 링크를 복사해 주세요."
            )
        if host not in ALLOWED_HOSTS:
            raise LinkError(
                "디스코드 채널 링크가 아니에요.\n"
                "예시: " + LINK_EXAMPLE
            )
    else:
        raise LinkError(
            "지원하지 않는 링크 형식이에요.\n"
            "예시: " + LINK_EXAMPLE
        )

    segments = [s for s in parts.path.split("/") if s]
    if not segments or segments[0].lower() != "channels":
        if segments[:1] in ([], ["invite"]):
            raise LinkError(
                "초대 링크(discord.gg)는 음성 채널로 바로 들어갈 수 없어요.\n"
                "음성 채널을 우클릭 → '링크 복사' 로 채널 링크를 복사해 주세요."
            )
        raise LinkError(
            "채널 링크 형식이 아니에요. 'channels/서버ID/채널ID' 가 들어 있어야 해요.\n"
            "예시: " + LINK_EXAMPLE
        )

    if len(segments) < 3:
        raise LinkError(
            "서버 ID와 채널 ID가 모두 들어 있어야 해요.\n"
            "예시: " + LINK_EXAMPLE + "\n"
            "음성 채널을 우클릭 → '링크 복사' 로 다시 복사해 주세요."
        )
    if len(segments) > 3:
        raise LinkError(
            "채널 링크에 불필요한 주소가 붙어 있어요.\n"
            "음성 채널을 우클릭 → '링크 복사' 로 다시 복사해 주세요."
        )

    guild_id, channel_id = segments[1], segments[2]
    for name, value in (("서버 ID", guild_id), ("채널 ID", channel_id)):
        if not _ID_RE.match(value):
            raise LinkError(
                name + "가 숫자로 된 디스코드 ID가 아니에요.\n"
                "예시: " + LINK_EXAMPLE
            )

    return "discord://discord.com/channels/{}/{}".format(guild_id, channel_id)


def split_link(link: str):
    """discord:// 딥링크에서 (서버 ID, 채널 ID)를 꺼냅니다."""
    segments = [s for s in urlsplit(link).path.split("/") if s]
    if len(segments) >= 3:
        return segments[1], segments[2]
    return "", ""


def web_link(link: str) -> str:
    """딥링크를 브라우저용 https 주소로 바꿉니다."""
    guild_id, channel_id = split_link(link)
    return "https://discord.com/channels/{}/{}".format(guild_id, channel_id)


def short_link(link: str, limit: int = 46) -> str:
    """화면에 보여 줄 짧은 링크 문구 (…서버/채널)."""
    guild_id, channel_id = split_link(link)
    if not guild_id or not channel_id:
        return link if len(link) <= limit else link[:limit] + "…"
    text = "서버 {} · 채널 {}".format(guild_id, channel_id)
    return text


# ---------------------------------------------------------------------------
# 음성방 프리셋 (3개)
# ---------------------------------------------------------------------------

def default_presets():
    """기본 프리셋 3칸."""
    return [{"name": DEFAULT_PRESET_NAMES[i], "link": ""} for i in range(PRESET_COUNT)]


def clean_preset_name(raw, index: int) -> str:
    """프리셋 이름 다듬기: 앞뒤 공백 제거, 비면 기본 이름, 너무 길면 자르기."""
    name = str(raw or "").strip()
    if not name:
        name = DEFAULT_PRESET_NAMES[index]
    if len(name) > PRESET_NAME_MAX:
        name = name[:PRESET_NAME_MAX].rstrip()
    return name


def normalize_presets(raw):
    """프리셋 목록을 항상 3칸으로 맞춥니다. 링크는 discord:// 로 정규화."""
    items = []
    for index in range(PRESET_COUNT):
        item = {}
        if isinstance(raw, (list, tuple)) and index < len(raw) and isinstance(raw[index], dict):
            item = raw[index]
        link_raw = item.get("link") or ""
        link = ""
        if str(link_raw).strip():
            try:
                link = normalize_link(link_raw)
            except LinkError:
                link = ""
        items.append({"name": clean_preset_name(item.get("name"), index), "link": link})
    return items


def active_index(config: dict) -> int:
    """활성 프리셋 번호(0~2)."""
    try:
        index = int(config.get("active_preset", 0))
    except (TypeError, ValueError):
        index = 0
    return max(0, min(PRESET_COUNT - 1, index))


def activate_preset(config: dict, index: int) -> dict:
    """프리셋을 클릭했을 때: 활성 칸만 바꿉니다. 링크가 없으면 False 대신 그대로 저장."""
    config = normalize_config(config)
    config["active_preset"] = max(0, min(PRESET_COUNT - 1, int(index)))
    return config


def active_preset(config: dict) -> dict:
    """지금 활성 프리셋의 이름/링크."""
    return normalize_config(config)["presets"][active_index(config)]


def active_link(config: dict) -> str:
    return active_preset(config)["link"]


# ---------------------------------------------------------------------------
# 예약 시간
# ---------------------------------------------------------------------------

def default_schedule() -> dict:
    """기본값: 컴 켜질 때 항상 입장."""
    return {
        "mode": "always",
        "weekdays": [True, True, True, True, True, False, False],
        "start": "19:00",
        "end": "24:00",
    }


def parse_time(text) -> int:
    """'19:00', '19시 00분', '24:00', '9' → 자정 기준 분(0~1440)."""
    raw = str(text or "").strip()
    if not raw:
        raise TimeFormatError("시간이 비어 있어요. 예: 19:00")
    raw = raw.replace(".", ":").replace("：", ":")
    match = _TIME_RE.match(raw)
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
    else:
        match = _TIME_BARE_RE.match(raw)
        if not match:
            raise TimeFormatError("시간은 19:00 처럼 적어 주세요. (예: 19:00, 24:00)")
        hour, minute = int(match.group(1)), 0
    if minute > 59:
        raise TimeFormatError("분은 00~59 사이로 적어 주세요.")
    if hour > 24 or (hour == 24 and minute != 0):
        raise TimeFormatError("시간은 00:00 ~ 24:00 사이로 적어 주세요.")
    return hour * 60 + minute


def format_minutes(minutes: int) -> str:
    """분 → 'HH:MM' (1440은 24:00)."""
    minutes = max(0, min(1440, int(minutes)))
    return "{:02d}:{:02d}".format(minutes // 60, minutes % 60)


def normalize_schedule(raw) -> dict:
    """예약 설정을 안전한 값으로 맞춥니다."""
    base = default_schedule()
    if not isinstance(raw, dict):
        return base
    mode = str(raw.get("mode") or base["mode"]).lower()
    if mode not in ("always", "window"):
        mode = "always"

    weekdays_raw = raw.get("weekdays")
    weekdays = list(base["weekdays"])
    if isinstance(weekdays_raw, (list, tuple)) and len(weekdays_raw) == 7:
        weekdays = [bool(v) for v in weekdays_raw]

    try:
        start = format_minutes(parse_time(raw.get("start", base["start"])))
    except TimeFormatError:
        start = base["start"]
    try:
        end = format_minutes(parse_time(raw.get("end", base["end"])))
    except TimeFormatError:
        end = base["end"]

    return {"mode": mode, "weekdays": weekdays, "start": start, "end": end}


def weekday_mask(weekdays) -> int:
    """월~일 불리언 → 비트마스크 (월요일이 1번 비트)."""
    mask = 0
    for index, value in enumerate(list(weekdays)[:7]):
        if value:
            mask |= 1 << index
    return mask


def weekday_flag(weekdays, weekday_index: int) -> bool:
    try:
        return bool(list(weekdays)[weekday_index])
    except (IndexError, TypeError):
        return False


def should_join_now(now: datetime, schedule: dict) -> bool:
    """지금이 자동 입장 시간인지 판단합니다. (자정을 넘는 시간대도 처리)"""
    schedule = normalize_schedule(schedule)
    if schedule["mode"] == "always":
        return True

    start = parse_time(schedule["start"])
    end = parse_time(schedule["end"])
    current = now.hour * 60 + now.minute
    today = now.weekday()              # 월=0 … 일=6
    yesterday = (today - 1) % 7

    if start < end:
        return weekday_flag(schedule["weekdays"], today) and start <= current < end
    if start > end:
        # 예: 22:00 ~ 02:00 → 자정 전은 오늘 요일, 자정 후는 어제 요일 기준
        if current >= start:
            return weekday_flag(schedule["weekdays"], today)
        if current < end:
            return weekday_flag(schedule["weekdays"], yesterday)
        return False
    # 시작과 종료가 같으면 그 요일은 하루 종일
    return weekday_flag(schedule["weekdays"], today)


def schedule_summary(schedule: dict) -> str:
    """화면용 한 줄 요약."""
    schedule = normalize_schedule(schedule)
    if schedule["mode"] == "always":
        return "컴 켜질 때 항상 입장"
    days = [WEEKDAY_LABELS[i] for i in range(7) if schedule["weekdays"][i]]
    if len(days) == 7:
        day_text = "매일"
    elif days == ["월", "화", "수", "목", "금"]:
        day_text = "평일"
    elif days == ["토", "일"]:
        day_text = "주말"
    elif not days:
        day_text = "요일 없음"
    else:
        day_text = "".join(days)
    return "{} {}~{} 자동 입장".format(day_text, schedule["start"], schedule["end"])


def schedule_state_text(now: datetime, schedule: dict) -> str:
    """지금 예약 시간 안인지 밖인지 안내 문구."""
    if should_join_now(now, schedule):
        return "지금은 입장 시간이에요"
    return "지금은 예약 시간 밖이에요"


# ---------------------------------------------------------------------------
# 설정 파일
# ---------------------------------------------------------------------------

def default_config() -> dict:
    return {
        "version": 2,
        "active_preset": 0,
        "presets": default_presets(),
        "schedule": default_schedule(),
        "game": {"enabled": False, "path": "", "args": ""},
        "mic_notice": True,
        "wait_seconds": DEFAULT_WAIT_SECONDS,
    }


def normalize_config(raw) -> dict:
    """설정을 항상 같은 모양으로 맞춥니다. 예전(1.x) 설정도 옮겨 옵니다."""
    config = default_config()
    if not isinstance(raw, dict):
        return config

    presets = raw.get("presets")
    if presets is None and raw.get("link"):
        # 1.x 설정: link 하나만 있었음 → 1번 방으로 옮김
        presets = list(default_presets())
        try:
            presets[0]["link"] = normalize_link(raw.get("link"))
        except LinkError:
            pass
    config["presets"] = normalize_presets(presets)

    config["active_preset"] = active_index({"active_preset": raw.get("active_preset", 0)})
    config["schedule"] = normalize_schedule(raw.get("schedule"))

    game = raw.get("game") if isinstance(raw.get("game"), dict) else {}
    game_path = clean_path(game.get("path"))
    game_args = str(game.get("args") or "").strip()
    if not game_path.lower().endswith(".exe"):
        game_args = ""  # 바로가기(.lnk/.url)에는 인자를 붙이지 않습니다
    config["game"] = {
        "enabled": bool(game.get("enabled")) and bool(game_path),
        "path": game_path,
        "args": game_args,
    }

    config["mic_notice"] = bool(raw.get("mic_notice", True))

    try:
        wait = int(raw.get("wait_seconds", DEFAULT_WAIT_SECONDS))
    except (TypeError, ValueError):
        wait = DEFAULT_WAIT_SECONDS
    if wait < 0 or wait > 300:
        wait = DEFAULT_WAIT_SECONDS
    config["wait_seconds"] = wait
    return config


def config_directory() -> Path:
    """설정 폴더: %APPDATA%\\DiscordAutoVoice (없으면 홈 폴더 아래)."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / APP_DIR_NAME
    return Path.home() / ".discord_auto_voice"


def config_path() -> Path:
    return config_directory() / CONFIG_FILENAME


def display_config_path() -> str:
    """화면에 보여 줄 설정 파일 위치 (윈도우 기준 짧은 표기)."""
    return "%APPDATA%" + "\\" + APP_DIR_NAME + "\\" + CONFIG_FILENAME


def load_config(path=None) -> dict:
    """설정 파일을 읽습니다. 파일이 없거나 깨졌으면 기본 설정."""
    path = Path(path) if path is not None else config_path()
    try:
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, ValueError):
        return default_config()
    return normalize_config(data)


def save_config(config: dict, path=None) -> Path:
    """설정을 저장합니다(임시 파일에 쓴 뒤 교체)."""
    path = Path(path) if path is not None else config_path()
    payload = normalize_config(config)
    payload["app"] = APP_DIR_NAME
    payload["version"] = 2
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# 게임/프로그램 동시 실행
# ---------------------------------------------------------------------------

GAME_EXTENSIONS = (".exe", ".lnk", ".bat", ".cmd", ".url")

# 롤 / 롤체를 라이엇 클라이언트로 띄울 때 쓰는 실행 인자
RIOT_PRODUCT_LOL = "league_of_legends"
RIOT_PRODUCT_TFT = "teamfight_tactics"
RIOT_LAUNCH_ARGS = {
    "lol": "--launch-product={} --launch-patchline=live".format(RIOT_PRODUCT_LOL),
    "tft": "--launch-product={} --launch-patchline=live".format(RIOT_PRODUCT_TFT),
}
RIOT_CLIENT_FILENAME = "RiotClientServices.exe"
RIOT_CLIENT_RELATIVE = ("Riot Games", "Riot Client", RIOT_CLIENT_FILENAME)
RIOT_SHORTCUTS = {
    "lol": ("League of Legends.url", "League of Legends.lnk"),
    "tft": ("Teamfight Tactics.url", "Teamfight Tactics.lnk"),
}
GAME_LABELS = {"lol": "롤(LoL)", "tft": "롤체(TFT)"}
# 사용자가 클라이언트 exe 를 직접 고른 경우에 프로덕트 이름
CLIENT_PRODUCT_BY_EXE = {"leagueclient.exe": "lol", "tftclient.exe": "tft"}


def clean_path(path) -> str:
    """경로 문자열 정리 (앞뒤 공백·따옴표 제거)."""
    return str(path or "").strip().strip('"').strip()


def validate_program_path(path, exists=None) -> bool:
    """게임 경로가 실행 가능한 프로그램/바로가기인지 확인합니다."""
    raw = clean_path(path)
    if not raw:
        return False
    if not raw.lower().endswith(GAME_EXTENSIONS):
        return False
    exists = exists or os.path.exists
    return bool(exists(raw))


def program_name(path) -> str:
    """경로에서 파일 이름만 (윈도우 \\ 와 / 둘 다 처리)."""
    raw = clean_path(path)
    if not raw:
        return ""
    return re.split(r"[\\/]", raw)[-1] or raw


# --- 롤 · 롤체 자동 찾기 ------------------------------------------------------

class GameNotFoundError(LookupError):
    """자동 찾기 실패 (사용자에게 그대로 보여 줄 한국어 안내)."""


def _win_join(*parts) -> str:
    """윈도우 경로 결합기 (실행 중인 OS 와 상관없이 \\ 구분자로 만듭니다)."""
    cleaned = [str(part).strip("\\/") for part in parts if str(part or "").strip("\\/")]
    return "\\".join(cleaned)


def game_search_dirs(env=None) -> list:
    """롤/롤체 바로가기를 찾을 폴더 목록 (우선순위 순).

    ① 공용 바탕화면(%PUBLIC%\\Desktop)
    ② 내 바탕화면(%USERPROFILE%\\Desktop)
    ③ 원드라이브 바탕화면(%OneDrive%\\Desktop, %USERPROFILE%\\OneDrive\\바탕 화면)
    ④ 시작메뉴 Riot Games 폴더
    """
    env = os.environ if env is None else env

    def env_path(key, default=""):
        return clean_path(env.get(key) or default)

    public = env_path("PUBLIC", "C:\\Users\\Public")
    profile = env_path("USERPROFILE")
    onedrive = env_path("OneDrive")
    program_data = env_path("ProgramData", "C:\\ProgramData")

    candidates = [
        _win_join(public, "Desktop"),
        _win_join(profile, "Desktop") if profile else "",
        _win_join(onedrive, "Desktop") if onedrive else "",
        _win_join(profile, "OneDrive", "바탕 화면") if profile else "",
        _win_join(program_data, "Microsoft", "Windows", "Start Menu", "Programs", "Riot Games"),
    ]
    unique = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def riot_client_candidates(env=None) -> list:
    """RiotClientServices.exe 후보 경로 (C:\\Riot Games\\Riot Client 부터 드라이브 순서대로)."""
    env = os.environ if env is None else env
    system_drive = clean_path(env.get("SystemDrive") or "C:")
    if not re.match(r"^[A-Za-z]:$", system_drive):
        system_drive = "C:"
    drives = [system_drive.upper()]
    for letter in "CDEFGH":
        drive = letter + ":"
        if drive not in drives:
            drives.append(drive)

    candidates = [_win_join(drive, *RIOT_CLIENT_RELATIVE) for drive in drives]
    for key in ("ProgramFiles", "PROGRAMFILES", "ProgramFiles(x86)", "PROGRAMFILES(X86)"):
        base = clean_path(env.get(key))
        if base:
            candidates.append(_win_join(base, *RIOT_CLIENT_RELATIVE))

    unique = []
    for item in candidates:
        if item and item not in unique:
            unique.append(item)
    return unique


def detect_game(kind, env=None, exists=None) -> dict:
    """롤/롤체 실행 경로를 자동으로 찾습니다.

    ① 바탕화면·시작메뉴의 바로가기(.url/.lnk)를 먼저 찾고,
    ② 없으면 RiotClientServices.exe 를 찾아 --launch-product=... 인자를 붙입니다.

    반환: {"kind", "path", "args", "source", "label", "detail"}
    """
    kind = "tft" if str(kind or "").strip().lower() in ("tft", "teamfight", "롤체") else "lol"
    exists = exists or os.path.exists
    label = GAME_LABELS[kind]

    for folder in game_search_dirs(env):
        for filename in RIOT_SHORTCUTS[kind]:
            for name in (filename, filename.lower()):
                path = _win_join(folder, name)
                if exists(path):
                    return {
                        "kind": kind,
                        "path": path,
                        "args": "",
                        "source": "shortcut",
                        "label": label,
                        "detail": "바탕 화면·시작 메뉴 바로가기",
                    }

    for path in riot_client_candidates(env):
        if exists(path):
            return {
                "kind": kind,
                "path": path,
                "args": RIOT_LAUNCH_ARGS[kind],
                "source": "riot_client",
                "label": label,
                "detail": "라이엇 클라이언트({}) 경유".format(RIOT_CLIENT_FILENAME),
            }

    shortcut_examples = " / ".join(RIOT_SHORTCUTS[kind])
    raise GameNotFoundError(
        "{} 바로가기와 라이엇 클라이언트({})를 찾지 못했어요.\n"
        "확인한 곳: 공용·내 바탕화면, 원드라이브 바탕 화면, 시작메뉴 Riot Games 폴더, "
        "C:\\Riot Games\\Riot Client, D:\\Riot Games\\Riot Client\n"
        "[찾아보기]로 {} 파일을 직접 골라 주세요.".format(label, RIOT_CLIENT_FILENAME, shortcut_examples)
    )


def riot_product_for_client(path) -> str:
    """LeagueClient.exe / TFTClient.exe 면 어느 프로덕트인지 돌려줍니다 (아니면 "")."""
    return CLIENT_PRODUCT_BY_EXE.get(program_name(path).lower(), "")


def _drive_of(path) -> str:
    match = re.match(r"^([A-Za-z]:)[\\/]", clean_path(path))
    return match.group(1).upper() if match else ""


def resolve_game_launch(path, args="", env=None, exists=None):
    """실행 직전 경로 보정.

    사용자가 실수로 LeagueClient.exe / TFTClient.exe 를 직접 넣었으면,
    같은 드라이브(또는 표준 위치)의 RiotClientServices.exe 를 찾아
    --launch-product=... 인자를 붙입니다.

    반환: (path, args, changed)
    """
    target = clean_path(path)
    if not target:
        return "", "", False
    if split_args(args):
        return target, str(args).strip(), False

    product = riot_product_for_client(target)
    if not product:
        return target, "", False

    exists = exists or os.path.exists
    candidates = []
    drive = _drive_of(target)
    if drive:
        candidates.append(_win_join(drive, *RIOT_CLIENT_RELATIVE))
    candidates.extend(riot_client_candidates(env))
    for candidate in candidates:
        if exists(candidate):
            return candidate, RIOT_LAUNCH_ARGS[product], True
    return target, "", False


# --- 실행 (검은 콘솔 창 없이) ------------------------------------------------

def split_args(text) -> list:
    """인자 문자열 → 목록. 따옴표로 감싼 값도 한 덩어리로 유지합니다."""
    raw = str(text or "").strip()
    if not raw:
        return []
    tokens = []
    buffer = ""
    quote = ""
    for ch in raw:
        if quote:
            if ch == quote:
                quote = ""
            else:
                buffer += ch
        elif ch in "\"'":
            quote = ch
        elif ch.isspace():
            if buffer:
                tokens.append(buffer)
                buffer = ""
        else:
            buffer += ch
    if buffer:
        tokens.append(buffer)
    return tokens


def build_launch_argv(path, args="") -> list:
    """실행 명령 만들기. exe 는 인자를 그대로 붙이고, 바로가기는 셸(start)로 엽니다."""
    target = clean_path(path)
    if not target:
        return []
    tokens = split_args(args)
    if target.lower().endswith(".exe"):
        return [target] + tokens
    return ["cmd", "/c", "start", "", target]


def _no_window_flags() -> int:
    """검은 CMD 창이 뜨지 않게 하는 윈도우 프로세스 플래그."""
    if os.name != "nt":
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)) | \
        int(getattr(subprocess, "DETACHED_PROCESS", 0x00000008))


def launch_game(path, args="") -> None:
    """게임을 검은 콘솔 창 없이 실행합니다. --launch-product=... 인자도 그대로 전달합니다."""
    if os.name != "nt":
        raise OSError("이 기능은 윈도우에서만 동작합니다.")
    argv = build_launch_argv(path, args)
    if not argv:
        raise OSError("게임 경로가 비어 있어요.")
    kwargs = {"close_fds": True}
    flags = _no_window_flags()
    if flags:
        kwargs["creationflags"] = flags
    subprocess.Popen(argv, **kwargs)


def open_program(path, args="") -> None:
    """(예전 이름 호환) 게임/프로그램을 실행합니다."""
    launch_game(path, args)


# ---------------------------------------------------------------------------
# 자동 업데이트 (GitHub Pages version.json + SHA-256 검증)
# ---------------------------------------------------------------------------

class UpdateError(Exception):
    """업데이트 실패 (사용자에게 그대로 보여 줄 한국어 안내)."""


_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){0,3}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def parse_version(text) -> tuple:
    """'1.2.0' / 'v1.2' → (1, 2, 0). 숫자가 아니면 UpdateError."""
    raw = str(text or "").strip().lower()
    if raw.startswith("v"):
        raw = raw[1:].strip()
    if not real_version(raw):
        raise UpdateError("버전 형식을 읽을 수 없어요: {}".format(text))
    numbers = [int(part) for part in raw.split(".")]
    while len(numbers) < 3:
        numbers.append(0)
    return tuple(numbers)


def real_version(text) -> bool:
    return bool(_VERSION_RE.match(str(text or "").strip().lower().lstrip("v")))


def is_newer_version(latest, current=APP_VERSION) -> bool:
    """latest 가 current 보다 새 버전인지."""
    try:
        return parse_version(latest) > parse_version(current)
    except UpdateError:
        return False


def version_text(version) -> str:
    """'1.2.0' → 'v1.2.0' (이미 v 가 있으면 그대로)."""
    raw = str(version or "").strip()
    return raw if raw.lower().startswith("v") else "v" + raw


def fetch_url(url, timeout=UPDATE_TIMEOUT) -> bytes:
    """업데이트 파일을 HTTPS 로 받아 옵니다."""
    request = Request(url, headers={"User-Agent": "DiscordAutoVoicePro/{}".format(APP_VERSION)})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - https 고정 주소
        return response.read()


def parse_manifest(raw) -> dict:
    """version.json 을 검증해서 필요한 값만 꺼냅니다.

    형식: {"version": "1.2.0", "app_url": "https://.../app.py", "sha256": "...", "notes": "..."}
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

    app_url = str(data.get("app_url") or UPDATE_APP_URL).strip()
    if not app_url.lower().startswith("https://"):
        raise UpdateError("업데이트 주소가 https 가 아니라서 받지 않습니다.")
    expected_host = UPDATE_SITE_LABEL.lower()
    if expected_host not in app_url.lower():
        raise UpdateError("업데이트 주소가 공식 주소({})가 아니라서 받지 않습니다.".format(UPDATE_SITE_LABEL))

    sha256 = str(data.get("sha256") or "").strip().lower()
    if sha256 and not _SHA256_RE.match(sha256):
        raise UpdateError("업데이트 정보의 SHA-256 값이 올바르지 않아요.")

    notes = str(data.get("notes") or "").strip()
    return {"version": version, "app_url": app_url, "sha256": sha256, "notes": notes}


def check_for_update(current=APP_VERSION, fetch=None, url=UPDATE_VERSION_URL):
    """새 버전이 있으면 version.json 정보를, 없거나 실패하면 None.

    네트워크 오류·서버 오류는 모두 조용히 무시합니다 (앱 실행을 방해하지 않음).
    """
    fetch = fetch or fetch_url
    try:
        manifest = parse_manifest(fetch(url))
    except Exception:
        return None
    if is_newer_version(manifest["version"], current):
        return manifest
    return None


def verify_python_source(data) -> None:
    """받은 파일이 올바른 파이썬 코드인지 확인 (ast.parse + 이 앱인지 확인)."""
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
            "새 파일이 올바른 코드가 아니에요({}). 업데이트를 취소했어요.".format(error.msg)
        )
    if "APP_VERSION" not in text or "def main(" not in text:
        raise UpdateError("새 파일이 이 프로그램이 맞는지 확인하지 못했어요. 업데이트를 취소했어요.")


def verify_update_payload(data, expected_sha256="") -> str:
    """SHA-256 과 코드 검증. 통과하면 실제 해시값을 돌려줍니다."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256:
        if not hmac.compare_digest(digest, str(expected_sha256).strip().lower()):
            raise UpdateError(
                "받은 파일이 원본과 달라요(SHA-256 불일치). 안전을 위해 업데이트를 취소했어요."
            )
    verify_python_source(data)
    return digest


def download_update(manifest, fetch=None, app_path=None) -> Path:
    """업데이트 파일을 받아 검증한 뒤 임시 파일로 저장합니다.

    검증에 실패하면 아무 파일도 바꾸지 않고 UpdateError 를 냅니다.
    """
    fetch = fetch or fetch_url
    manifest = parse_manifest(manifest)
    data = fetch(manifest["app_url"])
    verify_update_payload(data, manifest["sha256"])

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


def install_update(new_file, app_path, backup=True) -> dict:
    """검증된 새 파일로 app.py 를 교체합니다. 실패하면 원래 파일을 되돌립니다."""
    app_path = Path(app_path)
    backup_path = app_path.with_name(app_path.name + ".bak")
    staged = app_path.with_name(app_path.name + ".new")
    had_original = app_path.is_file()
    original = app_path.read_bytes() if had_original else b""

    try:
        shutil.copyfile(str(new_file), str(staged))
        verify_python_source(staged.read_bytes())
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
            "파일을 바꾸지 못했어요({}). 원래 파일을 그대로 되돌렸어요.".format(error)
        )

    return {
        "path": str(app_path),
        "backup": str(backup_path) if backup and had_original else "",
    }


def perform_update(manifest, app_path, fetch=None) -> dict:
    """다운로드 → 검증 → 교체를 한 번에. 어느 단계라도 실패하면 원본 유지."""
    new_file = download_update(manifest, fetch=fetch, app_path=app_path)
    try:
        return install_update(new_file, app_path)
    finally:
        _safe_unlink(new_file)


def _safe_unlink(path) -> None:
    try:
        Path(path).unlink()
    except OSError:
        pass


def restart_application(app_path=None, python_executable=None, popen=None, exists=None) -> list:
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
# 시작프로그램 등록 (부팅 시 자동 입장)
# ---------------------------------------------------------------------------

def startup_directory() -> Path:
    """윈도우 시작프로그램 폴더."""
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("윈도우 시작프로그램 폴더를 찾을 수 없습니다. 윈도우에서 실행해 주세요.")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def startup_script_path(startup_dir) -> Path:
    return Path(startup_dir) / STARTUP_FILENAME


def vb_expression(text: str) -> str:
    """문자열 → VBS 식. 한글은 ChrW(&H....) 로 바꿔 VBS 파일을 순수 ASCII로 유지합니다."""
    parts = []
    buffer = ""
    for ch in text:
        if 32 <= ord(ch) < 127:
            buffer += ch
        else:
            if buffer:
                parts.append('"' + buffer.replace('"', '""') + '"')
                buffer = ""
            parts.append("ChrW(&H{:X})".format(ord(ch)))
    if buffer:
        parts.append('"' + buffer.replace('"', '""') + '"')
    return " & ".join(parts) if parts else '""'


def build_startup_vbs(config: dict) -> str:
    """부팅 직후 실행할 VBS 스크립트 내용을 만듭니다.

    VBS 파일은 윈도우 스크립트 호스트가 ANSI 로 읽기 때문에 내용은 영문(ASCII)만 쓰고,
    한국어 안내 문구는 ChrW() 코드로 만듭니다.
    """
    config = normalize_config(config)
    link = active_link(config)
    if not link:
        raise LinkError("활성 방 링크가 없어요. 프리셋에 음성방 링크를 먼저 넣어 주세요.")
    schedule = config["schedule"]
    wait_seconds = max(0, int(config["wait_seconds"]))
    fallback = web_link(link)
    game = config["game"]
    game_path = game["path"] if game["enabled"] else ""
    game_args = game.get("args", "") if game["enabled"] else ""
    mask = weekday_mask(schedule["weekdays"])
    start = parse_time(schedule["start"])
    end = parse_time(schedule["end"])
    use_window = "True" if schedule["mode"] == "window" else "False"

    lines = [
        "' DiscordAutoVoice Pro - auto join script (generated by the app, do not edit)",
        "' Waits for Windows network and Discord, then opens the saved voice channel link.",
        "Option Explicit",
        "",
        "Dim shell, wmi, procs, i, t, cur, today, yday, inWin, inDay",
        "Dim useWindow, startM, endM, dayMask, deepLink, webLink, gamePath, micOn, msg",
        "Dim gameArgs",
        "",
        'deepLink = "' + link + '"',
        'webLink = "' + fallback + '"',
        "startM = {}".format(start),
        "endM = {}".format(end),
        "dayMask = {}".format(mask),
        "useWindow = {}".format(use_window),
        "gamePath = " + vb_expression(game_path),
        "gameArgs = " + vb_expression(game_args),
        "micOn = {}".format("True" if config["mic_notice"] else "False"),
        "",
        'Set shell = CreateObject("WScript.Shell")',
        "",
        "' 1) let Windows finish starting up",
        "WScript.Sleep {}000".format(wait_seconds),
        "",
        "' 2) is it time to join? (Mon = weekday 1, Sunday = 7)",
        "inWin = True",
        "If useWindow Then",
        "  t = Now",
        "  cur = Hour(t) * 60 + Minute(t)",
        "  today = Weekday(t, 2)",
        "  yday = today - 1",
        "  If yday < 1 Then yday = 7",
        "  inWin = False",
        "  If startM < endM Then",
        "    inDay = (dayMask \\ (2 ^ (today - 1))) Mod 2",
        "    If cur >= startM And cur < endM And inDay = 1 Then inWin = True",
        "  ElseIf startM > endM Then",
        "    If cur >= startM Then",
        "      inDay = (dayMask \\ (2 ^ (today - 1))) Mod 2",
        "      If inDay = 1 Then inWin = True",
        "    ElseIf cur < endM Then",
        "      inDay = (dayMask \\ (2 ^ (yday - 1))) Mod 2",
        "      If inDay = 1 Then inWin = True",
        "    End If",
        "  Else",
        "    inDay = (dayMask \\ (2 ^ (today - 1))) Mod 2",
        "    If inDay = 1 Then inWin = True",
        "  End If",
        "End If",
        "",
        "If inWin Then",
        "  ' 3) wait until Discord is running (up to {} seconds)".format(
            int(DISCORD_WAIT_LOOP_COUNT * DISCORD_WAIT_INTERVAL_MS / 1000)
        ),
        '  Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
        "  For i = 1 To {}".format(DISCORD_WAIT_LOOP_COUNT),
        "    Set procs = wmi.ExecQuery(\"SELECT Name FROM Win32_Process WHERE Name = 'Discord.exe'\")",
        "    If procs.Count > 0 Then Exit For",
        "    WScript.Sleep {}".format(DISCORD_WAIT_INTERVAL_MS),
        "  Next",
        "",
        "  ' 4) open the voice channel",
        "  WScript.Sleep {}000".format(POST_DISCORD_WAIT_SECONDS),
        "  On Error Resume Next",
        "  shell.Run deepLink, 1, False",
        "  If Err.Number <> 0 Then",
        "    Err.Clear",
        "    shell.Run webLink, 1, False",
        "    Err.Clear",
        "  End If",
        "",
    ]
    if game_path:
        lines += [
            "  ' 5) launch the game together",
            '  If Len(gamePath) > 0 Then',
            '    If Len(gameArgs) > 0 Then',
            '      shell.Run Chr(34) & gamePath & Chr(34) & " " & gameArgs, 1, False',
            "    Else",
            '      shell.Run Chr(34) & gamePath & Chr(34), 1, False',
            "    End If",
            "  End If",
            "  Err.Clear",
            "",
        ]
    if config["mic_notice"]:
        lines += [
            "  ' 6) mic mute reminder (4 seconds, closes itself)",
            "  If micOn Then",
            "    msg = " + vb_expression(MIC_NOTICE_TEXT),
            '    shell.Popup msg, 4, "Discord Voice", 64',
            "  End If",
            "",
        ]
    lines += [
        "  On Error GoTo 0",
        "End If",
        "",
    ]
    return "\r\n".join(lines)


def is_startup_enabled(startup_dir) -> bool:
    try:
        return startup_script_path(startup_dir).is_file()
    except OSError:
        return False


def registered_link(startup_dir):
    """등록된 자동 입장 스크립트에서 링크를 읽어 옵니다. 없으면 None."""
    path = startup_script_path(startup_dir)
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    found = _LINK_IN_VBS_RE.search(text)
    return found.group(0) if found else None


def enable_startup(startup_dir, config: dict) -> Path:
    """시작프로그램 폴더에 자동 입장 스크립트를 등록합니다. (설정이 바뀌면 다시 부릅니다)"""
    startup_dir = Path(startup_dir)
    startup_dir.mkdir(parents=True, exist_ok=True)
    path = startup_script_path(startup_dir)
    tmp = path.with_name(path.name + ".tmp")
    content = build_startup_vbs(config)
    with open(tmp, "w", encoding="ascii", newline="") as fp:
        fp.write(content)
    os.replace(tmp, path)
    return path


def disable_startup(startup_dir) -> bool:
    """자동 입장 스크립트를 지웁니다. 지웠으면 True."""
    path = startup_script_path(startup_dir)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


# ---------------------------------------------------------------------------
# 실행 (테스트 입장)
# ---------------------------------------------------------------------------

def open_link(link: str) -> None:
    """딥링크로 디스코드를 엽니다 (검은 콘솔 창 없이).

    윈도우: cmd /c start "" "discord://..." + CREATE_NO_WINDOW
    실패하면 웹 링크로, 그것도 안 되면 기본 앱 연결(os.startfile)로 대신합니다.
    """
    if os.name == "nt":
        flags = _no_window_flags()
        for target in (link, web_link(link)):
            try:
                subprocess.Popen(["cmd", "/c", "start", "", target],
                                 close_fds=True, creationflags=flags)
                return
            except OSError:
                continue
        os.startfile(web_link(link))  # noqa: S606 - 마지막 수단
        return
    import webbrowser
    webbrowser.open(link)


def open_program(path: str) -> None:
    """게임/프로그램을 실행합니다."""
    if os.name == "nt":
        os.startfile(path)  # noqa: S606 - 사용자가 고른 프로그램 실행
        return
    raise OSError("이 기능은 윈도우에서만 동작합니다.")


# ---------------------------------------------------------------------------
# 화면
# ---------------------------------------------------------------------------

KOREAN_FONT_CANDIDATES = (
    "Malgun Gothic",
    "맑은 고딕",
    "맑은고딕",
    "Noto Sans CJK KR",
    "Noto Sans KR",
    "NanumGothic",
    "Apple SD Gothic Neo",
    "AppleGothic",
    "DejaVu Sans",
)


def pick_font_family(root=None) -> str:
    """설치된 폰트 중 한글이 잘 나오는 것을 고릅니다 (맑은 고딕 우선)."""
    import tkinter.font as tkfont
    try:
        families = set(tkfont.families(root))
    except Exception:
        families = set()
    for name in KOREAN_FONT_CANDIDATES:
        if name in families:
            return name
    return "TkDefaultFont"


def _enable_dpi_awareness() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class ProApp:
    """디스코드 다크 테마 화면."""

    WINDOW_WIDTH = 820

    def __init__(self, root, config_file=None, startup_dir=None, opener=None,
                 now_provider=None, fetch=None, auto_update_check=True,
                 env=None, exists=None, app_file=None):
        import tkinter as tk
        import tkinter.font as tkfont

        self.tk = tk
        self.root = root
        self.config_file = Path(config_file) if config_file else config_path()
        self.startup_dir = Path(startup_dir) if startup_dir else None
        self.opener = opener or open_link
        self.now_provider = now_provider or datetime.now
        self.fetch = fetch or fetch_url
        self.env = dict(os.environ if env is None else env)
        self.exists = exists or os.path.exists
        self.app_file = Path(app_file) if app_file else Path(__file__)
        self.latest_update = None
        self._update_queue = queue.Queue()
        self._update_busy = False
        self._alive = True
        self._dialog = None

        self.config = load_config(self.config_file)

        family = pick_font_family(root)
        self.font_family = family
        self.font_h1 = tkfont.Font(root=root, family=family, size=15, weight="bold")
        self.font_h2 = tkfont.Font(root=root, family=family, size=11, weight="bold")
        self.font_body = tkfont.Font(root=root, family=family, size=9)
        self.font_small = tkfont.Font(root=root, family=family, size=8)
        self.font_button = tkfont.Font(root=root, family=family, size=9)
        self.font_badge = tkfont.Font(root=root, family=family, size=8, weight="bold")

        root.title(APP_TITLE)
        root.configure(bg=COLOR_BG)
        root.minsize(self.WINDOW_WIDTH, 0)
        try:
            root.geometry("{}x{}".format(self.WINDOW_WIDTH, 760))
        except Exception:
            pass
        try:
            root.iconname(APP_TITLE)
        except Exception:
            pass

        self.vars = {}
        self.preset_widgets = []
        self.weekday_buttons = []
        self._autosave_job = None

        self._build_header()
        self._build_update_banner()
        self._build_scroll_body()
        body = self._body

        self._build_preset_card(body)
        self._build_schedule_card(body)
        self._build_game_card(body)
        self._build_startup_card(body)
        self._build_footer(root)

        self._load_into_widgets()
        self.refresh_status()
        self.root.update_idletasks()
        self._fit_window()
        self.root.bind("<Control-Return>", lambda _event: self.on_test())
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        # 업데이트 결과는 큐로 받아 화면 스레드에서만 반영합니다.
        self.root.after(UPDATE_FIRST_POLL_MS, self._poll_update_queue)
        if auto_update_check:
            self.root.after(UPDATE_CHECK_DELAY_MS, self.start_update_check)

    # -- 스크롤 되는 본문 --------------------------------------------------
    def _build_scroll_body(self):
        """작은 화면(1366x768 등)에서도 잘리지 않도록 본문을 스크롤 상자에 담습니다."""
        tk = self.tk
        container = tk.Frame(self.root, bg=COLOR_BG)
        container.pack(fill="both", expand=True)
        self._body_canvas = tk.Canvas(container, bg=COLOR_BG, highlightthickness=0, bd=0)
        self._body_scroll = tk.Scrollbar(container, orient="vertical",
                                         command=self._body_canvas.yview,
                                         width=10, bd=0, relief="flat",
                                         troughcolor=COLOR_BG, bg=COLOR_BORDER,
                                         activebackground=COLOR_MUTED)
        self._body_canvas.configure(yscrollcommand=self._on_scrollcommand)
        self._body_canvas.pack(side="left", fill="both", expand=True)
        self._body = tk.Frame(self._body_canvas, bg=COLOR_BG)
        self._body_window = self._body_canvas.create_window(
            (0, 0), window=self._body, anchor="nw")
        self._body.bind("<Configure>", self._on_body_configure)
        self._body_canvas.bind("<Configure>", self._on_canvas_configure)
        for widget in (self._body_canvas, container):
            widget.bind("<Enter>", lambda _e: self._bind_wheel(True))
            widget.bind("<Leave>", lambda _e: self._bind_wheel(False))

    def _bind_wheel(self, on):
        if on:
            self.root.bind_all("<MouseWheel>", self._on_wheel)
            self.root.bind_all("<Button-4>", self._on_wheel)
            self.root.bind_all("<Button-5>", self._on_wheel)
        else:
            for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
                try:
                    self.root.unbind_all(sequence)
                except Exception:
                    pass

    def _on_wheel(self, event):
        if not self._scroll_needed():
            return
        if getattr(event, "num", None) == 4:
            delta = -1
        elif getattr(event, "num", None) == 5:
            delta = 1
        else:
            delta = -1 if getattr(event, "delta", 0) > 0 else 1
        try:
            self._body_canvas.yview_scroll(delta, "units")
        except Exception:
            pass

    def _scroll_needed(self):
        try:
            return self._body.winfo_reqheight() > self._body_canvas.winfo_height() + 2
        except Exception:
            return False

    def _on_body_configure(self, _event=None):
        try:
            self._body_canvas.configure(scrollregion=self._body_canvas.bbox("all"))
        except Exception:
            pass

    def _on_canvas_configure(self, event):
        try:
            self._body_canvas.itemconfigure(self._body_window, width=event.width)
            # 창 높이나 배너 때문에 보이는 영역이 줄면 스크롤 막대를 다시 계산합니다.
            self._show_scrollbar_if_needed()
        except Exception:
            pass

    def _on_scrollcommand(self, first, last):
        """스크롤이 필요할 때만 막대를 보여 줍니다."""
        if getattr(self, "_in_scroll_cb", False):
            return
        self._in_scroll_cb = True
        try:
            needed = not (float(first) <= 0.0 and float(last) >= 1.0)
            if needed:
                if not self._body_scroll.winfo_ismapped():
                    self._body_scroll.pack(side="right", fill="y")
            else:
                if self._body_scroll.winfo_ismapped():
                    self._body_scroll.pack_forget()
        except Exception:
            pass
        finally:
            self._in_scroll_cb = False

    def _show_scrollbar_if_needed(self):
        try:
            self.root.update_idletasks()
            first, last = self._body_canvas.yview()
            self._on_scrollcommand(first, last)
        except Exception:
            pass

    # -- 공통 위젯 ---------------------------------------------------------
    def _card(self, parent, title, hint=None):
        tk = self.tk
        wrap = tk.Frame(parent, bg=COLOR_CARD)
        wrap.pack(fill="x", pady=(0, 8))
        head = tk.Frame(wrap, bg=COLOR_CARD)
        head.pack(fill="x", padx=14, pady=(9, 0))
        tk.Label(head, text=title, bg=COLOR_CARD, fg=COLOR_TEXT,
                 font=self.font_h2, anchor="w").pack(side="left")
        if hint:
            tk.Label(head, text=hint, bg=COLOR_CARD, fg=COLOR_MUTED,
                     font=self.font_small, anchor="e").pack(side="right")
        inner = tk.Frame(wrap, bg=COLOR_CARD)
        inner.pack(fill="x", padx=14, pady=(6, 10))
        return inner

    def _entry(self, parent, textvariable=None, width=None, justify="left", font=None):
        tk = self.tk
        entry = tk.Entry(parent, textvariable=textvariable, width=width, justify=justify,
                         bg=COLOR_CARD_DEEP, fg=COLOR_TEXT, insertbackground=COLOR_TEXT,
                         disabledbackground=COLOR_CARD_DEEP, disabledforeground=COLOR_MUTED,
                         relief="flat", bd=0, highlightthickness=1,
                         highlightbackground=COLOR_BORDER, highlightcolor=COLOR_BLURPLE,
                         font=font or self.font_body)
        return entry

    def _button(self, parent, text, command, kind="blurple", width=None, font=None, padx=12):
        tk = self.tk
        colors = {
            "blurple": (COLOR_BLURPLE, "#FFFFFF", COLOR_BLURPLE_HOVER),
            "ghost": (COLOR_CARD_DEEP, COLOR_TEXT, COLOR_BORDER),
            "danger": ("#3C2A2C", "#F2B8B5", "#4A3335"),
            "off": (COLOR_CARD_DEEP, COLOR_MUTED, COLOR_BORDER),
        }
        bg, fg, hover = colors.get(kind, colors["blurple"])
        button = tk.Button(parent, text=text, command=command, bg=bg, fg=fg,
                           activebackground=hover, activeforeground=fg,
                           relief="flat", bd=0, highlightthickness=0,
                           font=font or self.font_button, width=width,
                           padx=padx, pady=6, cursor="hand2")
        return button

    def _check(self, parent, text, variable, command=None):
        tk = self.tk
        return tk.Checkbutton(parent, text=text, variable=variable, command=command,
                              bg=COLOR_CARD, fg=COLOR_TEXT, activebackground=COLOR_CARD,
                              activeforeground=COLOR_TEXT, selectcolor=COLOR_CARD_DEEP,
                              highlightthickness=0, bd=0, anchor="w",
                              font=self.font_body, cursor="hand2")

    def _led(self, parent, size=12, color=COLOR_GREEN, bg=COLOR_HEADER):
        tk = self.tk
        canvas = tk.Canvas(parent, width=size, height=size, bg=bg,
                           highlightthickness=0, bd=0)
        dot = canvas.create_oval(1, 1, size - 1, size - 1, fill=color, outline=color)
        canvas._dot = dot  # type: ignore[attr-defined]
        return canvas

    def _set_led(self, canvas, color):
        try:
            canvas.itemconfigure(canvas._dot, fill=color, outline=color)  # type: ignore[attr-defined]
        except Exception:
            pass

    # -- 상단 바 -----------------------------------------------------------
    def _build_header(self):
        tk = self.tk
        header = tk.Frame(self.root, bg=COLOR_HEADER)
        self._header = header
        header.pack(fill="x")
        left = tk.Frame(header, bg=COLOR_HEADER)
        left.pack(side="left", padx=16, pady=12)
        tk.Label(left, text=APP_TITLE, bg=COLOR_HEADER, fg=COLOR_TEXT,
                 font=self.font_h1, anchor="w").pack(anchor="w")
        tk.Label(left, text=APP_SUBTITLE + " · 로그인 없이 discord:// 공식 링크만 사용",
                 bg=COLOR_HEADER, fg=COLOR_MUTED, font=self.font_small,
                 anchor="w").pack(anchor="w")

        right = tk.Frame(header, bg=COLOR_HEADER)
        right.pack(side="right", padx=16, pady=12)

        badge = tk.Frame(right, bg=COLOR_BLURPLE)
        badge.pack(side="right", padx=(10, 0))
        tk.Label(badge, text="홍준영님 커스텀 에디션", bg=COLOR_BLURPLE, fg="#FFFFFF",
                 font=self.font_badge, padx=10, pady=4).pack()

        status = tk.Frame(right, bg=COLOR_HEADER)
        status.pack(side="right")
        self.header_led = self._led(status, size=14, color=COLOR_RED, bg=COLOR_HEADER)
        self.header_led.pack(side="left", padx=(0, 7))
        self.header_status_var = tk.StringVar(value="자동 입장 꺼짐")
        tk.Label(status, textvariable=self.header_status_var, bg=COLOR_HEADER,
                 fg=COLOR_TEXT, font=self.font_h2).pack(side="left")

    # -- 카드 1: 프리셋 ----------------------------------------------------
    def _build_preset_card(self, parent):
        tk = self.tk
        inner = self._card(parent, "음성방 프리셋 3개",
                           "우클릭 → 링크 복사 후 붙여넣기 · 이름 더블클릭 = 수정")
        tk.Label(inner, text=GUIDE_TEXT, bg=COLOR_CARD, fg=COLOR_MUTED,
                 font=self.font_small, anchor="w").pack(fill="x", pady=(0, 4))

        for index in range(PRESET_COUNT):
            row = tk.Frame(inner, bg=COLOR_CARD_DEEP,
                           highlightthickness=1, highlightbackground=COLOR_BORDER)
            row.pack(fill="x", pady=(0, 5))

            accent = tk.Frame(row, bg=COLOR_BORDER, width=4)
            accent.pack(side="left", fill="y")

            name_var = tk.StringVar(value=DEFAULT_PRESET_NAMES[index])
            link_var = tk.StringVar(value="")

            name_button = tk.Button(
                row, text=str(index + 1), command=lambda i=index: self.on_activate(i),
                bg=COLOR_CARD_DEEP, fg=COLOR_MUTED, activebackground=COLOR_BLURPLE,
                activeforeground="#FFFFFF", relief="flat", bd=0, highlightthickness=0,
                font=self.font_button, width=12, padx=8, pady=6, anchor="w",
                cursor="hand2")
            name_button.pack(side="left", padx=(8, 6), pady=6)
            name_button.bind("<Double-Button-1>",
                             lambda _event, i=index: self.on_rename_preset(i))

            entry = self._entry(row, textvariable=link_var, font=self.font_small)
            entry.pack(side="left", fill="x", expand=True, ipady=4, pady=6)
            entry.bind("<FocusOut>", lambda _event, i=index: self.on_preset_link_edit(i))
            entry.bind("<Return>", lambda _event, i=index: self.on_preset_link_edit(i))
            entry.bind("<Control-v>", lambda _event, i=index: self.root.after(
                60, lambda: self.on_preset_link_edit(i)))

            join_button = self._button(row, "입장", lambda i=index: self.on_join_preset(i),
                                       kind="ghost", width=6)
            join_button.pack(side="right", padx=(6, 8), pady=6)

            name_var_var = name_var
            self.preset_widgets.append({
                "row": row, "accent": accent, "name_button": name_button,
                "name_var": name_var_var, "link_var": link_var, "entry": entry,
                "join_button": join_button,
            })
            self.vars["preset_name_{}".format(index)] = name_var
            self.vars["preset_link_{}".format(index)] = link_var
            name_var.trace_add("write", lambda *_a, i=index: self.on_preset_name_edit(i))

    # -- 카드 2: 예약 ------------------------------------------------------
    def _build_schedule_card(self, parent):
        tk = self.tk
        inner = self._card(parent, "자동 입장 시점", "퇴근 시간에 맞춰 켜 두세요")

        self.vars["schedule_mode"] = tk.StringVar(value="always")
        mode_row = tk.Frame(inner, bg=COLOR_CARD)
        mode_row.pack(fill="x")
        for value, label in (("always", "컴 켜질 때 항상 입장"),
                             ("window", "지정 시간대만 자동 입장")):
            tk.Radiobutton(
                mode_row, text=label, value=value, variable=self.vars["schedule_mode"],
                command=self.on_schedule_change, bg=COLOR_CARD, fg=COLOR_TEXT,
                activebackground=COLOR_CARD, activeforeground=COLOR_TEXT,
                selectcolor=COLOR_CARD_DEEP, highlightthickness=0, bd=0,
                font=self.font_body, cursor="hand2").pack(side="left", padx=(0, 18))

        days_row = tk.Frame(inner, bg=COLOR_CARD)
        days_row.pack(fill="x", pady=(7, 0))
        tk.Label(days_row, text="요일", bg=COLOR_CARD, fg=COLOR_MUTED,
                 font=self.font_small, width=4, anchor="w").pack(side="left")
        self.weekday_buttons = []
        for index, label in enumerate(WEEKDAY_LABELS):
            button = tk.Button(
                days_row, text=label, command=lambda i=index: self.on_toggle_weekday(i),
                bg=COLOR_CARD_DEEP, fg=COLOR_MUTED, activebackground=COLOR_BLURPLE,
                activeforeground="#FFFFFF", relief="flat", bd=0, highlightthickness=0,
                font=self.font_button, width=3, pady=3, cursor="hand2")
            button.pack(side="left", padx=2)
            self.weekday_buttons.append(button)
        self.quick_button = self._button(days_row, "퇴근 모드 (평일 19:00~24:00)",
                                         self.on_commute_mode, kind="ghost")
        self.quick_button.pack(side="left", padx=(12, 0))

        time_row = tk.Frame(inner, bg=COLOR_CARD)
        time_row.pack(fill="x", pady=(7, 0))
        self.vars["start_time"] = tk.StringVar(value="19:00")
        self.vars["end_time"] = tk.StringVar(value="24:00")
        tk.Label(time_row, text="시작", bg=COLOR_CARD, fg=COLOR_MUTED,
                 font=self.font_small, width=4, anchor="w").pack(side="left")
        start_entry = self._entry(time_row, textvariable=self.vars["start_time"], width=8,
                                  justify="center")
        start_entry.pack(side="left", ipady=4)
        start_entry.bind("<FocusOut>", lambda _e: self.on_schedule_change())
        tk.Label(time_row, text="~", bg=COLOR_CARD, fg=COLOR_MUTED,
                 font=self.font_body, padx=8).pack(side="left")
        end_entry = self._entry(time_row, textvariable=self.vars["end_time"], width=8,
                                justify="center")
        end_entry.pack(side="left", ipady=4)
        end_entry.bind("<FocusOut>", lambda _e: self.on_schedule_change())
        tk.Label(time_row, text="(자정 넘김 OK · 예: 22:00~02:00)", bg=COLOR_CARD,
                 fg=COLOR_MUTED, font=self.font_small).pack(side="left", padx=(10, 0))

        self.schedule_state_var = tk.StringVar(value="")
        self.schedule_state_label = tk.Label(inner, textvariable=self.schedule_state_var,
                                            bg=COLOR_CARD, fg=COLOR_GREEN,
                                            font=self.font_small, anchor="w")
        self.schedule_state_label.pack(fill="x", pady=(6, 0))

    # -- 카드 3: 게임 ------------------------------------------------------
    def _build_game_card(self, parent):
        tk = self.tk
        inner = self._card(parent, "게임 동시 실행", "퇴근 후 원클릭: 입장 + 게임 같이")
        self.vars["game_enabled"] = tk.BooleanVar(value=False)
        self._check(inner, "입장할 때 이 프로그램도 같이 실행", self.vars["game_enabled"],
                    command=self.on_game_change).pack(anchor="w")

        row = tk.Frame(inner, bg=COLOR_CARD)
        row.pack(fill="x", pady=(8, 0))
        self.vars["game_path"] = tk.StringVar(value="")
        entry = self._entry(row, textvariable=self.vars["game_path"])
        entry.pack(side="left", fill="x", expand=True, ipady=5)
        entry.bind("<FocusOut>", lambda _e: self.on_game_change())
        entry.bind("<Return>", lambda _e: self.on_game_change())

        self.button_browse = self._button(row, "찾아보기", self.on_browse_game, kind="ghost", padx=9)
        self.button_browse.pack(side="left", padx=(8, 0))
        self.button_find_lol = self._button(row, "롤 자동 찾기", lambda: self.on_detect_game("lol"),
                                           kind="blurple", padx=9)
        self.button_find_lol.pack(side="left", padx=(6, 0))
        self.button_find_tft = self._button(row, "롤체 자동 찾기", lambda: self.on_detect_game("tft"),
                                           kind="blurple", padx=9)
        self.button_find_tft.pack(side="left", padx=(6, 0))

        self.game_hint_var = tk.StringVar(value="")
        tk.Label(inner, textvariable=self.game_hint_var, bg=COLOR_CARD, fg=COLOR_MUTED,
                 font=self.font_small, anchor="w", justify="left",
                 wraplength=self.WINDOW_WIDTH - 60).pack(fill="x", pady=(6, 0))

    # -- 카드 4: 자동 시작 -------------------------------------------------
    def _build_startup_card(self, parent):
        tk = self.tk
        inner = self._card(parent, "부팅 시 자동 시작", "윈도우 시작프로그램 등록")

        row = tk.Frame(inner, bg=COLOR_CARD)
        row.pack(fill="x")
        self.startup_led = self._led(row, size=12, color=COLOR_RED, bg=COLOR_CARD)
        self.startup_led.pack(side="left", padx=(0, 7))
        self.startup_var = tk.StringVar(value="")
        tk.Label(row, textvariable=self.startup_var, bg=COLOR_CARD, fg=COLOR_TEXT,
                 font=self.font_body, anchor="w").pack(side="left")

        self.vars["mic_notice"] = tk.BooleanVar(value=True)
        mic_row = tk.Frame(inner, bg=COLOR_CARD)
        mic_row.pack(fill="x", pady=(6, 0))
        self._check(mic_row, "입장 후 마이크 음소거 안내 팝업 (4초 뒤 저절로 닫힘)",
                    self.vars["mic_notice"], command=self.on_mic_change).pack(side="left")

        buttons = tk.Frame(inner, bg=COLOR_CARD)
        buttons.pack(fill="x", pady=(8, 0))
        self._button(buttons, "자동 시작 켜기", self.on_enable).pack(side="left")
        self._button(buttons, "자동 시작 끄기", self.on_disable, kind="danger"
                     ).pack(side="left", padx=(8, 0))
        self._button(buttons, "지금 테스트 입장", self.on_test, kind="ghost"
                     ).pack(side="left", padx=(8, 0))
        self.button_apply = self._button(buttons, "설정 저장", self.on_save, kind="ghost")
        self.button_apply.pack(side="right")

    # -- 새 버전 배너 / 업데이트 카드 --------------------------------------
    def _build_update_banner(self):
        tk = self.tk
        banner = tk.Frame(self.root, bg=COLOR_BLURPLE)
        self._banner = banner
        self.banner_var = tk.StringVar(value="")
        tk.Label(banner, textvariable=self.banner_var, bg=COLOR_BLURPLE, fg="#FFFFFF",
                 font=self.font_h2, anchor="w").pack(side="left", padx=(16, 8), pady=8)
        self.banner_button = tk.Button(
            banner, text="업데이트 보기", command=self.on_banner_click,
            bg="#FFFFFF", fg=COLOR_BLURPLE, activebackground="#E6E8FF",
            activeforeground=COLOR_BLURPLE, relief="flat", bd=0, highlightthickness=0,
            font=self.font_button, padx=10, pady=3, cursor="hand2")
        self.banner_button.pack(side="right", padx=8, pady=6)
        tk.Button(banner, text="닫기", command=self.hide_banner,
                  bg=COLOR_BLURPLE, fg="#E6E8FF", activebackground=COLOR_BLURPLE_HOVER,
                  activeforeground="#FFFFFF", relief="flat", bd=0, highlightthickness=0,
                  font=self.font_small, padx=6, pady=3, cursor="hand2").pack(side="right")

    def show_banner(self, manifest):
        """새 버전이 있음을 창 위쪽에 알립니다 (자동 교체는 하지 않음)."""
        self.latest_update = manifest
        self.banner_var.set("새 버전 {} 있음".format(version_text(manifest["version"])))
        self.update_status_var.set("새 버전 {} 있음 · [업데이트 보기] 로 확인하세요".format(
            version_text(manifest["version"])))
        if not self._banner.winfo_ismapped():
            self._banner.pack(fill="x", after=self._header)
            try:
                self.root.update_idletasks()
            except Exception:
                pass
            self._show_scrollbar_if_needed()

    def hide_banner(self):
        try:
            self._banner.pack_forget()
        except Exception:
            pass

    def on_banner_click(self):
        if self.latest_update:
            self._open_update_dialog(self.latest_update)

    def _build_update_row(self, parent):
        """화면 맨 아래 고정 줄: 현재 버전 + [업데이트 확인] (스크롤과 상관없이 보임)."""
        tk = self.tk
        row = tk.Frame(parent, bg=COLOR_BG)
        row.pack(fill="x", pady=(6, 0))
        self.update_status_var = tk.StringVar(
            value="새 버전이 있으면 알려 드려요. (사용자가 누를 때만 바뀝니다)")
        tk.Label(row, textvariable=self.update_status_var, bg=COLOR_BG, fg=COLOR_MUTED,
                 font=self.font_small, anchor="w", justify="left").pack(side="left")
        self.button_update = self._button(row, "업데이트 확인", self.on_update_check,
                                          kind="ghost", padx=10)
        self.button_update.pack(side="right")
        self.version_var = tk.StringVar(value="v{}".format(APP_VERSION))
        tk.Label(row, textvariable=self.version_var, bg=COLOR_BG, fg=COLOR_MUTED,
                 font=self.font_small, anchor="e").pack(side="right", padx=(0, 10))

    # -- 업데이트 확인 / 적용 -------------------------------------------
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
        if getattr(self, "_alive", False):
            try:
                self.root.after(300, self._poll_update_queue)
            except Exception:
                pass

    def _handle_update_event(self, kind, payload):
        if kind == "check":
            result, interactive = payload
            self._after_check(result, interactive)
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
        self.set_message("업데이트를 확인하고 있어요…", COLOR_MUTED)
        self._run_check(True)

    def _run_check(self, interactive):
        def worker():
            try:
                result = check_for_update(APP_VERSION, fetch=self.fetch)
            except Exception:
                result = None
            self._queue_update("check", (result, interactive))

        try:
            threading.Thread(target=worker, daemon=True).start()
        except Exception:
            # 스레드를 못 만들면 화면을 멈추지 않도록 그냥 포기합니다.
            return
        self._update_busy = True

    def _after_check(self, result, interactive):
        self._update_busy = False
        if not result:
            self.update_status_var.set("최신 버전이에요 · {}".format(version_text(APP_VERSION)))
            if interactive:
                self.set_message("지금이 최신 버전({})이에요.".format(version_text(APP_VERSION)),
                                 COLOR_GREEN)
            return
        self.show_banner(result)
        if interactive:
            self._open_update_dialog(result)

    def _open_update_dialog(self, manifest):
        tk = self.tk
        if self._dialog is not None:
            try:
                self._dialog.destroy()
            except Exception:
                pass
        dialog = tk.Toplevel(self.root)
        self._dialog = dialog
        dialog.title("업데이트 - " + APP_TITLE)
        dialog.configure(bg=COLOR_CARD)
        dialog.resizable(False, False)
        dialog.transient(self.root)

        frame = tk.Frame(dialog, bg=COLOR_CARD)
        frame.pack(fill="both", expand=True, padx=20, pady=16)

        tk.Label(frame, text="새 버전이 나왔어요", bg=COLOR_CARD, fg=COLOR_TEXT,
                 font=self.font_h1).pack(anchor="w")
        tk.Label(frame, text="{}  →  {}".format(version_text(APP_VERSION),
                                                version_text(manifest["version"])),
                 bg=COLOR_CARD, fg=COLOR_BLURPLE_PALE, font=self.font_h2,
                 anchor="w").pack(anchor="w", pady=(6, 0))

        notes = manifest.get("notes") or "새 버전이 준비되었습니다."
        box = tk.Frame(frame, bg=COLOR_CARD_DEEP)
        box.pack(fill="x", pady=(12, 0))
        tk.Label(box, text="업데이트 내용", bg=COLOR_CARD_DEEP, fg=COLOR_MUTED,
                 font=self.font_small, anchor="w").pack(fill="x", padx=10, pady=(8, 0))
        tk.Label(box, text=notes, bg=COLOR_CARD_DEEP, fg=COLOR_TEXT, font=self.font_body,
                 anchor="w", justify="left", wraplength=420).pack(fill="x", padx=10, pady=(2, 9))

        tk.Label(frame, text="출처: {}".format(UPDATE_SITE_LABEL), bg=COLOR_CARD,
                 fg=COLOR_MUTED, font=self.font_small, anchor="w").pack(fill="x", pady=(10, 0))
        tk.Label(frame, text="SHA-256 지문을 대조해 원본과 같을 때만 파일을 바꿉니다.\n"
                            "설정(config.json)과 자동 시작(.vbs)는 그대로 유지됩니다.",
                 bg=COLOR_CARD, fg=COLOR_MUTED, font=self.font_small, anchor="w",
                 justify="left", wraplength=420).pack(fill="x", pady=(2, 0))

        self.dialog_status_var = tk.StringVar(value="")
        tk.Label(frame, textvariable=self.dialog_status_var, bg=COLOR_CARD, fg=COLOR_GREEN,
                 font=self.font_small, anchor="w", justify="left",
                 wraplength=420).pack(fill="x", pady=(8, 0))

        buttons = tk.Frame(frame, bg=COLOR_CARD)
        buttons.pack(fill="x", pady=(12, 0))
        self.dialog_update_button = self._button(
            buttons, "업데이트", lambda: self.on_start_update(manifest), kind="blurple",
            width=10)
        self.dialog_update_button.pack(side="right")
        self._button(buttons, "나중에", self._close_dialog, kind="ghost", width=8).pack(
            side="right", padx=(0, 8))

        dialog.update_idletasks()
        try:
            x = self.root.winfo_rootx() + (self.root.winfo_width() - dialog.winfo_reqwidth()) // 2
            y = self.root.winfo_rooty() + 130
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
            self.dialog_update_button.configure(state="disabled")
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
            install_update(new_file, self.app_file)
        except UpdateError as error:
            self._after_download_fail(str(error))
            return
        finally:
            _safe_unlink(new_file)
        self._update_busy = False
        self.update_status_var.set("업데이트 완료 · 다시 시작 중")
        self.set_message("업데이트를 마쳤어요. 잠시 뒤 새 버전으로 다시 시작합니다.", COLOR_GREEN)
        self.root.after(UPDATE_RESTART_DELAY_MS, self._restart_after_update)

    def _after_download_fail(self, message):
        self._update_busy = False
        try:
            self.dialog_update_button.configure(state="normal")
        except Exception:
            pass
        try:
            if self._dialog is not None:
                self.dialog_status_var.set(message)
        except Exception:
            pass
        self.update_status_var.set("업데이트를 하지 않았어요 · 원래 버전 그대로입니다")
        self.set_message(message, COLOR_RED)

    def _restart_after_update(self):
        try:
            restart_application(self.app_file)
        except Exception as error:
            self.set_message("다시 시작하지 못했어요: {}. 앱을 직접 다시 열어 주세요.".format(error),
                             COLOR_RED)
            return
        self.save_now()
        try:
            self.root.destroy()
        except Exception:
            pass

    def _build_footer(self, parent):
        tk = self.tk
        footer = tk.Frame(parent, bg=COLOR_BG)
        self._footer = footer
        footer.pack(fill="x", side="bottom", padx=16, pady=(2, 12))
        self.message_var = tk.StringVar(value="설정은 바꾸는 즉시 자동 저장됩니다.")
        self.message_label = tk.Label(footer, textvariable=self.message_var, bg=COLOR_BG,
                                      fg=COLOR_MUTED, font=self.font_small, anchor="w",
                                      justify="left", wraplength=self.WINDOW_WIDTH - 40)
        self.message_label.pack(fill="x")
        self.config_var = tk.StringVar(value="")
        bottom = tk.Frame(footer, bg=COLOR_BG)
        bottom.pack(fill="x", pady=(3, 0))
        tk.Label(bottom, textvariable=self.config_var, bg=COLOR_BG, fg="#80848E",
                 font=self.font_small, anchor="w", justify="left").pack(side="left")
        self._build_update_row(footer)

    # -- 상태/저장 ---------------------------------------------------------
    def _fit_window(self):
        """내용에 맞춰 창 높이를 잡되, 화면보다 커지면 스크롤로 처리합니다."""
        try:
            self.root.update_idletasks()
            header_h = self._header.winfo_reqheight()
            body_h = self._body.winfo_reqheight()
            footer_h = self._footer.winfo_reqheight()
            needed = max(header_h + body_h + footer_h + 26, 640)
            screen_height = self.root.winfo_screenheight()
            limit = max(560, int(screen_height * 0.92) - 60)
            height = min(needed, limit)
            self.root.geometry("{}x{}".format(self.WINDOW_WIDTH, height))
            self.root.update_idletasks()
            self._show_scrollbar_if_needed()
        except Exception:
            pass

    def _load_into_widgets(self):
        config = self.config
        for index, widgets in enumerate(self.preset_widgets):
            preset = config["presets"][index]
            widgets["name_var"].set(preset["name"])
            widgets["link_var"].set(preset["link"])
            widgets["name_button"].configure(text=preset["name"])
        schedule = config["schedule"]
        self.vars["schedule_mode"].set(schedule["mode"])
        self.vars["start_time"].set(schedule["start"])
        self.vars["end_time"].set(schedule["end"])
        self.vars["game_enabled"].set(bool(config["game"]["enabled"]))
        self.vars["game_path"].set(config["game"]["path"])
        self._refresh_game_hint()
        self.vars["mic_notice"].set(bool(config["mic_notice"]))
        self._paint_weekdays()
        self.config_var.set("설정 파일: {}".format(display_config_path()))

    def _paint_presets(self):
        current = active_index(self.config)
        for index, widgets in enumerate(self.preset_widgets):
            preset = self.config["presets"][index]
            active = index == current
            widgets["name_button"].configure(
                text=preset["name"],
                bg=COLOR_BLURPLE if active else COLOR_CARD_DEEP,
                fg="#FFFFFF" if active else COLOR_MUTED,
                activebackground=COLOR_BLURPLE_HOVER if active else COLOR_BLURPLE)
            widgets["row"].configure(highlightbackground=COLOR_GREEN if active else COLOR_BORDER)
            widgets["accent"].configure(bg=COLOR_GREEN if active else COLOR_BORDER)
            widgets["entry"].configure(highlightbackground=COLOR_BLURPLE if active
                                       else COLOR_BORDER)
            widgets["name_var"].set(preset["name"])

    def _paint_weekdays(self):
        weekdays = self.config["schedule"]["weekdays"]
        for index, button in enumerate(self.weekday_buttons):
            on = bool(weekdays[index])
            button.configure(bg=COLOR_BLURPLE if on else COLOR_CARD_DEEP,
                             fg="#FFFFFF" if on else COLOR_MUTED)

    def save_now(self):
        try:
            save_config(self.config, self.config_file)
        except OSError as exc:
            self.set_message("설정을 저장하지 못했어요: {}".format(exc), COLOR_RED)
            return False
        return True

    def _autosave(self, delay=500):
        if self._autosave_job is not None:
            try:
                self.root.after_cancel(self._autosave_job)
            except Exception:
                pass
        try:
            self._autosave_job = self.root.after(delay, self._do_autosave)
        except Exception:
            self._autosave_job = None

    def _do_autosave(self):
        self._autosave_job = None
        self.save_now()

    def set_message(self, text, color=COLOR_MUTED):
        self.message_var.set(text)
        self.message_label.configure(fg=color)

    def refresh_status(self):
        try:
            if self.startup_dir is None:
                self.startup_dir = startup_directory()
        except RuntimeError as exc:
            self.startup_var.set("자동 시작: 사용할 수 없음 (윈도우에서 실행해 주세요)")
            self._set_led(self.startup_led, COLOR_RED)
            self._set_led(self.header_led, COLOR_RED)
            self.header_status_var.set("자동 입장 사용 불가")
            self.set_message(str(exc), COLOR_RED)
            self._paint_presets()
            return

        enabled = is_startup_enabled(self.startup_dir)
        schedule = self.config["schedule"]
        active_name = self.config["presets"][active_index(self.config)]["name"]
        if enabled:
            self._set_led(self.header_led, COLOR_GREEN)
            self._set_led(self.startup_led, COLOR_GREEN)
            self.header_status_var.set("자동 입장 켜짐")
            self.startup_var.set("켜짐 · {} · {}".format(schedule_summary(schedule), active_name))
        else:
            self._set_led(self.header_led, COLOR_RED)
            self._set_led(self.startup_led, COLOR_RED)
            self.header_status_var.set("자동 입장 꺼짐")
            self.startup_var.set("꺼짐 · [자동 시작 켜기] 를 누르면 부팅할 때 들어갑니다")
        self._paint_presets()
        self._paint_weekdays()
        now = self.now_provider()
        inside = should_join_now(now, schedule)
        text = "{} · {}".format(schedule_summary(schedule), schedule_state_text(now, schedule))
        self.schedule_state_var.set(text)
        self.schedule_state_label.configure(fg=COLOR_GREEN if inside else COLOR_MUTED)

    # -- 이벤트 ------------------------------------------------------------
    def _sync_preset_from_widgets(self, index):
        preset = self.config["presets"][index]
        preset["name"] = clean_preset_name(self.vars["preset_name_{}".format(index)].get(), index)
        raw_link = self.vars["preset_link_{}".format(index)].get().strip()
        if raw_link:
            try:
                preset["link"] = normalize_link(raw_link)
            except LinkError:
                preset["link"] = ""
        else:
            preset["link"] = ""
        return preset

    def on_activate(self, index):
        for i in range(PRESET_COUNT):
            self._sync_preset_from_widgets(i)
        self.config = activate_preset(self.config, index)
        self._autosave(150)
        name = self.config["presets"][index]["name"]
        has_link = bool(self.config["presets"][index]["link"])
        if has_link:
            self.set_message("{}으로 전환했어요. [지금 테스트 입장] 으로 확인해 보세요.".format(name),
                             COLOR_BLURPLE_PALE)
        else:
            self.set_message("{}으로 전환했어요. 아직 링크가 비어 있어요.".format(name), COLOR_YELLOW)
        self.refresh_status()
        self._resync_startup()

    def on_rename_preset(self, index):
        from tkinter import simpledialog
        widgets = self.preset_widgets[index]
        new_name = simpledialog.askstring(
            "방 이름 수정", "프리셋 {}의 이름을 적어 주세요".format(index + 1),
            initialvalue=widgets["name_var"].get(), parent=self.root)
        if new_name is None:
            return
        widgets["name_var"].set(clean_preset_name(new_name, index))
        self._paint_presets()
        self.set_message("이름을 '{}' 로 바꿨어요.".format(widgets["name_var"].get()),
                         COLOR_BLURPLE_PALE)
        self._autosave(150)

    def on_preset_name_edit(self, index):
        widgets = self.preset_widgets[index]
        name = clean_preset_name(widgets["name_var"].get(), index)
        widgets["name_button"].configure(text=name)
        self.config["presets"][index]["name"] = name
        self._autosave()

    def on_preset_link_edit(self, index):
        raw_link = self.vars["preset_link_{}".format(index)].get().strip()
        preset = self.config["presets"][index]
        if not raw_link:
            preset["link"] = ""
            self._autosave(150)
            return
        try:
            link = normalize_link(raw_link)
        except LinkError as exc:
            self.set_message(str(exc).split("\n")[0], COLOR_RED)
            return
        preset["link"] = link
        self.vars["preset_link_{}".format(index)].set(link)
        guild, channel = split_link(link)
        self.set_message("{} 링크를 저장했어요 (서버 {} · 채널 {}).".format(
            preset["name"], guild, channel), COLOR_BLURPLE_PALE)
        self._autosave(150)
        self.refresh_status()
        self._resync_startup()

    def on_schedule_change(self):
        try:
            start = format_minutes(parse_time(self.vars["start_time"].get()))
            end = format_minutes(parse_time(self.vars["end_time"].get()))
        except TimeFormatError as exc:
            self.set_message(str(exc), COLOR_RED)
            return
        self.vars["start_time"].set(start)
        self.vars["end_time"].set(end)
        self.config["schedule"]["start"] = start
        self.config["schedule"]["end"] = end
        self.config["schedule"]["mode"] = self.vars["schedule_mode"].get()
        self._autosave()
        self.refresh_status()
        self._resync_startup()

    def on_toggle_weekday(self, index):
        weekdays = self.config["schedule"]["weekdays"]
        weekdays[index] = not weekdays[index]
        self._paint_weekdays()
        self._autosave()
        self.refresh_status()
        self._resync_startup()

    def on_commute_mode(self):
        self.vars["schedule_mode"].set("window")
        self.config["schedule"] = {
            "mode": "window",
            "weekdays": [True, True, True, True, True, False, False],
            "start": "19:00",
            "end": "24:00",
        }
        self.vars["start_time"].set("19:00")
        self.vars["end_time"].set("24:00")
        self._paint_weekdays()
        self._autosave(150)
        self.refresh_status()
        self._resync_startup()
        self.set_message("퇴근 모드를 켰어요 · 평일 19:00~24:00 에만 자동 입장합니다.",
                         COLOR_BLURPLE_PALE)

    def on_game_change(self):
        path = clean_path(self.vars["game_path"].get())
        enabled = bool(self.vars["game_enabled"].get())
        previous = self.config.get("game") or {}
        args = str(previous.get("args") or "")
        if path != previous.get("path"):
            # 경로가 직접 바뀌면 인자는 다시 계산합니다 (자동 찾기에서 넣어 줌)
            args = ""
        if enabled and path and not self.exists(path):
            self.set_message("게임 실행 파일(.exe / .lnk) 경로를 확인해 주세요: {}".format(path),
                             COLOR_RED)
        self.config["game"] = {"enabled": enabled and bool(path), "path": path, "args": args}
        self._autosave()
        self._resync_startup()
        self._refresh_game_hint()

    def _register_game(self, path, args=""):
        """게임 경로/인자를 설정에 넣고 화면에 반영합니다."""
        resolved, resolved_args, changed = resolve_game_launch(
            path, args, env=self.env, exists=self.exists)
        self.vars["game_path"].set(resolved)
        self.vars["game_enabled"].set(True)
        self.config["game"] = {"enabled": True, "path": resolved, "args": resolved_args}
        self._autosave(150)
        self._resync_startup()
        self._refresh_game_hint()
        return resolved, resolved_args, changed

    def _refresh_game_hint(self):
        game = self.config.get("game") or {}
        path = game.get("path") or ""
        args = game.get("args") or ""
        if path:
            text = "실행: {} {}".format(program_name(path), args).strip()
            text += "  ·  체크가 켜져 있으면 입장할 때 함께 실행됩니다"
        else:
            text = ("예: C:\\Riot Games\\Riot Client\\RiotClientServices.exe  ·  "
                    "바탕화면에 바로가기가 있으면 [롤 자동 찾기] 한 번이면 끝나요")
        self.game_hint_var.set(text)

    def on_detect_game(self, kind):
        """[롤 자동 찾기] / [롤체 자동 찾기]"""
        try:
            found = detect_game(kind, env=self.env, exists=self.exists)
        except GameNotFoundError as error:
            self.set_message(str(error), COLOR_YELLOW)
            return
        self._register_game(found["path"], found["args"])
        detail = found["detail"]
        if found["args"]:
            detail += " · " + found["args"]
        self.set_message("{}를 찾았어요: {} ({})".format(
            found["label"], program_name(found["path"]), detail), COLOR_GREEN)

    def on_browse_game(self):
        from tkinter import filedialog
        current = clean_path(self.vars["game_path"].get())
        initial = os.path.dirname(current) if current and os.path.isdir(os.path.dirname(current)) else None
        try:
            path = filedialog.askopenfilename(
                parent=self.root, title="같이 실행할 게임/프로그램 선택",
                initialdir=initial,
                filetypes=[("게임·프로그램", "*.exe *.lnk *.url *.bat *.cmd"), ("모든 파일", "*.*")])
        except Exception as exc:
            self.set_message("파일 선택 창을 열지 못했어요: {}".format(exc), COLOR_RED)
            return
        if not path:
            return
        path = path.replace("/", "\\")
        resolved, args, changed = self._register_game(path)
        if changed:
            self.set_message("라이엇 클라이언트로 실행하도록 바꿨어요: {} {}".format(
                program_name(resolved), args), COLOR_BLURPLE_PALE)
        else:
            self.set_message("같이 실행할 프로그램을 등록했어요: {}".format(program_name(resolved)),
                             COLOR_BLURPLE_PALE)

    def on_mic_change(self):
        self.config["mic_notice"] = bool(self.vars["mic_notice"].get())
        self._autosave()
        self._resync_startup()

    def on_close(self):
        self._alive = False
        try:
            if self._autosave_job is not None:
                self.root.after_cancel(self._autosave_job)
                self._autosave_job = None
        except Exception:
            pass
        self.save_now()
        self.root.destroy()

    def on_save(self):
        if self.save_now():
            self.set_message("설정을 저장했어요.", COLOR_GREEN)
        self.refresh_status()

    def _resync_startup(self):
        """자동 시작이 켜져 있으면 바뀐 설정으로 .vbs 를 다시 씁니다."""
        if self.startup_dir is None or not is_startup_enabled(self.startup_dir):
            return
        try:
            enable_startup(self.startup_dir, self.config)
        except (OSError, LinkError):
            pass

    def _ensure_active_link(self):
        link = active_link(self.config)
        if link:
            return link
        # 활성 방이 비어 있으면 링크가 있는 다른 방을 씁니다.
        for index, preset in enumerate(self.config["presets"]):
            if preset["link"]:
                self.config = activate_preset(self.config, index)
                self._autosave(150)
                self.refresh_status()
                self.set_message("활성 방이 비어 있어 {}으로 대신 입장합니다.".format(preset["name"]),
                                 COLOR_YELLOW)
                return preset["link"]
        raise LinkError("입장할 음성방 링크가 없어요.\n프리셋 1~3 중 하나에 음성방 링크를 넣어 주세요.")

    def on_test(self):
        for i in range(PRESET_COUNT):
            self._sync_preset_from_widgets(i)
        try:
            link = self._ensure_active_link()
        except LinkError as exc:
            self.set_message(str(exc), COLOR_RED)
            return
        self._do_join(link, self.config["presets"][active_index(self.config)]["name"])

    def on_join_preset(self, index):
        """프리셋 줄의 [입장] 버튼: 그 방으로 바로 전환해서 입장합니다."""
        self._sync_preset_from_widgets(index)
        preset = self.config["presets"][index]
        if not preset["link"]:
            self.set_message("{} 에는 아직 링크가 없어요. 링크를 붙여넣고 다시 [입장] 을 눌러 주세요."
                             .format(preset["name"]), COLOR_YELLOW)
            return
        self.config = activate_preset(self.config, index)
        self._autosave(150)
        self.refresh_status()
        self._resync_startup()
        self._do_join(preset["link"], preset["name"])

    def _do_join(self, link, name):
        try:
            self.opener(link)
        except Exception as exc:  # OS 연결 실패 등
            self.set_message("디스코드를 열지 못했어요: {}\n디스코드가 설치되어 있는지 확인해 주세요."
                             .format(exc), COLOR_RED)
            return
        extra = ""
        if self.config["game"]["enabled"] and self.config["game"]["path"]:
            path, args, _changed = resolve_game_launch(
                self.config["game"]["path"], self.config["game"].get("args", ""),
                env=self.env, exists=self.exists)
            try:
                launch_game(path, args)
                extra = " · {}도 함께 실행했어요".format(program_name(path))
            except Exception:
                extra = " · 게임은 실행하지 못했어요"
        if self.config["mic_notice"]:
            extra += " · 마이크는 Ctrl+Shift+M 으로 음소거하세요"
        self.set_message("{} 으로 입장을 요청했어요{}.".format(name, extra),
                         COLOR_GREEN)
        self.refresh_status()

    def on_enable(self):
        for i in range(PRESET_COUNT):
            self._sync_preset_from_widgets(i)
        try:
            link = self._ensure_active_link()
        except LinkError as exc:
            self.set_message(str(exc), COLOR_RED)
            return
        if self.startup_dir is None:
            try:
                self.startup_dir = startup_directory()
            except RuntimeError as exc:
                self.set_message(str(exc), COLOR_RED)
                return
        try:
            enable_startup(self.startup_dir, self.config)
        except OSError as exc:
            self.set_message("시작프로그램에 등록하지 못했어요: {}\n백신 프로그램이 막고 있는지 확인해 주세요."
                             .format(exc), COLOR_RED)
            return
        schedule = self.config["schedule"]
        tail = "부팅하면 약 {}초 뒤 {}. ".format(self.config["wait_seconds"], "입장합니다")
        if schedule["mode"] == "window":
            tail = "부팅하면 약 {}초 뒤, {} 일 때만 입장합니다. ".format(
                self.config["wait_seconds"], schedule_summary(schedule))
        self.set_message("자동 시작을 켰어요. " + tail + "지금은 [지금 테스트 입장] 으로 확인해 보세요.",
                         COLOR_GREEN)
        self.save_now()
        self.refresh_status()

    def on_disable(self):
        if self.startup_dir is None:
            try:
                self.startup_dir = startup_directory()
            except RuntimeError as exc:
                self.set_message(str(exc), COLOR_RED)
                return
        removed = disable_startup(self.startup_dir)
        if removed:
            self.set_message("자동 시작을 껐어요. 이제 부팅해도 자동으로 들어가지 않습니다.", COLOR_BLURPLE_PALE)
        else:
            self.set_message("자동 시작이 이미 꺼져 있었어요.", COLOR_MUTED)
        self.refresh_status()


def main(argv=None):
    import tkinter as tk

    _enable_dpi_awareness()
    root = tk.Tk()
    ProApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())

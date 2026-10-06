"""
Settings, paths and identity for Python plugins.

Plugins read and write their own preferences through `config`, and read a few
fixed values (`appname`, the plugin and journal folders). Everything is stored
in one JSON file in the host's data folder. Keys are shared by all plugins, as
plugins expect; each plugin namespaces its own.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

appname = 'EDFMCompanion'
appcmdname = 'EDFMC'
copyright = '(c) 2026 xplosivoctopus'

_VERSION = os.environ.get('EDFMC_VERSION', '0.1.0')


class _Version(str):
    """A version that compares like a string and has the attributes plugins read."""

    @property
    def major(self) -> int:
        return int(self.split('.')[0])

    @property
    def minor(self) -> int:
        parts = self.split('.')
        return int(parts[1]) if len(parts) > 1 else 0

    @property
    def patch(self) -> int:
        parts = self.split('.')
        return int(parts[2].split('-')[0]) if len(parts) > 2 else 0


def appversion() -> _Version:
    return _Version(_VERSION)


def appversion_nobuild() -> _Version:
    return _Version(_VERSION)


user_agent = f'EDFMCompanion/{_VERSION}'

# Theme values plugins compare against.
THEME_DEFAULT = 0
THEME_DARK = 1
THEME_TRANSPARENT = 2


class _Config:
    """Key/value store with the typed getters plugins call."""

    OUT_EDDN_SEND_STATION_DATA = 1
    OUT_EDDN_SEND_NON_STATION = 256
    OUT_EDDN_DELAY = 4096

    def __init__(self) -> None:
        self._lock = threading.Lock()
        data_dir = os.environ.get('EDFMC_DATA_DIR') or os.path.join(os.path.expanduser('~'), '.edfmc')
        self.app_dir_path = data_dir
        self.app_dir = data_dir
        self.plugin_dir_path = os.environ.get('EDFMC_PLUGIN_DIR') or os.path.join(data_dir, 'plugins')
        self.plugin_dir = self.plugin_dir_path
        self.internal_plugin_dir_path = self.plugin_dir_path
        self.internal_plugin_dir = self.plugin_dir_path
        self.default_journal_dir_path = os.environ.get('EDFMC_JOURNAL_DIR', '')
        self.default_journal_dir = self.default_journal_dir_path
        self.home_path = os.path.expanduser('~')
        self.home = self.home_path
        self.respath_path = os.path.dirname(os.path.abspath(__file__))
        self.respath = self.respath_path
        self.identifier = 'com.edfieldmanual.companion'
        self.shutting_down = False
        self._path = os.path.join(data_dir, 'plugin-settings.json')
        self._values: dict[str, Any] = {}
        try:
            with open(self._path, encoding='utf-8') as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                self._values = loaded
        except (OSError, ValueError):
            pass
        # Values plugins commonly read that the host itself owns.
        self._values.setdefault('theme', THEME_DARK)
        self._values.setdefault('journaldir', self.default_journal_dir_path)
        # Dark-theme colours plugins read for their own text (SpanshRouter's
        # placeholders do). Matched to the app's palette.
        self._values.setdefault('dark_text', '#ededed')
        self._values.setdefault('dark_highlight', '#ff7d20')

    # -- typed getters ---------------------------------------------------

    def get_str(self, key: str, *, default: str | None = None) -> str | None:
        v = self._values.get(key, default)
        return v if isinstance(v, str) or v is None else str(v)

    def get_int(self, key: str, *, default: int = 0) -> int:
        v = self._values.get(key, default)
        if isinstance(v, bool):
            return int(v)
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    def get_bool(self, key: str, *, default: bool | None = None) -> bool | None:
        v = self._values.get(key, default)
        if v is None:
            return None
        return bool(v)

    def get_list(self, key: str, *, default: list | None = None) -> list | None:
        v = self._values.get(key, default)
        if v is None or isinstance(v, list):
            return v
        return [v]

    def get(self, key: str, default: Any = None) -> Any:
        """Older, untyped getter some plugins still use."""
        return self._values.get(key, default)

    def getint(self, key: str, default: int = 0) -> int:
        return self.get_int(key, default=default)

    # -- writes ----------------------------------------------------------

    def set(self, key: str, val: Any) -> None:
        if not isinstance(val, (str, int, bool, list)):
            raise ValueError(f'Unexpected type for config value {key}: {type(val)}')
        with self._lock:
            self._values[key] = val
        self.save()

    def delete(self, key: str, *, suppress: bool = False) -> None:
        with self._lock:
            if key not in self._values and not suppress:
                raise KeyError(key)
            self._values.pop(key, None)
        self.save()

    def save(self) -> None:
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self._path), exist_ok=True)
                tmp = self._path + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(self._values, f, indent=1)
                os.replace(tmp, self._path)
            except OSError:
                pass

    def close(self) -> None:
        self.save()

    def set_shutdown(self) -> None:
        self.shutting_down = True


config = _Config()


def get_config(*args: Any, **kwargs: Any) -> _Config:
    return config

"""
Translation and number formatting for plugins.

The app is English-only, so translation returns its input. Numbers are formatted
with the user's locale, which is what plugins expect from these helpers.
"""

from __future__ import annotations

import locale
from typing import Any


class _Translations:
    FALLBACK = 'en'

    def install(self, lang: str | None = None) -> None:
        pass

    def install_dummy(self) -> None:
        pass

    def translate(self, x: str, context: str | None = None, lang: str | None = None) -> str:
        return x

    def tl(self, x: str, context: str | None = None, lang: str | None = None) -> str:
        return x

    def available(self) -> set[str]:
        return {'en'}

    def available_names(self) -> dict[Any, str]:
        return {None: 'Default', 'en': 'English'}


translations = _Translations()
Translations = translations


def _(x: str) -> str:
    return x


class _Locale:
    def string_from_number(self, number: float | int, decimals: int | None = None) -> str:
        if decimals is None:
            decimals = 0 if isinstance(number, int) else 5
        return locale.format_string(f'%.{decimals}f', number, grouping=True)

    def number_from_string(self, string: str) -> int | float | None:
        try:
            return locale.atoi(string)
        except ValueError:
            try:
                return locale.atof(string)
            except ValueError:
                return None

    def preferred_languages(self) -> list[str]:
        return ['en']


Locale = _Locale()

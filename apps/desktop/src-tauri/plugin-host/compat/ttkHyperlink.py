"""A label that opens a web page when clicked."""

from __future__ import annotations

import tkinter as tk
import webbrowser
from typing import Any

from theme import ACCENT, SURFACE


class HyperlinkLabel(tk.Label):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        self.url = kw.pop('url', None)
        self.popup_copy = kw.pop('popup_copy', False)
        kw.pop('underline', None)
        kw.setdefault('foreground', ACCENT)
        kw.setdefault('background', SURFACE)
        kw.setdefault('cursor', 'hand2')
        super().__init__(master, **kw)
        self.bind('<Button-1>', self._click)

    def configure(self, cnf: Any = None, **kw: Any) -> Any:
        if 'url' in kw:
            self.url = kw.pop('url')
        kw.pop('popup_copy', None)
        return super().configure(cnf, **kw)

    config = configure

    def _click(self, _event: Any = None) -> None:
        url = self.url(self['text']) if callable(self.url) else self.url
        if url:
            webbrowser.open(url)

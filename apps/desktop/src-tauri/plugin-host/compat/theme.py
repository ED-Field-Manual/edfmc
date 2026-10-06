"""
Colours for plugin widgets.

Plugins call `theme.register(widget)` and `theme.apply(root)` so their widgets
match the window. The plugin window uses the app's dark palette, so `active`
reports the dark theme and `apply` recolours registered widgets to match.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Any

SURFACE = '#212121'
RAISED = '#2b2b2b'
TEXT = '#ededed'
MUTED = '#9d9d9d'
ACCENT = '#ff7d20'
LINE = '#353535'


#: Colours Tk uses when nothing chose one: Windows system colours and Tk's own.
_DEFAULTS = {'', 'white', '#ffffff', 'black', '#000000', '#f0f0f0', '#d9d9d9', '#a3a3a3', '#6d6d6d'}


def _is_default(value: str) -> bool:
    v = value.strip().lower()
    return v.startswith('system') or v in _DEFAULTS


class _Theme:
    THEME_DEFAULT = 0
    THEME_DARK = 1
    THEME_TRANSPARENT = 2

    def __init__(self) -> None:
        self.active: int = self.THEME_DARK
        self.current: dict[str, str] = {
            'background': SURFACE,
            'foreground': TEXT,
            'activebackground': RAISED,
            'activeforeground': TEXT,
            'disabledforeground': MUTED,
            'highlight': ACCENT,
            'font': 'TkDefaultFont',
        }
        self.widgets: set[Any] = set()
        self.minwidth = None

    def initialize(self, root: tk.Tk) -> None:
        root.configure(background=SURFACE)
        style = ttk.Style(root)
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass
        style.configure('.', background=SURFACE, foreground=TEXT, fieldbackground=RAISED,
                        bordercolor=LINE, lightcolor=LINE, darkcolor=LINE)
        style.configure('TButton', background=RAISED)
        style.map('TButton', background=[('active', LINE)])
        style.configure('TNotebook', background=SURFACE)
        style.configure('TNotebook.Tab', background=RAISED, foreground=TEXT, padding=(10, 4))
        style.map('TNotebook.Tab', background=[('selected', SURFACE)],
                  foreground=[('selected', ACCENT)])
        root.option_add('*Background', SURFACE)
        root.option_add('*Foreground', TEXT)
        root.option_add('*activeBackground', RAISED)
        root.option_add('*activeForeground', TEXT)
        root.option_add('*selectColor', RAISED)
        root.option_add('*insertBackground', TEXT)
        root.option_add('*highlightBackground', SURFACE)
        root.option_add('*highlightColor', ACCENT)
        root.option_add('*troughColor', RAISED)
        root.option_add('*Entry.Background', RAISED)
        root.option_add('*Listbox.Background', RAISED)

    def register(self, widget: Any) -> None:
        self.widgets.add(widget)
        self._paint(widget)

    def register_alternate(self, pair: Any, gridopts: Any) -> None:
        pass

    def button_bind(self, widget: Any, command: Any, image: Any = None) -> None:
        widget.bind('<Button-1>', lambda e: command())

    def update(self, widget: Any) -> None:
        self._paint(widget)

    def apply(self, root: Any = None) -> None:
        for w in list(self.widgets):
            self._paint(w)
        if root is not None:
            self._paint_tree(root)

    def _paint_tree(self, widget: Any) -> None:
        self._paint(widget)
        try:
            children = widget.winfo_children()
        except tk.TclError:
            return
        for child in children:
            self._paint_tree(child)

    def _paint(self, widget: Any) -> None:
        """Recolour a classic tk widget; ttk widgets follow the style instead."""
        try:
            if not widget.winfo_exists():
                self.widgets.discard(widget)
                return
            keys = widget.keys()
        except (tk.TclError, AttributeError):
            return
        # Only colours still at a platform default are replaced. A plugin that
        # styled itself (Router draws its own buttons and fields in the app's
        # palette; others pick highlight or warning colours) keeps its choices.
        wanted = {
            'background': RAISED if widget.winfo_class() in ('Entry', 'Listbox', 'Text') else SURFACE,
            'foreground': TEXT,
            'activebackground': RAISED,
            'activeforeground': TEXT,
            'highlightbackground': SURFACE,
            'insertbackground': TEXT,
        }
        if widget.winfo_class() in ('Checkbutton', 'Radiobutton'):
            wanted['selectcolor'] = RAISED
        opts: dict[str, str] = {}
        for key, value in wanted.items():
            if key not in keys:
                continue
            try:
                current = str(widget.cget(key))
            except tk.TclError:
                continue
            if _is_default(current):
                opts[key] = value
        try:
            widget.configure(**opts)
        except tk.TclError:
            pass


theme = _Theme()

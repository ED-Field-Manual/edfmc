"""
Widgets plugins use to build their settings tab.

Thin subclasses of the standard tkinter and ttk widgets, so a settings page a
plugin builds looks like the rest of the plugin window.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import Any

from theme import RAISED, SURFACE, TEXT


class Notebook(ttk.Notebook):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)
        self.grid(padx=10, pady=10, sticky=tk.NSEW)


class Frame(ttk.Frame):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)


class Label(tk.Label):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        kw.setdefault('background', SURFACE)
        kw.setdefault('foreground', TEXT)
        super().__init__(master, **kw)


class EntryMenu(ttk.Entry):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)


Entry = EntryMenu


class Button(ttk.Button):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)


class ColoredButton(tk.Button):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        kw.setdefault('background', RAISED)
        kw.setdefault('foreground', TEXT)
        super().__init__(master, **kw)


class Checkbutton(ttk.Checkbutton):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)


class Radiobutton(ttk.Radiobutton):
    def __init__(self, master: Any = None, **kw: Any) -> None:
        super().__init__(master, **kw)


class OptionMenu(ttk.OptionMenu):
    def __init__(self, master: Any, variable: Any, default: Any = None, *values: Any, **kw: Any) -> None:
        super().__init__(master, variable, default, *values, **kw)


class ScrollableNotebook(Notebook):
    pass

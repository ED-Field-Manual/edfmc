"""
A text box that suggests system names as you type.

Suggestions come from Spansh on a worker thread, a moment after typing pauses,
and appear in a list under the box. Up/Down move through them, Enter or Tab
takes one, Escape closes the list, and a click picks one. Typing anything is
always allowed: a suggestion is an offer, never a restriction.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from typing import Callable

from . import spansh
from .style import Fonts, Palette

#: Wait for typing to pause before asking, so one name is one request.
DEBOUNCE_MS = 300
MIN_CHARS = 3
ROWS = 8


class SuggestEntry:
    def __init__(self, parent: tk.Misc, variable: tk.StringVar, p: Palette, fonts: Fonts,
                 lookup: Callable[[str], list[str]] = spansh.suggest) -> None:
        self.var = variable
        self.p = p
        self.fonts = fonts
        self.lookup = lookup
        self.results: queue.Queue[tuple[str, list[str]]] = queue.Queue()
        self.cache: dict[str, list[str]] = {}
        self.pending: str | None = None
        self.debounce: str | None = None
        self.suppress = False
        self.popup: tk.Toplevel | None = None
        self.listbox: tk.Listbox | None = None

        self.entry = tk.Entry(parent, textvariable=variable, font=fonts.body)
        if p.surface is not None:
            self.entry.configure(relief=tk.FLAT, bd=0, bg=p.raised, fg=p.text,
                                 insertbackground=p.text, highlightthickness=1,
                                 highlightbackground=p.line, highlightcolor=p.accent,
                                 disabledbackground=p.surface, selectbackground=p.accent,
                                 selectforeground=p.on_accent)
        self.trace = variable.trace_add('write', lambda *_: self._typed())
        self.entry.bind('<Down>', lambda _e: self._move(1))
        self.entry.bind('<Up>', lambda _e: self._move(-1))
        self.entry.bind('<Return>', lambda _e: self._accept())
        self.entry.bind('<Tab>', lambda _e: self._accept(keep_focus=False))
        self.entry.bind('<Escape>', lambda _e: self.close())
        # Later than the click on the list, so picking with the mouse still works.
        self.entry.bind('<FocusOut>', lambda _e: self.entry.after(150, self.close))
        self.entry.bind('<Destroy>', lambda _e: self.close())

    def grid(self, **kw) -> None:
        self.entry.grid(**kw)

    def set(self, text: str) -> None:
        """Fill the box without offering suggestions for what was put there."""
        self.suppress = True
        self.var.set(text)
        self.suppress = False
        self.close()

    # -- asking ------------------------------------------------------------

    def _typed(self) -> None:
        if self.suppress:
            return
        if self.debounce is not None:
            self.entry.after_cancel(self.debounce)
        self.debounce = self.entry.after(DEBOUNCE_MS, self._ask)

    def _ask(self) -> None:
        self.debounce = None
        text = self.var.get().strip()
        if len(text) < MIN_CHARS:
            self.close()
            return
        key = text.lower()
        if key in self.cache:
            self._show(self.cache[key])
            return
        self.pending = key

        def work() -> None:
            try:
                names = self.lookup(text)
            except Exception:
                names = []
            self.results.put((key, names))

        threading.Thread(target=work, name='router-suggest', daemon=True).start()
        self.entry.after(100, self._collect)

    def _collect(self) -> None:
        try:
            key, names = self.results.get_nowait()
        except queue.Empty:
            if self.pending is not None:
                self.entry.after(100, self._collect)
            return
        self.cache[key] = names
        # Only show what answers the text still in the box; a slow reply to an
        # earlier keystroke is cached and dropped.
        if key == self.var.get().strip().lower():
            self.pending = None
            self._show(names)
        elif self.pending is not None:
            self.entry.after(100, self._collect)

    # -- the list ----------------------------------------------------------

    def _show(self, names: list[str]) -> None:
        typed = self.var.get().strip()
        # Nothing to offer when the box already holds exactly the one match.
        if names == [typed]:
            names = []
        if not names or self.entry.focus_get() is not self.entry:
            self.close()
            return
        if self.popup is None:
            self.popup = tk.Toplevel(self.entry)
            self.popup.overrideredirect(True)
            self.popup.attributes('-topmost', True)
            self.listbox = tk.Listbox(self.popup, activestyle='none', exportselection=False,
                                      font=self.fonts.body, bd=0, highlightthickness=1)
            if self.p.surface is not None:
                self.listbox.configure(bg=self.p.raised, fg=self.p.text, highlightbackground=self.p.line,
                                       selectbackground=self.p.accent, selectforeground=self.p.on_accent)
            self.listbox.pack(fill=tk.BOTH, expand=True)
            self.listbox.bind('<ButtonRelease-1>', lambda _e: self._accept())
        assert self.listbox is not None
        self.listbox.delete(0, tk.END)
        for n in names:
            self.listbox.insert(tk.END, n)
        self.listbox.configure(height=min(len(names), ROWS))
        self.entry.update_idletasks()
        x = self.entry.winfo_rootx()
        y = self.entry.winfo_rooty() + self.entry.winfo_height() + 2
        self.popup.geometry(f'{self.entry.winfo_width()}x{self.listbox.winfo_reqheight()}+{x}+{y}')
        self.popup.deiconify()
        self.popup.lift()

    def _move(self, delta: int) -> str:
        if self.listbox is None or self.popup is None:
            return 'break'
        size = self.listbox.size()
        current = self.listbox.curselection()
        i = (current[0] + delta) if current else (0 if delta > 0 else size - 1)
        i = max(0, min(size - 1, i))
        self.listbox.selection_clear(0, tk.END)
        self.listbox.selection_set(i)
        self.listbox.see(i)
        return 'break'

    def _accept(self, keep_focus: bool = True) -> str | None:
        if self.listbox is None or self.popup is None:
            return None
        current = self.listbox.curselection()
        if not current:
            self.close()
            return None
        self.set(self.listbox.get(current[0]))
        self.entry.icursor(tk.END)
        if keep_focus:
            self.entry.focus_set()
        return 'break' if keep_focus else None

    def close(self) -> None:
        if self.popup is not None:
            try:
                self.popup.destroy()
            except tk.TclError:
                pass
        self.popup = None
        self.listbox = None

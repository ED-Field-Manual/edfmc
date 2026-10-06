"""
How Router looks, in whichever app is hosting it.

In EDFM Companion the panel uses the app's own palette and type, so it reads as
part of the app. In EDMC the host's theme (default, dark or transparent) owns
the colours, so plain widgets are left for it to recolour and only the few
things a theme cannot know about (the progress bar, the neutron badge) take
their colours from it.
"""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont
from dataclasses import dataclass
from typing import Any

from . import bridge


@dataclass(frozen=True)
class Palette:
    #: None means "leave it to the host's theme".
    surface: str | None
    raised: str | None
    line: str | None
    text: str | None
    muted: str | None
    accent: str
    on_accent: str
    error: str
    track: str


#: EDFM Companion's palette (apps/desktop/src/App.css).
EDFMC = Palette(surface='#212121', raised='#2b2b2b', line='#353535', text='#ededed',
                muted='#9d9d9d', accent='#ff7d20', on_accent='#121212', error='#f0564c',
                track='#353535')


def _edmc_palette() -> Palette:
    """Colours from EDMC's active theme, for the parts its theme does not paint."""
    current: dict[str, Any] = {}
    try:
        from theme import theme  # type: ignore[import-not-found]
        current = dict(getattr(theme, 'current', None) or {})
    except Exception:
        pass
    highlight = current.get('highlight') or '#ff8000'
    return Palette(surface=None, raised=None, line=None, text=None, muted=None,
                   accent=highlight, on_accent='#000000', error='#d03030',
                   track=current.get('disabledforeground') or '#a0a0a0')


def palette() -> Palette:
    return EDFMC if bridge.available() else _edmc_palette()


class Fonts:
    """Type sizes relative to the host's default font, so EDMC's font choice holds."""

    def __init__(self, root: tk.Misc) -> None:
        base = tkfont.nametofont('TkDefaultFont', root=root)
        family = base.actual('family')
        size = abs(int(base.actual('size'))) or 9
        if bridge.available():
            family = 'Segoe UI'  # the app's UI face on Windows
            size = 10
        self.body = (family, size)
        self.small = (family, max(size - 1, 7))
        self.caption = (family, max(size - 2, 7), 'bold')
        self.title = (family, size + 6, 'bold')
        self.stat = (family, size + 1, 'bold')
        self.button = (family, size, 'bold')


def colour(widget: tk.Misc, **options: str | None) -> None:
    """Configure only the colours the palette actually sets."""
    widget.configure(**{k: v for k, v in options.items() if v is not None})


def button(parent: tk.Misc, text: str, command: Any, kind: str, p: Palette, fonts: Fonts) -> tk.Button:
    """A flat button. `kind` is primary (accent), secondary (outlined) or quiet (text only)."""
    b = tk.Button(parent, text=text, command=command, cursor='hand2', font=fonts.button,
                  padx=12, pady=4)
    if p.surface is None:
        # EDMC: its theme styles buttons; keep them tidy and leave colours alone.
        b.configure(padx=8, pady=2)
        return b
    if kind == 'primary':
        normal, hover, fg = p.accent, '#ff9445', p.on_accent
    elif kind == 'secondary':
        normal, hover, fg = p.raised, p.line, p.text
    else:
        normal, hover, fg = p.surface, p.raised, p.muted
    b.configure(relief=tk.FLAT, bd=0, highlightthickness=0, bg=normal, fg=fg,
                activebackground=hover, activeforeground=fg,
                disabledforeground=p.muted)
    b.bind('<Enter>', lambda _e: b.configure(bg=hover) if str(b['state']) != tk.DISABLED else None)
    b.bind('<Leave>', lambda _e: b.configure(bg=normal))
    return b


def label(parent: tk.Misc, text: str, p: Palette, font: Any, *, muted: bool = False, **kw: Any) -> tk.Label:
    l = tk.Label(parent, text=text, font=font, anchor=tk.W, justify=tk.LEFT, **kw)
    colour(l, bg=p.surface, fg=(p.muted if muted else p.text))
    return l


def frame(parent: tk.Misc, p: Palette, **kw: Any) -> tk.Frame:
    f = tk.Frame(parent, **kw)
    colour(f, bg=p.surface)
    return f

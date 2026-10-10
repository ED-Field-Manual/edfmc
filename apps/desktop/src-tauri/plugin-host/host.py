"""
Python plugin host for EDFM Companion.

Runs community Python plugins that were written for the de-facto standard
plugin interface used by Elite Dangerous companion tools: a folder holding a
`load.py` that defines `plugin_start3`, `journal_entry` and friends. The modules
those plugins import (`config`, `monitor`, `theme`, `myNotebook`, `l10n`, ...)
are provided by `compat/`, written for this app rather than copied.

Started by the desktop app (`src-tauri/src/plugin_host.rs`) as a separate
process, so a plugin that crashes or hangs cannot take the app down with it.

## How it talks to the app

- **stdout** carries one JSON object per line, and nothing else: plugin output
  is redirected to the log so a stray `print` cannot corrupt the protocol.
- **stdin** takes one JSON command per line: `show`, `settings`, `quit`.

## Where game data comes from

The host reads the journal folder itself, the same way plugins expect a host
to: on start it reads the newest journal to learn the current state without
replaying any of it to plugins, then delivers each new line as it is written.
`Status.json` is watched the same way and delivered as `dashboard_entry`.

The journal is only ever read. Nothing here writes to the game's folder.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import queue
import sys
import threading
import traceback
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'compat'))

def _dpi_aware() -> None:
    """Draw at the screen's real resolution.

    The plugin window is placed inside the app window, which is DPI aware. A
    DPI-unaware child would be bitmap-stretched and blurry on a scaled display,
    and its size would not match the space the app leaves for it.
    """
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor
    except (AttributeError, OSError):
        pass


_dpi_aware()

import tkinter as tk  # noqa: E402
from tkinter import ttk  # noqa: E402

import host_bridge  # noqa: E402
from config import config  # noqa: E402
from monitor import monitor  # noqa: E402
from theme import ACCENT, MUTED, SURFACE, TEXT, theme  # noqa: E402

POLL_MS = 250
COMMAND_MS = 30
# Shown in the app as plain text. Bounded so a huge file cannot flood the protocol.
MAX_README_CHARS = 64 * 1024

# The protocol channel. Captured before plugins load, then sys.stdout is
# pointed at the log so plugin prints cannot interleave with it.
_protocol = sys.stdout
_protocol_lock = threading.Lock()


def emit(message: dict[str, Any]) -> None:
    with _protocol_lock:
        try:
            _protocol.write(json.dumps(message) + '\n')
            _protocol.flush()
        except (OSError, ValueError):
            pass


def setup_logging() -> None:
    os.makedirs(config.app_dir_path, exist_ok=True)
    handler = logging.FileHandler(os.path.join(config.app_dir_path, 'plugin-host.log'), 'w', encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    class _ToLog:
        def __init__(self, level: int) -> None:
            self.level = level

        def write(self, text: str) -> None:
            text = text.rstrip()
            if text:
                logging.getLogger('plugin-output').log(self.level, text)

        def flush(self) -> None:
            pass

    sys.stdout = _ToLog(logging.INFO)  # type: ignore[assignment]
    sys.stderr = _ToLog(logging.WARNING)  # type: ignore[assignment]


log = logging.getLogger('host')


class Plugin:
    def __init__(self, folder: str, path: str) -> None:
        self.folder = folder
        self.path = path
        self.name = folder
        self.module: Any = None
        self.error: str | None = None
        self.frame: tk.Frame | None = None
        self.disabled = False

    def call(self, hook: str, *args: Any) -> Any:
        fn = getattr(self.module, hook, None) if self.module else None
        if not callable(fn):
            return None
        try:
            return fn(*args)
        except Exception:
            log.error('%s.%s failed:\n%s', self.folder, hook, traceback.format_exc())
            return None

    @property
    def native(self) -> bool:
        """Registered a page for the app to draw (edfmc.register_page)."""
        return self.folder in host_bridge.pages

    def has(self, hook: str) -> bool:
        return self.module is not None and callable(getattr(self.module, hook, None))

    def version(self) -> str | None:
        """What the plugin says its version is, or None. Never guessed."""
        v = getattr(self.module, 'plugin_version', None) or getattr(self.module, '__version__', None)
        if isinstance(v, str) and v.strip():
            return v.strip()
        # Some plugins keep it in a version.json beside load.py, as bare text.
        try:
            with open(os.path.join(self.path, 'version.json'), encoding='utf-8') as f:
                text = f.read(64).strip().strip('"')
            return text or None
        except OSError:
            return None

    def readme(self) -> str | None:
        for name in ('README.md', 'readme.md', 'README.txt', 'README'):
            try:
                with open(os.path.join(self.path, name), encoding='utf-8', errors='replace') as f:
                    return f.read(MAX_README_CHARS)
            except OSError:
                continue
        return None

    def git_remote(self) -> str | None:
        """The `origin` URL if the plugin was installed with `git clone`."""
        try:
            with open(os.path.join(self.path, '.git', 'config'), encoding='utf-8') as f:
                text = f.read(16 * 1024)
        except OSError:
            return None
        section = None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('['):
                section = line
            elif section == '[remote "origin"]' and line.startswith('url'):
                return line.split('=', 1)[1].strip()
        return None

    def describe(self) -> dict[str, Any]:
        return {
            'folder': self.folder,
            'name': self.name,
            'loaded': self.module is not None,
            'disabled': self.disabled,
            'error': self.error,
            'version': self.version(),
            'hasPanel': self.has('plugin_app') or self.native,
            # Drawn by the app from the state the plugin publishes, not by tkinter.
            'native': self.native,
            'hasSettings': self.has('plugin_prefs'),
            'readme': self.readme(),
            'gitRemote': self.git_remote(),
        }


def discover(plugin_dir: str) -> list[Plugin]:
    """Every folder holding a `load.py`, skipping hidden and `.disabled` ones."""
    found: list[Plugin] = []
    try:
        names = sorted(os.listdir(plugin_dir), key=str.lower)
    except OSError:
        return found
    for name in names:
        path = os.path.join(plugin_dir, name)
        if name.startswith(('.', '_')) or name.endswith('.disabled'):
            continue
        if os.path.isdir(path) and os.path.isfile(os.path.join(path, 'load.py')):
            found.append(Plugin(name, path))
    return found


def load(plugin: Plugin) -> None:
    safe = ''.join(c if c.isalnum() else '_' for c in plugin.folder)
    # A plugin's own folder goes on the path too: SpanshRouter's `load.py` does
    # `from SpanshRouter.SpanshRouter import ...`, which must find the package
    # *inside* its folder, not the folder itself.
    if plugin.path not in sys.path:
        sys.path.append(plugin.path)
    try:
        spec = importlib.util.spec_from_file_location(f'plugin_{safe}', os.path.join(plugin.path, 'load.py'))
        if spec is None or spec.loader is None:
            raise ImportError('load.py could not be read')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except Exception as exc:
        plugin.error = f'{type(exc).__name__}: {exc}'
        log.error('Could not load %s:\n%s', plugin.folder, traceback.format_exc())
        return

    start = getattr(module, 'plugin_start3', None)
    if not callable(start):
        plugin.error = 'No plugin_start3: written for an older, unsupported version of the interface.'
        return
    plugin.module = module
    host_bridge.loading = plugin.folder  # for edfmc.register_page
    try:
        name = start(plugin.path)
    except Exception as exc:
        host_bridge.loading = None
        host_bridge.pages.pop(plugin.folder, None)
        plugin.module = None
        plugin.error = f'Failed to start: {type(exc).__name__}: {exc}'
        log.error('%s.plugin_start3 failed:\n%s', plugin.folder, traceback.format_exc())
        return
    host_bridge.loading = None
    if isinstance(name, str) and name:
        plugin.name = name


class JournalTail:
    """Follows the newest journal file and Status.json."""

    def __init__(self, journal_dir: str) -> None:
        self.dir = journal_dir
        self.file: str | None = None
        self.offset = 0
        self.partial = b''
        self.status_mtime: float | None = None

    def newest(self) -> str | None:
        try:
            names = [n for n in os.listdir(self.dir) if n.startswith('Journal.') and n.endswith('.log')]
        except OSError:
            return None
        return os.path.join(self.dir, max(names)) if names else None

    def _read_new(self) -> list[dict[str, Any]]:
        if self.file is None:
            return []
        try:
            with open(self.file, 'rb') as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            return []
        self.offset += len(data)
        data = self.partial + data
        lines = data.split(b'\n')
        self.partial = lines.pop()  # incomplete until the game writes the newline
        entries = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and 'event' in entry:
                entries.append(entry)
        return entries

    def prime(self) -> None:
        """Learn the current state from the newest journal, delivering nothing."""
        self.file = self.newest()
        monitor.currentdir = self.dir
        monitor.state['JournalDir'] = self.dir
        if self.file:
            monitor.logfile = self.file
            for entry in self._read_new():
                monitor.fold(entry)
            monitor.state['JournalDir'] = self.dir

    def poll(self) -> list[dict[str, Any]]:
        out = self._read_new()
        newest = self.newest()
        if newest and newest != self.file:
            # Finish the old file first; the game may have written its last
            # lines just before starting the new one.
            self.file, self.offset, self.partial = newest, 0, b''
            monitor.logfile = newest
            out.extend(self._read_new())
        return out

    def status(self) -> dict[str, Any] | None:
        path = os.path.join(self.dir, 'Status.json')
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None
        if mtime == self.status_mtime:
            return None
        self.status_mtime = mtime
        try:
            with open(path, encoding='utf-8') as f:
                entry = json.load(f)
        except (OSError, ValueError):
            # Caught mid-write; the next change re-reads it.
            self.status_mtime = None
            return None
        return entry if isinstance(entry, dict) else None


class Panel:
    """One plugin's own window, shown inside the app on that plugin's tab."""

    def __init__(self, host: Host, plugin: Plugin) -> None:
        self.plugin = plugin
        self.top = tk.Toplevel(host.root)
        self.top.title(plugin.name)
        self.top.configure(background=SURFACE)
        self.top.protocol('WM_DELETE_WINDOW', self.top.withdraw)
        self.owned_by: int | None = None
        if host.embedded:
            # Undecorated and hidden until the app places it, so it never
            # flashes up as a window of its own.
            self.top.overrideredirect(True)
            self.top.withdraw()

        self.top.columnconfigure(0, weight=1)
        self.top.rowconfigure(0, weight=1)
        self.frame = tk.Frame(self.top, background=SURFACE)
        self.frame.grid(row=0, column=0, sticky=tk.NSEW, padx=8, pady=8)
        self.frame.columnconfigure(0, weight=1)
        self.frame.columnconfigure(1, weight=1)
        self.status = tk.StringVar(value='')
        tk.Label(self.top, textvariable=self.status, foreground=MUTED, background=SURFACE,
                 anchor=tk.W, justify=tk.LEFT).grid(row=1, column=0, sticky=tk.EW, padx=8, pady=(0, 6))
        plugin.frame = self.frame

        result = plugin.call('plugin_app', self.frame)
        # Either one widget spanning the row, or a (label, value) pair.
        try:
            if isinstance(result, tuple) and len(result) == 2:
                result[0].grid(row=0, column=0, sticky=tk.W)
                result[1].grid(row=0, column=1, sticky=tk.EW)
            elif isinstance(result, tk.Misc) and result.master is self.frame and not result.grid_info():
                result.grid(row=0, column=0, columnspan=2, sticky=tk.EW)
        except tk.TclError:
            log.error('%s returned a widget that could not be placed:\n%s', plugin.folder, traceback.format_exc())
        theme.apply(self.top)

    def place(self, owner: int, x: int, y: int, width: int, height: int, visible: bool) -> None:
        """Show this panel over its tab's free area. `x` and `y` are screen pixels.

        The panel stays a top-level window, owned by the app window, rather than
        becoming its child. As a child, Tk crashed (an access violation inside
        tk86t.dll) on the first click into it, because Tk's window handling
        assumes a Tk top-level's parent is the desktop or another Tk window.
        Owned, it is still kept above the app window and hidden with it when
        the app is minimised, and Tk's assumptions hold.

        Positioned through Tk's own geometry: Tk keeps its own idea of where its
        windows are and puts them back if moved from outside.
        """
        if not visible:
            self.top.withdraw()
            return
        if self.owned_by != owner:
            self.top.update_idletasks()
            set_owner(int(self.top.wm_frame(), 16), owner)
            self.owned_by = owner
        self.top.geometry(f'{max(width, 1)}x{max(height, 1)}+{x}+{y}')
        self.top.deiconify()
        self.top.lift()


def set_owner(window: int, owner: int) -> None:
    """Make another process's window the owner of this one (Windows)."""
    import ctypes
    from ctypes import wintypes as w

    user32 = ctypes.windll.user32
    user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
    user32.SetWindowLongPtrW.argtypes = [w.HWND, ctypes.c_int, ctypes.c_ssize_t]
    gwlp_hwndparent = -8  # for a top-level window this sets the owner
    user32.SetWindowLongPtrW(window, gwlp_hwndparent, owner)


class Responsive:
    """Keep the plugin windows responding while a plugin waits on its own thread.

    Plugins often block the one thread that draws them: SpanshRouter's Plot
    Route posts to Spansh and then polls with `sleep(1)` up to twenty times,
    all on the main thread. In a standalone window that freezes the plugin.
    Here the panels are owned by the app window, which shares their
    input with the app, so the whole app froze with it.

    So, on the main thread only, `time.sleep` and `requests` calls keep the
    windows responding while they wait. The sleep still lasts as long, and the
    request still returns the same response or raises the same error; the only
    difference is that the window is redrawn and answers clicks meanwhile.
    Journal delivery is held back until the plugin's wait is over, so a plugin
    is never handed a journal entry in the middle of its own work.
    """

    STEP = 0.02

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.main = threading.get_ident()
        self.depth = 0

    def _pump(self) -> None:
        self.depth += 1
        try:
            self.root.update()
        except tk.TclError:
            pass
        finally:
            self.depth -= 1

    @property
    def waiting(self) -> bool:
        return self.depth > 0

    def install(self) -> None:
        import time as _time

        real_sleep = _time.sleep
        responsive = self

        def sleep(seconds: float) -> None:
            if threading.get_ident() != responsive.main or seconds <= 0:
                real_sleep(seconds)
                return
            end = _time.monotonic() + seconds
            while True:
                left = end - _time.monotonic()
                if left <= 0:
                    return
                responsive._pump()
                real_sleep(min(responsive.STEP, max(left, 0)))

        _time.sleep = sleep

        try:
            import requests.sessions
        except ImportError:
            return
        real_request = requests.sessions.Session.request

        def request(session: Any, *args: Any, **kwargs: Any) -> Any:
            if threading.get_ident() != responsive.main:
                return real_request(session, *args, **kwargs)
            box: dict[str, Any] = {}

            def run() -> None:
                try:
                    box['value'] = real_request(session, *args, **kwargs)
                except BaseException as exc:  # handed back to the caller below
                    box['error'] = exc

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            while worker.is_alive():
                responsive._pump()
                worker.join(responsive.STEP)
            if 'error' in box:
                raise box['error']
            return box['value']

        requests.sessions.Session.request = request


class Host:
    def __init__(self) -> None:
        self.commands: queue.Queue[dict[str, Any]] = queue.Queue()
        self.plugins: list[Plugin] = []
        self.panels: dict[str, Panel] = {}
        self.tail = JournalTail(config.default_journal_dir_path)
        self.settings_window: tk.Toplevel | None = None
        self.stopping = False
        # Inside the app, each plugin's panel is shown on its own tab.
        self.embedded = os.environ.get('EDFMC_EMBED') == '1'

        # The root only anchors the panels and dialogs; it is never shown.
        self.root = tk.Tk()
        self.root.title('EDFM Companion Plugins')
        theme.initialize(self.root)
        self.root.withdraw()
        self.responsive = Responsive(self.root)

        host_bridge.set_status_handler(self._status_all)
        host_bridge.set_publish_handler(
            lambda topic, data, folder: emit({'type': 'publish', 'topic': topic, 'data': data, 'folder': folder}))
        host_bridge.set_page_handler(
            lambda folder, state: emit({'type': 'page', 'folder': folder, 'state': state}))
        host_bridge.set_overlay_handler(
            lambda folder, title, content, widget=None, description=None: emit(
                {'type': 'overlay', 'folder': folder, 'title': title, 'content': content,
                 'widget': widget, 'description': description}))

    def _status_all(self, message: str) -> None:
        for panel in self.panels.values():
            panel.status.set(message)

    # -- startup ---------------------------------------------------------

    def start(self) -> None:
        plugin_dir = config.plugin_dir_path
        os.makedirs(plugin_dir, exist_ok=True)
        # Plugins import each other, and their own packages, by folder name.
        if plugin_dir not in sys.path:
            sys.path.append(plugin_dir)

        # Before any plugin is imported, so `from time import sleep` in a
        # plugin picks up the responsive version.
        self.responsive.install()
        self.tail.prime()
        self.plugins = discover(plugin_dir)
        try:
            disabled = set(json.loads(os.environ.get('EDFMC_DISABLED_PLUGINS', '[]')))
        except ValueError:
            disabled = set()
        for plugin in self.plugins:
            if plugin.folder in disabled:
                # Listed, so its card still shows, but never imported: a
                # switched-off plugin runs no code at all.
                plugin.disabled = True
                log.info('%s: switched off', plugin.folder)
                continue
            load(plugin)
            log.info('%s: %s', plugin.folder, 'loaded' if plugin.module else plugin.error)

        for plugin in self.plugins:
            # A plugin with a native page is drawn by the app; it gets no panel.
            if plugin.has('plugin_app') and not plugin.native:
                self.panels[plugin.folder] = Panel(self, plugin)

        self.report()
        threading.Thread(target=self._read_commands, daemon=True).start()
        self.root.after(POLL_MS, self._tick)
        self.root.after(COMMAND_MS, self._poll_commands)

    def report(self) -> None:
        emit({'type': 'status', 'plugins': [p.describe() for p in self.plugins]})

    # -- the loop --------------------------------------------------------

    def _poll_commands(self) -> None:
        # Separate from the journal poll and faster, so a panel follows the
        # app's layout without visible lag.
        #
        # Each command is contained, and the next poll is always scheduled. A
        # failing command used to escape and end the loop for good: after the
        # Settings button hit a plugin error, no later command arrived, so a
        # panel stayed on screen over every other tab.
        try:
            while not self.stopping:
                try:
                    command = self.commands.get_nowait()
                except queue.Empty:
                    break
                try:
                    self._command(command)
                except Exception:
                    log.error('Command %r failed:\n%s', command.get('type'), traceback.format_exc())
        finally:
            if not self.stopping:
                self.root.after(COMMAND_MS, self._poll_commands)

    def _tick(self) -> None:
        if self.stopping:
            return
        if self.responsive.waiting:
            # A plugin is mid-wait further down the stack; deliver afterwards.
            self.root.after(POLL_MS, self._tick)
            return
        # Same rule as the command loop: one bad entry must not stop delivery.
        try:
            for entry in self.tail.poll():
                monitor.fold(entry)
                self._dispatch_journal(entry)

            status = self.tail.status()
            if status is not None:
                for plugin in self.plugins:
                    if plugin.has('dashboard_entry'):
                        plugin.call('dashboard_entry', monitor.cmdr, monitor.is_beta, status)
        except Exception:
            log.error('Journal delivery failed:\n%s', traceback.format_exc())
        finally:
            if not self.stopping:
                self.root.after(POLL_MS, self._tick)

    def _dispatch_journal(self, entry: dict[str, Any]) -> None:
        for plugin in self.plugins:
            if not plugin.has('journal_entry'):
                continue
            result = plugin.call('journal_entry', monitor.cmdr, monitor.is_beta, monitor.system,
                                 monitor.station, dict(entry), monitor.snapshot())
            # A returned string is the plugin reporting a problem to the user.
            if isinstance(result, str) and result and plugin.folder in self.panels:
                self.panels[plugin.folder].status.set(result)

    def _read_commands(self) -> None:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except ValueError:
                continue
            if isinstance(command, dict):
                self.commands.put(command)
        # The app went away without saying goodbye; don't outlive it.
        self.commands.put({'type': 'quit'})

    def _command(self, command: dict[str, Any]) -> None:
        kind = command.get('type')
        if kind == 'place':
            panel = self.panels.get(str(command.get('folder')))
            if panel is None:
                return
            try:
                panel.place(int(command.get('owner', 0)), int(command.get('x', 0)), int(command.get('y', 0)),
                            int(command.get('width', 1)), int(command.get('height', 1)),
                            bool(command.get('visible')))
            except Exception:
                log.error('Could not place %s:\n%s', panel.plugin.folder, traceback.format_exc())
        elif kind == 'show' and not self.embedded:
            for panel in self.panels.values():
                panel.top.deiconify()
        elif kind == 'action':
            folder = str(command.get('folder'))
            handler = host_bridge.pages.get(folder)
            args = command.get('args') if isinstance(command.get('args'), dict) else {}
            if handler is not None:
                try:
                    handler(str(command.get('action')), args)
                except Exception:
                    log.error('%s action %r failed:\n%s', folder, command.get('action'), traceback.format_exc())
        elif kind == 'settings':
            self.open_settings()
        elif kind == 'quit':
            self.quit()

    # -- settings --------------------------------------------------------

    def open_settings(self) -> None:
        if self.settings_window is not None and self.settings_window.winfo_exists():
            self.settings_window.lift()
            return
        with_prefs = [p for p in self.plugins if p.has('plugin_prefs')]
        win = tk.Toplevel(self.root)
        win.title('Plugin settings')
        win.configure(background=SURFACE)
        self.settings_window = win

        if not with_prefs:
            tk.Label(win, text='None of the running plugins has settings.', foreground=TEXT,
                     background=SURFACE).grid(padx=16, pady=16)
        else:
            import myNotebook as nb
            book = nb.Notebook(win)
            for plugin in with_prefs:
                # Plugins are handed the notebook itself and return the page
                # they built in it (ConstructionTracker does `nb.Frame(parent)`).
                # Handing them a page instead made the returned frame a child of
                # that page, which the notebook refuses to add as a tab.
                result = plugin.call('plugin_prefs', book, monitor.cmdr, monitor.is_beta)
                if isinstance(result, tk.Misc) and result.master is book:
                    book.add(result, text=plugin.name)
                elif isinstance(result, tk.Misc):
                    try:
                        page = nb.Frame(book)
                        result.grid(in_=page, sticky=tk.NSEW)
                        book.add(page, text=plugin.name)
                    except tk.TclError:
                        log.error('%s settings could not be shown:\n%s', plugin.folder, traceback.format_exc())

        def done() -> None:
            for plugin in self.plugins:
                if plugin.has('prefs_changed'):
                    plugin.call('prefs_changed', monitor.cmdr, monitor.is_beta)
            config.save()
            win.destroy()

        ttk.Button(win, text='OK', command=done).grid(padx=10, pady=(0, 10), sticky=tk.E)
        win.protocol('WM_DELETE_WINDOW', done)
        theme.apply(win)

    # -- shutdown --------------------------------------------------------

    def quit(self) -> None:
        if self.stopping:
            return
        self.stopping = True
        config.set_shutdown()
        for plugin in self.plugins:
            plugin.call('plugin_stop')
        config.save()
        emit({'type': 'stopped'})
        self.root.destroy()


def main() -> int:
    setup_logging()
    # A crash inside Tk itself (an access violation in tk86t.dll) leaves no
    # Python traceback in the log. faulthandler writes the Python stack of
    # every thread at the moment of the crash, which is what says which plugin
    # call led there.
    import faulthandler
    try:
        _crash_log = open(os.path.join(config.app_dir_path, 'plugin-host-crash.log'), 'a', encoding='utf-8')
        faulthandler.enable(_crash_log, all_threads=True)
    except OSError:
        pass
    if not config.default_journal_dir_path:
        emit({'type': 'error', 'message': 'No journal folder was given.'})
        return 2
    host = Host()
    try:
        host.start()
    except Exception:
        log.error('Host failed to start:\n%s', traceback.format_exc())
        emit({'type': 'error', 'message': 'The plugin host failed to start. See plugin-host.log.'})
        return 1
    host.root.mainloop()
    return 0


if __name__ == '__main__':
    sys.exit(main())

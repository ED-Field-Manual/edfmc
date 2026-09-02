import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import './overlay.css';

/**
 * Overlay root.
 *
 * Phase 2 deliberately ships the *engine* plus one trivial widget. Building eight
 * widgets against unproven positioning, DPI and click-through handling would just
 * mean rewriting eight widgets.
 *
 * State arrives by event from the main window, which owns the single journal
 * engine. Running a second engine here would double every event.
 */

interface OverlayState {
  commander: string | null;
  starSystem: string | null;
  station: string | null;
  body: string | null;
  docking: string | null;
  vehicle: string | null;
}

interface WidgetPosition {
  x: number;
  y: number;
}

const STORAGE_KEY = 'edfm.overlay.layout.v1';

function loadLayout(): WidgetPosition {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WidgetPosition>;
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { x: parsed.x, y: parsed.y };
      }
    }
  } catch {
    // Corrupt or unavailable storage must not stop the overlay rendering.
  }
  return { x: 32, y: 32 };
}

export default function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [editing, setEditing] = useState(false);
  const [pos, setPos] = useState<WidgetPosition>(loadLayout);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const subs = [
      listen<OverlayState>('overlay://state', (e) => setState(e.payload)),
      listen<boolean>('overlay://edit-mode', (e) => setEditing(e.payload)),
    ];
    return () => {
      void Promise.all(subs).then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  // Persist position whenever it settles.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch {
      // Layout persistence is a convenience, not a requirement.
    }
  }, [pos]);

  function onPointerDown(e: React.PointerEvent) {
    if (!editing) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    // Clamp so a widget cannot be dragged entirely off the game window and lost.
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy));
    setPos({ x, y });
  }

  function onPointerUp(e: React.PointerEvent) {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  return (
    <div className={`overlay-root${editing ? ' editing' : ''}`}>
      {editing && (
        <div className="edit-banner">
          Overlay edit mode — drag widgets to reposition. Close edit mode in Settings.
        </div>
      )}

      <div
        className="widget"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="widget-title">
          <span className="dot" aria-hidden="true">
            ◆
          </span>
          Current Context
        </div>

        {state === null ? (
          <div className="row muted">Waiting for journal state…</div>
        ) : (
          <>
            <Row label="CMDR" value={state.commander} />
            <Row label="System" value={state.starSystem} />
            <Row label="Body" value={state.body} />
            <Row label="Station" value={state.station} />
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      {/* Unknown stays visibly Unknown here too — the overlay must not imply
          knowledge the journal did not provide. */}
      <span className={value ? 'row-value' : 'row-value unknown'}>{value ?? 'Unknown'}</span>
    </div>
  );
}

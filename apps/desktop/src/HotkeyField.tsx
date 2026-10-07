/**
 * Choose, change or clear a global hotkey, the same way as the screenshot one.
 *
 * Nothing is bound until the commander picks a combination: Elite setups are
 * crowded, and claiming keys unasked could break something used in flight.
 */

import { useEffect, useState } from 'react';

import { bindingFromEvent, describeHotkey } from './lib/screenshots';

export function HotkeyField({
  label,
  hint,
  binding,
  onSet,
}: {
  label: string;
  hint: string;
  binding: string | null;
  /** Returns null when bound, or the reason it could not be. */
  onSet: (binding: string | null) => Promise<string | null>;
}) {
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    async function onKey(e: KeyboardEvent) {
      e.preventDefault();
      if (e.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const next = bindingFromEvent(e);
      if (next === null) return; // modifiers only so far
      setCapturing(false);
      setPending(next);
      setProblem(await onSet(next));
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, onSet]);

  return (
    <div className="field">
      <span>{label}</span>
      <div className="shot-hotkey">
        <code>{capturing ? 'Press a combination…' : describeHotkey(binding)}</code>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setProblem(null);
            setCapturing(true);
          }}
        >
          {binding ? 'Change' : 'Set'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!binding}
          onClick={() => {
            setPending(null);
            setProblem(null);
            void onSet(null);
          }}
        >
          Clear
        </button>
      </div>
      <span className="field-hint">{hint}</span>
      {problem && <p className="note">{problem}</p>}
      {!problem && pending && binding === pending && <p className="field-hint">Bound.</p>}
    </div>
  );
}

/**
 * Draws `ui-v1` content (see lib/pluginUi.ts) for any plugin, in the app's own
 * theme. Used for plugin pages in the main window and, display-only, for
 * plugin panels in the overlay.
 *
 * Input goes back to the plugin through `act`. Inputs commit on Enter or when
 * they lose focus, not on every keystroke: each commit is a message to the
 * plugin host, and a half-typed number is not a value anyone meant.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';

import type { UiBlock, UiCell, UiControl, UiRow, UiColumn } from './lib/pluginUi';

export type UiAct = (action: string, args?: Record<string, unknown>) => void;

export function PluginBlocks({ blocks, act, compact = false }: { blocks: readonly UiBlock[]; act?: UiAct; compact?: boolean }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} act={act} compact={compact} />
      ))}
    </>
  );
}

function Block({ block, act, compact }: { block: UiBlock; act: UiAct | undefined; compact: boolean }) {
  switch (block.type) {
    case 'heading':
      return <h3 className="pui-heading">{block.text}</h3>;
    case 'text':
      return <p className={`pui-text tone-${block.tone}`}>{block.text}</p>;
    case 'stats':
      return (
        <dl className="pui-stats">
          {block.items.map((s) => (
            <div key={s.label} className="pui-stat">
              <dt>{s.label}</dt>
              <dd>
                {s.value}
                {s.note && <span className="pui-note"> {s.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'progress':
      return (
        <div className="pui-progress">
          <div className="pui-progress-head">
            <span>{block.label}</span>
            <span>{block.text}</span>
          </div>
          <div
            className="pui-bar"
            role="progressbar"
            aria-label={block.label || 'Progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(block.value * 100)}
          >
            <div style={{ width: `${block.value * 100}%` }} />
          </div>
        </div>
      );
    case 'table':
      return <Table columns={block.columns} rows={block.rows} empty={block.empty} caption={block.caption} act={act} compact={compact} />;
    case 'controls':
      return act ? (
        <div className="pui-controls">
          {block.items.map((c, i) => (
            <Control key={`${c.type}-${c.label}-${i}`} control={c} act={act} />
          ))}
        </div>
      ) : null;
    case 'section':
      return compact ? (
        <div className="pui-section-compact">
          {block.title && <div className="pui-section-title">{block.title}</div>}
          <PluginBlocks blocks={block.blocks} act={act} compact />
        </div>
      ) : (
        <section className="card pui-section">
          {block.title && <h2>{block.title}</h2>}
          <PluginBlocks blocks={block.blocks} act={act} />
        </section>
      );
  }
}

function Table({
  columns, rows, empty, caption, act, compact,
}: {
  columns: readonly UiColumn[];
  rows: readonly UiRow[];
  empty: string | null;
  caption: string | null;
  act: UiAct | undefined;
  compact: boolean;
}) {
  if (rows.length === 0) return empty ? <p className="pui-text tone-muted">{empty}</p> : null;
  return (
    <div className={compact ? 'pui-table-wrap compact' : 'pui-table-wrap'}>
      <table className="pui-table">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === 'right' ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`tone-${r.tone}`}>
              {columns.map((c) => (
                <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                  <Cell cell={r.cells[c.key]} row={r.id} label={c.label} act={act} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ cell, row, label, act }: { cell: UiCell | undefined; row: string; label: string; act: UiAct | undefined }) {
  if (!cell) return null;
  if (cell.edit && act) {
    const edit = cell.edit;
    return (
      <CommitInput
        kind={edit.kind}
        value={edit.value}
        min={edit.min}
        max={edit.max}
        label={`${label} for ${row}`}
        className="pui-cell-input"
        onCommit={(value) => act(edit.action, { row, value })}
      />
    );
  }
  return (
    <span className={`tone-${cell.tone}`}>
      {cell.mark && <span className="pui-mark" aria-hidden="true">{cell.mark} </span>}
      {cell.text}
    </span>
  );
}

/** An input that tells the plugin only when the commander has finished typing. */
function CommitInput({
  kind, value, min, max, label, className, onCommit, step, placeholder,
}: {
  kind: 'number' | 'text';
  value: string | number;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  label: string;
  className?: string;
  placeholder?: string | null;
  onCommit: (value: string | number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // A new value from the plugin replaces what is shown, unless it is mid-edit.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    if (draft === String(value)) return;
    if (kind === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) {
        setDraft(String(value));
        return;
      }
      const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      onCommit(clamped);
    } else {
      onCommit(draft);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setDraft(String(value));
      setEditing(false);
    }
  };
  return (
    <input
      className={className}
      type={kind === 'number' ? 'number' : 'text'}
      aria-label={label}
      value={draft}
      min={min ?? undefined}
      max={max ?? undefined}
      step={step ?? undefined}
      placeholder={placeholder ?? undefined}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

function Control({ control, act }: { control: UiControl; act: UiAct }) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  switch (control.type) {
    case 'button':
      if (confirming && control.confirm) {
        return (
          <span className="pui-confirm" role="group" aria-label={control.label}>
            <span>{control.confirm}</span>
            <button
              type="button"
              className="primary pui-danger"
              onClick={() => {
                setConfirming(false);
                act(control.action, control.args);
              }}
            >
              Yes, {control.label.toLowerCase()}
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        );
      }
      return (
        <button
          type="button"
          className={control.primary ? 'primary' : 'secondary'}
          disabled={control.disabled}
          onClick={() => (control.confirm ? setConfirming(true) : act(control.action, control.args))}
        >
          {control.label}
        </button>
      );
    case 'select':
      return (
        <label className="pui-field">
          <span>{control.label}</span>
          <select value={control.value} onChange={(e) => act(control.action, { value: e.target.value })}>
            {control.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'toggle':
      return (
        <label className="check pui-toggle">
          <input type="checkbox" checked={control.value} onChange={(e) => act(control.action, { value: e.target.checked })} />
          <span>{control.label}</span>
        </label>
      );
    case 'number':
      return (
        <label className="pui-field">
          <span>{control.label}</span>
          <span className="pui-number">
            <CommitInput
              kind="number"
              value={control.value}
              min={control.min}
              max={control.max}
              step={control.step}
              label={control.label}
              onCommit={(value) => act(control.action, { value })}
            />
            {control.suffix && <span className="pui-suffix">{control.suffix}</span>}
          </span>
        </label>
      );
    case 'text':
      return (
        <label className="pui-field">
          <span>{control.label}</span>
          <CommitInput
            kind="text"
            value={control.value}
            label={control.label}
            placeholder={control.placeholder}
            onCommit={(value) => act(control.action, { value })}
          />
        </label>
      );
    case 'copy':
      return (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void navigator.clipboard
              .writeText(control.text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? 'Copied' : control.label}
        </button>
      );
  }
}

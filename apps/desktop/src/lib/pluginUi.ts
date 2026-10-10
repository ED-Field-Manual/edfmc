/**
 * `ui-v1`: page and overlay content any plugin can describe as JSON.
 *
 * A plugin's tab used to need code in the app written for that plugin
 * (Router's page is ~1,200 lines here). `ui-v1` is instead a small, fixed
 * vocabulary -- headings, text, stats, a progress bar, tables, buttons and a few
 * inputs -- that the app draws for any plugin in its own theme. The plugin
 * decides what to say; the app decides how it looks. Nothing in it knows what
 * the plugin is about.
 *
 * Everything arrives from a plugin, so this is the only door: every field is
 * checked, every list and string is capped, and anything unrecognised is
 * dropped rather than guessed at. The renderer (`PluginUi.tsx`) only ever sees
 * the cleaned result.
 *
 * Input goes back to the plugin as `{action, args}`, exactly as Router's does.
 * There is no way to run code, load a URL or reach the file system from here:
 * the one side effect the app performs itself is copying text the plugin gave.
 */

export type Tone = 'normal' | 'muted' | 'ok' | 'warn' | 'bad';

export interface UiCell {
  readonly text: string;
  readonly tone: Tone;
  /** A symbol shown before the text, so status never relies on colour alone. */
  readonly mark: string | null;
  /** Editable in place: the new value goes back as `action` with `{row, value}`. */
  readonly edit: { readonly action: string; readonly kind: 'number' | 'text'; readonly value: string | number; readonly min: number | null; readonly max: number | null } | null;
}

export interface UiColumn {
  readonly key: string;
  readonly label: string;
  readonly align: 'left' | 'right';
}

export interface UiRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, UiCell>>;
  readonly tone: Tone;
}

export type UiControl =
  | { readonly type: 'button'; readonly label: string; readonly action: string; readonly args: Record<string, unknown>; readonly confirm: string | null; readonly primary: boolean; readonly disabled: boolean }
  | { readonly type: 'select'; readonly label: string; readonly action: string; readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[] }
  | { readonly type: 'toggle'; readonly label: string; readonly action: string; readonly value: boolean }
  | { readonly type: 'number'; readonly label: string; readonly action: string; readonly value: number; readonly min: number | null; readonly max: number | null; readonly step: number | null; readonly suffix: string | null }
  | { readonly type: 'text'; readonly label: string; readonly action: string; readonly value: string; readonly placeholder: string | null }
  | { readonly type: 'copy'; readonly label: string; readonly text: string };

export type UiBlock =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'text'; readonly text: string; readonly tone: Tone }
  | { readonly type: 'stats'; readonly items: readonly { readonly label: string; readonly value: string; readonly note: string | null }[] }
  | { readonly type: 'progress'; readonly label: string; readonly value: number; readonly text: string }
  | { readonly type: 'table'; readonly columns: readonly UiColumn[]; readonly rows: readonly UiRow[]; readonly empty: string | null; readonly caption: string | null }
  | { readonly type: 'controls'; readonly items: readonly UiControl[] }
  | { readonly type: 'section'; readonly title: string; readonly blocks: readonly UiBlock[] };

export interface UiPage {
  readonly title: string | null;
  readonly blocks: readonly UiBlock[];
}

/** Bounds: a plugin cannot make the app draw an unbounded page. */
export const UI_LIMITS = {
  blocks: 60,
  depth: 3,
  rows: 300,
  columns: 12,
  controls: 16,
  options: 100,
  stats: 16,
  text: 2000,
  label: 200,
  copy: 100_000,
  /** The overlay is drawn over a game: fewer, shorter things. */
  overlayBlocks: 12,
  overlayRows: 14,
} as const;

const TONES: readonly Tone[] = ['normal', 'muted', 'ok', 'warn', 'bad'];
const ACTION = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown, max: number = UI_LIMITS.label): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.slice(0, max) : null;
};
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tone = (v: unknown): Tone => (TONES.includes(v as Tone) ? (v as Tone) : 'normal');
const action = (v: unknown): string | null => (typeof v === 'string' && ACTION.test(v) ? v : null);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** Plain JSON values only, a little of them: arguments the plugin gets back. */
function args(v: unknown): Record<string, unknown> {
  const o = obj(v);
  if (o === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(o).slice(0, 16)) {
    if (typeof value === 'string') out[k] = value.slice(0, UI_LIMITS.label);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || value === null) out[k] = value;
  }
  return out;
}

function cell(v: unknown): UiCell | null {
  if (v === null || v === undefined) return { text: '', tone: 'normal', mark: null, edit: null };
  const plain = text(v);
  if (plain !== null) return { text: plain, tone: 'normal', mark: null, edit: null };
  const o = obj(v);
  if (o === null) return null;
  const e = obj(o['edit']);
  let edit: UiCell['edit'] = null;
  if (e !== null) {
    const a = action(e['action']);
    const kind = e['kind'] === 'text' ? 'text' : e['kind'] === 'number' ? 'number' : null;
    const value = kind === 'number' ? finite(e['value']) : text(e['value']);
    if (a !== null && kind !== null && value !== null) {
      edit = { action: a, kind, value, min: finite(e['min']), max: finite(e['max']) };
    }
  }
  return {
    text: text(o['text']) ?? '',
    tone: tone(o['tone']),
    mark: text(o['mark'], 4),
    edit,
  };
}

function control(v: unknown): UiControl | null {
  const o = obj(v);
  if (o === null) return null;
  const label = text(o['label']) ?? '';
  if (o['type'] === 'copy') {
    const t = text(o['text'], UI_LIMITS.copy);
    return t === null ? null : { type: 'copy', label: label || 'Copy', text: t };
  }
  const a = action(o['action']);
  if (a === null) return null;
  switch (o['type']) {
    case 'button':
      return {
        type: 'button', label, action: a, args: args(o['args']),
        confirm: text(o['confirm'], UI_LIMITS.text), primary: o['primary'] === true, disabled: o['disabled'] === true,
      };
    case 'select': {
      const options = list(o['options'], UI_LIMITS.options)
        .map((x) => {
          const p = obj(x);
          const value = p ? text(p['value']) : null;
          return p && value !== null ? { value, label: text(p['label']) ?? value } : null;
        })
        .filter((x): x is { value: string; label: string } => x !== null);
      return { type: 'select', label, action: a, value: text(o['value']) ?? '', options };
    }
    case 'toggle':
      return { type: 'toggle', label, action: a, value: o['value'] === true };
    case 'number':
      return {
        type: 'number', label, action: a, value: finite(o['value']) ?? 0,
        min: finite(o['min']), max: finite(o['max']), step: finite(o['step']), suffix: text(o['suffix'], 20),
      };
    case 'text':
      return { type: 'text', label, action: a, value: text(o['value']) ?? '', placeholder: text(o['placeholder']) };
    default:
      return null;
  }
}

function block(v: unknown, depth: number, rowLimit: number): UiBlock | null {
  const o = obj(v);
  if (o === null) return null;
  switch (o['type']) {
    case 'heading': {
      const t = text(o['text']);
      return t ? { type: 'heading', text: t } : null;
    }
    case 'text': {
      const t = text(o['text'], UI_LIMITS.text);
      return t ? { type: 'text', text: t, tone: tone(o['tone']) } : null;
    }
    case 'stats': {
      const items = list(o['items'], UI_LIMITS.stats)
        .map((x) => {
          const s = obj(x);
          const label = s ? text(s['label']) : null;
          return s && label ? { label, value: text(s['value']) ?? '', note: text(s['note']) } : null;
        })
        .filter((x): x is { label: string; value: string; note: string | null } => x !== null);
      return items.length ? { type: 'stats', items } : null;
    }
    case 'progress': {
      const value = finite(o['value']);
      if (value === null) return null;
      const clamped = Math.max(0, Math.min(1, value));
      return {
        type: 'progress', label: text(o['label']) ?? '', value: clamped,
        // The percentage in words is always there, so progress never relies on the bar alone.
        text: text(o['text']) ?? `${Math.round(clamped * 100)}%`,
      };
    }
    case 'table': {
      const columns = list(o['columns'], UI_LIMITS.columns)
        .map((x) => {
          const c = obj(x);
          const key = c ? text(c['key'], 64) : null;
          return c && key ? { key, label: text(c['label']) ?? key, align: c['align'] === 'right' ? 'right' as const : 'left' as const } : null;
        })
        .filter((x): x is UiColumn => x !== null);
      if (columns.length === 0) return null;
      const rows: UiRow[] = [];
      for (const [i, x] of list(o['rows'], rowLimit).entries()) {
        const r = obj(x);
        const cellsIn = r ? obj(r['cells']) : null;
        if (r === null || cellsIn === null) continue;
        const cells: Record<string, UiCell> = {};
        for (const c of columns) {
          const value = cell(cellsIn[c.key]);
          if (value !== null) cells[c.key] = value;
        }
        rows.push({ id: text(r['id'], 100) ?? String(i), cells, tone: tone(r['tone']) });
      }
      return { type: 'table', columns, rows, empty: text(o['empty']), caption: text(o['caption']) };
    }
    case 'controls': {
      const items = list(o['items'], UI_LIMITS.controls)
        .map(control)
        .filter((x): x is UiControl => x !== null);
      return items.length ? { type: 'controls', items } : null;
    }
    case 'section': {
      if (depth >= UI_LIMITS.depth) return null;
      const blocks = blocksOf(o['blocks'], depth + 1, UI_LIMITS.blocks, rowLimit);
      return { type: 'section', title: text(o['title']) ?? '', blocks };
    }
    default:
      return null;
  }
}

function blocksOf(v: unknown, depth: number, max: number, rowLimit: number): UiBlock[] {
  return list(v, max)
    .map((b) => block(b, depth, rowLimit))
    .filter((b): b is UiBlock => b !== null);
}

/** A plugin's page, cleaned; null when it is not a `ui-v1` page. */
export function readUiPage(state: unknown): UiPage | null {
  const o = obj(state);
  if (o === null || o['kind'] !== 'ui-v1') return null;
  return { title: text(o['title']), blocks: blocksOf(o['blocks'], 0, UI_LIMITS.blocks, UI_LIMITS.rows) };
}

/**
 * An overlay panel, cleaned. Display only: inputs are dropped, because the
 * overlay is click-through while playing and a control there could never be used.
 */
export function readUiOverlay(content: unknown): readonly UiBlock[] | null {
  const o = obj(content);
  if (o === null) return null;
  const strip = (b: UiBlock): UiBlock | null => {
    if (b.type === 'controls') return null;
    if (b.type === 'section') {
      return { ...b, blocks: b.blocks.map(strip).filter((x): x is UiBlock => x !== null) };
    }
    if (b.type === 'table') {
      return { ...b, rows: b.rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).map(([k, c]) => [k, { ...c, edit: null }])) })) };
    }
    return b;
  };
  return blocksOf(o['blocks'], 1, UI_LIMITS.overlayBlocks, UI_LIMITS.overlayRows)
    .map(strip)
    .filter((b): b is UiBlock => b !== null);
}

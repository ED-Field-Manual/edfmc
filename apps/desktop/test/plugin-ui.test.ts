/**
 * Plugin pages and overlay panels described as data (`ui-v1`), and their
 * lifecycle: a panel exists only while its plugin runs and is switched on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { readUiOverlay, readUiPage, UI_LIMITS } from '../src/lib/pluginUi';
import { PythonPlugins } from '../src/lib/pythonPlugins';
import { Companion } from '../src/lib/companion';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('ui-v1 pages', () => {
  it('keeps what it understands and drops the rest', () => {
    const page = readUiPage({
      kind: 'ui-v1',
      blocks: [
        { type: 'heading', text: 'Materials' },
        { type: 'script', src: 'https://evil.example/x.js' },
        { type: 'progress', label: 'Progress', value: 7 },
        {
          type: 'table',
          columns: [{ key: 'm', label: 'Material' }, { key: 'n', label: 'Left', align: 'right' }, { nope: 1 }],
          rows: [{ id: 'steel', cells: { m: { text: 'Steel', mark: '✓', tone: 'ok' }, n: { text: '5', edit: { action: 'set', kind: 'number', value: 5 } } } }],
        },
        {
          type: 'controls',
          items: [
            { type: 'button', label: 'Go', action: 'go', args: { id: 'x', deep: { no: true } } },
            { type: 'button', label: 'Bad', action: 'javascript:alert(1)' },
            { type: 'link', label: 'Out', href: 'https://example.com' },
            { type: 'copy', label: 'Copy', text: 'Steel: 4,000 t' },
          ],
        },
      ],
    })!;
    expect(page.blocks.map((b) => b.type)).toEqual(['heading', 'progress', 'table', 'controls']);
    const progress = page.blocks[1] as { value: number; text: string };
    expect(progress).toMatchObject({ value: 1, text: '100%' }); // clamped, and always in words
    const table = page.blocks[2] as { columns: unknown[]; rows: Array<{ cells: Record<string, { edit: unknown; mark: string }> }> };
    expect(table.columns).toHaveLength(2);
    expect(table.rows[0]!.cells['m']!.mark).toBe('✓');
    expect(table.rows[0]!.cells['n']!.edit).toMatchObject({ action: 'set', kind: 'number', value: 5 });
    const controls = (page.blocks[3] as { items: Array<{ type: string; args?: unknown }> }).items;
    expect(controls.map((c) => c.type)).toEqual(['button', 'copy']);
    expect(controls[0]!.args).toEqual({ id: 'x' }); // plain values only
  });

  it('is bounded however much a plugin sends', () => {
    const page = readUiPage({
      kind: 'ui-v1',
      blocks: Array.from({ length: 500 }, () => ({ type: 'text', text: 'x'.repeat(10_000) })),
    })!;
    expect(page.blocks).toHaveLength(UI_LIMITS.blocks);
    expect((page.blocks[0] as { text: string }).text).toHaveLength(UI_LIMITS.text);
    expect(readUiPage({ kind: 'router-v1' })).toBeNull();
    expect(readUiPage('nonsense')).toBeNull();
  });

  it('overlay panels are display only', () => {
    const blocks = readUiOverlay({
      blocks: [
        { type: 'controls', items: [{ type: 'button', label: 'Go', action: 'go' }] },
        { type: 'table', columns: [{ key: 'n', label: 'N' }], rows: Array.from({ length: 40 }, (_, i) => ({ id: String(i), cells: { n: { text: '1', edit: { action: 'set', kind: 'number', value: 1 } } } })) },
      ],
    })!;
    expect(blocks.map((b) => b.type)).toEqual(['table']);
    const rows = (blocks[0] as { rows: Array<{ cells: Record<string, { edit: unknown }> }> }).rows;
    expect(rows).toHaveLength(UI_LIMITS.overlayRows);
    expect(rows.every((r) => r.cells['n']!.edit === null)).toBe(true);
  });
});

describe('plugin overlay panels', () => {
  type Msg = Record<string, unknown>;
  const host = () => {
    const p = new PythonPlugins({ getSetting: async () => null, setSetting: async () => undefined, changed: () => {} });
    const internals = p as unknown as { pid: number | null; onMessage: (m: Msg) => void; plugins: unknown[]; stop: () => Promise<void> };
    internals.pid = 7;
    return { p, internals };
  };

  it('arrive checked, and go when the host stops (a plugin switched off keeps nothing)', async () => {
    const { p, internals } = host();
    internals.onMessage({ pid: 7, type: 'overlay', folder: 'ConstructionLogistics', title: 'Construction', content: null });
    expect(p.view().overlays['ConstructionLogistics']).toEqual({ title: 'Construction', blocks: null });
    internals.onMessage({ pid: 7, type: 'overlay', folder: 'ConstructionLogistics', title: 'Construction', content: { blocks: [{ type: 'heading', text: 'Hauling' }] } });
    expect(p.view().overlays['ConstructionLogistics']!.blocks).toEqual([{ type: 'heading', text: 'Hauling' }]);
    internals.onMessage({ pid: 7, type: 'page', folder: 'ConstructionLogistics', state: { kind: 'ui-v1', blocks: [] } });

    await internals.stop();
    expect(p.view().overlays).toEqual({});
    expect(p.view().pages).toEqual({});
  });

  it('reach the overlay only for a running, enabled plugin with its switch on', () => {
    const c = new Companion() as unknown as {
      pythonPlugins: PythonPlugins;
      widgets: { pluginPanelsOff?: string[] };
      overlayPluginPanels: () => Array<{ id: string; title: string }>;
    };
    const internals = c.pythonPlugins as unknown as { pid: number | null; onMessage: (m: Msg) => void; plugins: unknown[] };
    internals.pid = 7;
    internals.onMessage({ pid: 7, type: 'overlay', folder: 'CL', title: 'Construction', content: { blocks: [{ type: 'text', text: 'x' }] } });

    internals.plugins = [{ folder: 'CL', name: 'Construction Logistics', loaded: true, disabled: false }];
    expect(c.overlayPluginPanels().map((x) => x.id)).toEqual(['plugin:CL']);

    c.widgets = { ...c.widgets, pluginPanelsOff: ['CL'] };
    expect(c.overlayPluginPanels()).toEqual([]);

    c.widgets = { ...c.widgets, pluginPanelsOff: [] };
    internals.plugins = [{ folder: 'CL', name: 'Construction Logistics', loaded: false, disabled: true }];
    expect(c.overlayPluginPanels()).toEqual([]);

    // Not installed at all: nothing, and nothing else breaks.
    internals.plugins = [];
    expect(c.overlayPluginPanels()).toEqual([]);
    expect((c as unknown as Companion).snapshot().pythonPlugins.plugins).toEqual([]);
  });
});

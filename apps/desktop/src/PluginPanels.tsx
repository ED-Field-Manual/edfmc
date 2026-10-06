/**
 * A Python plugin's own tab: its panel, inside the app.
 *
 * Plugins draw with tkinter, real native widgets that a web page cannot
 * contain. So this tab leaves an empty area and reports where it is, and the
 * host moves that plugin's window over it as a child of the app window
 * (`plugin_panel_place` in `plugin_host.rs`, `Panel.place` in `host.py`).
 * Leaving the tab hides it again.
 *
 * The consequence to know about: nothing drawn by the page can sit on top of
 * that area. A dialog opened while this tab shows would be hidden behind the
 * panel, which is why this tab holds nothing else.
 */

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';

import type { CompanionSnapshot } from './lib/companion';
import { companion } from './lib/companion';

function place(folder: string, el: HTMLElement | null): void {
  const hidden = { folder, x: 0, y: 0, width: 1, height: 1, visible: false };
  if (!el) {
    void invoke('plugin_panel_place', hidden).catch(() => {});
    return;
  }
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  void invoke('plugin_panel_place', {
    folder,
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
    visible: r.width > 0 && r.height > 0,
  }).catch(() => {});
}

export function PluginPanel({ snap, folder }: { snap: CompanionSnapshot; folder: string }) {
  const area = useRef<HTMLDivElement>(null);
  const py = snap.pythonPlugins;
  const plugin = py.plugins.find((p) => p.folder === folder);
  const showing = py.running && plugin !== undefined && plugin.loaded && plugin.hasPanel;

  useEffect(() => {
    if (!showing) return;
    const el = area.current;
    const update = () => place(folder, el);
    update();
    // The host may still be starting when the tab opens; ask again shortly.
    const retry = window.setInterval(update, 1000);
    const observer = new ResizeObserver(update);
    if (el) observer.observe(el);
    window.addEventListener('resize', update);
    const main = el?.closest('.main');
    main?.addEventListener('scroll', update);
    return () => {
      window.clearInterval(retry);
      observer.disconnect();
      window.removeEventListener('resize', update);
      main?.removeEventListener('scroll', update);
      place(folder, null);
    };
  }, [showing, folder]);

  return (
    <div className="plugin-panels">
      <header className="page-head row spread">
        <div>
          <h1>{plugin?.name ?? folder}</h1>
          <p className="muted">
            {plugin?.version ? `${plugin.version} · ` : ''}Python plugin
            {!py.running && ' · not running. Restart plugins from the Plugins page.'}
          </p>
        </div>
        {plugin?.hasSettings && py.running && (
          <button type="button" onClick={() => void companion.openPythonPluginSettings()}>
            Settings
          </button>
        )}
      </header>
      {showing && <div ref={area} className="plugin-panels-area" />}
    </div>
  );
}

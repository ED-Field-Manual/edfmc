/**
 * The Plugin panels tab: Python plugins' own panels, inside the app.
 *
 * Plugins draw with tkinter, real native widgets that a web page cannot
 * contain. So this tab leaves an empty area, reports where it is, and the
 * plugin window is moved over it as a child of the app window
 * (`plugin_panel_place` in `plugin_host.rs`). Leaving the tab hides it again.
 *
 * The consequence to know about: nothing drawn by the page can sit on top of
 * that area. A dialog opened while this tab shows would be hidden behind the
 * panels, which is why this tab holds nothing else.
 */

import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';

import type { CompanionSnapshot } from './lib/companion';

function place(el: HTMLElement | null, visible: boolean): void {
  if (!el || !visible) {
    void invoke('plugin_panel_place', { x: 0, y: 0, width: 1, height: 1, visible: false }).catch(
      () => {},
    );
    return;
  }
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  void invoke('plugin_panel_place', {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
    visible: r.width > 0 && r.height > 0,
  }).catch(() => {});
}

export function PluginPanels({ snap }: { snap: CompanionSnapshot }) {
  const area = useRef<HTMLDivElement>(null);
  const py = snap.pythonPlugins;
  const withPanels = py.plugins.filter((p) => p.loaded && p.hasPanel);
  const showing = py.running;

  useEffect(() => {
    if (!showing) return;
    const el = area.current;
    const update = () => place(el, true);
    update();
    // The host may still be starting; its window appears a moment later.
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
      place(null, false);
    };
  }, [showing]);

  return (
    <div className="plugin-panels">
      <header className="page-head">
        <h1>Plugin panels</h1>
        <p className="muted">
          {!py.enabled
            ? 'Python plugins are off. Turn them on from the Plugins page.'
            : !py.running
              ? 'Python plugins are not running. Restart them from the Plugins page.'
              : withPanels.length === 0
                ? 'None of the running plugins adds a panel.'
                : withPanels.map((p) => p.name).join(' · ')}
        </p>
      </header>
      {showing && <div ref={area} className="plugin-panels-area" />}
    </div>
  );
}

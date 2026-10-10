/**
 * @vitest-environment jsdom
 *
 * The Frontier entry on the Connections screen. The login itself is Rust
 * (src-tauri/src/frontier.rs, with its own tests); this checks what the
 * commander sees, and that nothing on this side ever holds a token.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { FrontierCard } from '../src/Integrations';
import { failureText } from '../src/lib/frontier';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  invoke.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const status = (over: object) => ({ configured: true, reason: null, connected: false, connecting: false, ...over });

async function render(statusValue: object, connect: () => Promise<unknown> = async () => undefined) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'frontier_status') return statusValue;
    if (cmd === 'frontier_connect') return connect();
    return undefined;
  });
  await act(async () => root.render(<FrontierCard />));
}
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);

describe('Frontier on the Connections screen', () => {
  it('before approval: says so, and Connect is disabled', async () => {
    await render(status({ configured: false, reason: 'Awaiting Frontier API Approval' }));
    expect(host.textContent).toContain('Awaiting Frontier API Approval');
    expect(button('Connect')?.disabled).toBe(true);
    expect(button('Disconnect')).toBeUndefined();
  });

  it('configured: Connect starts the login, and a failure is shown in words', async () => {
    await render(status({}), async () => {
      throw 'denied';
    });
    expect(button('Connect')?.disabled).toBe(false);
    await act(async () => button('Connect')!.click());
    expect(invoke).toHaveBeenCalledWith('frontier_connect');
    expect(host.textContent).toContain('Frontier did not grant access.');
  });

  it('connected: offers Disconnect, which clears the login', async () => {
    await render(status({ connected: true }));
    expect(host.textContent).toContain('Connected');
    await act(async () => button('Disconnect')!.click());
    expect(invoke).toHaveBeenCalledWith('frontier_disconnect');
  });

  it('while logging in: Cancel is offered', async () => {
    await render(status({ connecting: true }));
    expect(button('Connect')?.disabled).toBe(true);
    await act(async () => button('Cancel')!.click());
    expect(invoke).toHaveBeenCalledWith('frontier_cancel');
  });

  it('failures are known categories, never server text', () => {
    expect(failureText('invalid-grant')).toBe('Frontier no longer accepts this login. Connect again.');
    expect(failureText('<html>a token-looking thing</html>')).toBe('The Frontier login failed.');
    expect(failureText(new Error('x'))).toBe('The Frontier login failed.');
  });

  it('no command on this side can return a token', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'frontier.ts'), 'utf8');
    expect(source).not.toMatch(/token\s*[:(]/i);
    expect([...source.matchAll(/invoke<([^>]+)>/g)].map((m) => m[1])).toEqual(['FrontierStatus', 'void', 'void', 'void']);
  });
});

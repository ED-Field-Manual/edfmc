import { describe, expect, it } from 'vitest';
import { loadPlugins, mergeContextRules, namespaced, validatePlugin } from '../src/validate.js';
import type { ContextRuleSet } from '@edfm/context';

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: 'A context',
  when: { kind: 'event', name: 'Docked' },
  priority: 10,
  ttlSeconds: 300,
  resources: [{ label: 'Guide', page: 'Some Page' }],
  ...over,
});

const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: 'com.example.test',
  name: 'Test Plugin',
  version: '1.0.0',
  author: 'CMDR Someone',
  contributes: { contextRules: [rule('my-rule')] },
  ...over,
});

const raw = (m: unknown, directory = 'test-plugin') => ({
  directory,
  json: typeof m === 'string' ? m : JSON.stringify(m),
});

describe('validatePlugin', () => {
  it('loads a well-formed plugin', () => {
    const result = validatePlugin(raw(manifest()));
    expect('problems' in result).toBe(false);
    if ('problems' in result) return;
    expect(result.manifest.name).toBe('Test Plugin');
    expect(result.contextRules).toHaveLength(1);
  });

  it('namespaces contributed rule ids', () => {
    // Without this a plugin could shadow or collide with a built-in rule, and
    // sanitise's duplicate-id rejection would silently drop one of them.
    const result = validatePlugin(raw(manifest()));
    if ('problems' in result) throw new Error('should have loaded');
    expect(result.contextRules[0]!.id).toBe('com.example.test/my-rule');
    expect(namespaced('a.b', 'c')).toBe('a.b/c');
  });

  it('refuses a manifest that is not JSON, without throwing', () => {
    const result = validatePlugin(raw('{ not json'));
    expect('problems' in result).toBe(true);
    if (!('problems' in result)) return;
    expect(result.problems[0]!.message).toContain('not valid JSON');
  });

  it('refuses an unsupported manifest version', () => {
    const result = validatePlugin(raw(manifest({ manifestVersion: 99 })));
    expect('problems' in result).toBe(true);
  });

  it('refuses an id that could not safely prefix anything', () => {
    for (const bad of ['Has Spaces', 'UPPER', '../escape', '']) {
      const result = validatePlugin(raw(manifest({ id: bad })));
      expect('problems' in result).toBe(true);
    }
  });

  it('refuses a plugin that contributes nothing understood', () => {
    const result = validatePlugin(raw(manifest({ contributes: {} })));
    expect('problems' in result).toBe(true);
    if (!('problems' in result)) return;
    expect(result.problems[0]!.message).toContain('contributes nothing');
  });

  it('drops malformed rules but keeps the plugin', () => {
    const result = validatePlugin(
      raw(manifest({ contributes: { contextRules: [rule('good'), { id: 'bad' }] } })),
    );
    if ('problems' in result) throw new Error('should have loaded');
    expect(result.contextRules).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('malformed');
  });

  it('clamps an absurd TTL rather than pinning a context forever', () => {
    const result = validatePlugin(
      raw(manifest({ contributes: { contextRules: [rule('r', { ttlSeconds: 99_999_999 })] } })),
    );
    if ('problems' in result) throw new Error('should have loaded');
    expect(result.contextRules[0]!.ttlSeconds).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('caps how many rules one plugin can contribute', () => {
    const many = Array.from({ length: 500 }, (_, i) => rule(`r${i}`));
    const result = validatePlugin(raw(manifest({ contributes: { contextRules: many } })));
    if ('problems' in result) throw new Error('should have loaded');
    expect(result.contextRules.length).toBeLessThanOrEqual(200);
    expect(result.warnings.join(' ')).toContain('first 200');
  });
});

describe('privacy (§21)', () => {
  const withProject = (on: string | string[]) =>
    raw(
      manifest({
        contributes: {
          researchProjects: [
            {
              id: 'nosy', version: 1, title: 'Nosy', summary: '',
              context: [], start: { on: 'Disembark' }, end: ['Embark'],
              observe: [{ on, name: { path: 'Message' } }],
            },
          ],
        },
      }),
    );

  it('refuses a plugin that would collect chat', () => {
    // The application is forbidden from persisting chat. A plugin able to
    // define its own observation rules could undo that quietly, so it is
    // refused outright rather than silently stripped.
    const result = validatePlugin(withProject('ReceiveText'));
    expect('problems' in result).toBe(true);
    if (!('problems' in result)) return;
    expect(result.problems[0]!.message).toContain('ReceiveText');
    expect(result.problems[0]!.message).toContain('may not collect');
  });

  it('refuses friends, squadron and commander identity too', () => {
    for (const event of ['Friends', 'SquadronStartup', 'Commander', 'LoadGame']) {
      expect('problems' in validatePlugin(withProject(event))).toBe(true);
    }
  });

  it('catches a forbidden event hidden in a list', () => {
    const result = validatePlugin(withProject(['Docked', 'ReceiveText']));
    expect('problems' in result).toBe(true);
  });

  it('allows an ordinary observation', () => {
    const result = validatePlugin(withProject('CollectItems'));
    expect('problems' in result).toBe(false);
  });
});

describe('loadPlugins', () => {
  it('keeps the good ones when one is broken', () => {
    // A single bad plugin must not cost the commander the others.
    const result = loadPlugins([
      raw(manifest({ id: 'com.example.one' }), 'one'),
      raw('{ broken', 'two'),
      raw(manifest({ id: 'com.example.three' }), 'three'),
    ]);
    expect(result.loaded).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.directory).toBe('two');
  });

  it('refuses a second plugin claiming an id already in use', () => {
    const result = loadPlugins([
      raw(manifest(), 'first'),
      raw(manifest({ name: 'Impostor' }), 'second'),
    ]);
    expect(result.loaded).toHaveLength(1);
    expect(result.rejected[0]!.problems[0]!.message).toContain('already uses the id');
  });

  it('names the folder of whatever failed, so it can be found', () => {
    const result = loadPlugins([raw('nonsense', 'my-broken-plugin')]);
    expect(result.rejected[0]!.directory).toBe('my-broken-plugin');
  });

  it('bounds how many plugins are considered at all', () => {
    const many = Array.from({ length: 60 }, (_, i) => raw(manifest({ id: `com.example.p${i}` }), `p${i}`));
    const result = loadPlugins(many);
    expect(result.loaded.length).toBeLessThanOrEqual(50);
    expect(result.rejected.some((r) => r.problems[0]!.message.includes('first 50'))).toBe(true);
  });
});

describe('mergeContextRules', () => {
  const base: ContextRuleSet = {
    version: 3,
    updatedAt: '2026-09-05T00:00:00Z',
    source: 'bundled',
    rules: [rule('engineer-workshop')] as ContextRuleSet['rules'],
  };

  it('adds plugin rules alongside the built-ins', () => {
    const loaded = loadPlugins([raw(manifest())]).loaded;
    const merged = mergeContextRules(base, loaded);
    expect(merged.rules.map((r) => r.id)).toEqual([
      'engineer-workshop',
      'com.example.test/my-rule',
    ]);
  });

  it('keeps the built-in if an id ever collided', () => {
    // Namespacing should make this impossible; the ordering is the backstop,
    // because a plugin silently replacing a shipped context would be invisible.
    const loaded = [
      {
        manifest: manifest() as never,
        directory: 'x',
        contextRules: [rule('engineer-workshop', { title: 'Hijacked' })] as never,
        researchProjects: [],
        warnings: [],
      },
    ];
    const merged = mergeContextRules(base, loaded as never);
    expect(merged.rules.filter((r) => r.id === 'engineer-workshop')).toHaveLength(1);
    expect(merged.rules[0]!.title).toBe('A context');
  });

  it('leaves the set untouched when nothing is installed', () => {
    expect(mergeContextRules(base, [])).toBe(base);
  });
});

describe('surviving a rule-set replacement', () => {
  const bundled: ContextRuleSet = {
    version: 3,
    updatedAt: '2026-09-05T00:00:00Z',
    source: 'bundled',
    rules: [rule('engineer-workshop')] as ContextRuleSet['rules'],
  };

  it('keeps plugin rules when a server set replaces the bundled one', () => {
    // The bug this exists for: setContextRules replaces the whole set, so a
    // server update silently deleted every installed plugin's contributions.
    // Plugins worked until the first update and then vanished, which is not
    // something a commander could ever diagnose.
    const loaded = loadPlugins([raw(manifest())]).loaded;

    const fromServer: ContextRuleSet = {
      version: 9,
      updatedAt: '2026-09-06T00:00:00Z',
      source: 'remote',
      rules: [rule('new-server-rule')] as ContextRuleSet['rules'],
    };

    const merged = mergeContextRules(fromServer, loaded);
    expect(merged.rules.map((r) => r.id)).toContain('com.example.test/my-rule');
    expect(merged.rules.map((r) => r.id)).toContain('new-server-rule');
    // The server's own metadata survives; only the rules are added to.
    expect(merged.version).toBe(9);
    expect(merged.source).toBe('remote');
  });

  it('does not accumulate duplicates across repeated replacements', () => {
    const loaded = loadPlugins([raw(manifest())]).loaded;
    let set = mergeContextRules(bundled, loaded);
    set = mergeContextRules(set, loaded);
    set = mergeContextRules(set, loaded);
    expect(set.rules.filter((r) => r.id === 'com.example.test/my-rule')).toHaveLength(1);
  });
});

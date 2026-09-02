import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  applyEvent,
  initialState,
  normalize,
  parseLine,
  type CommanderState,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  BUNDLED_RULES,
  ContextResolver,
  evaluate,
  pageUrl,
  resourceUrl,
  sanitise,
  type ContextRuleSet,
} from '../src/index.js';

let offset = 0;
const ctx = new JournalSessionContext();

function ev(line: string): NormalizedEvent {
  const r = parseLine(line, 'J.log', (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

/** Verbatim from the validation corpus. */
const PROSPECTED =
  '{ "timestamp":"2026-08-20T12:00:00Z", "event":"ProspectedAsteroid", "Materials":[ { "Name":"Painite", "Proportion":22.5 } ], "Content":"$AsteroidMaterialContent_High;", "Content_Localised":"Material Content: High", "Remaining":100.000000 }';

const DOCKED_ENGINEER =
  '{ "timestamp":"2026-09-01T13:46:58Z", "event":"Docked", "StationName":"Farseer Inc", "StationType":"Outpost", "Taxi":false, "Multicrew":false, "StarSystem":"Deciat", "SystemAddress":6681123623626, "MarketID":128000000, "StationFaction":{ "Name":"F" }, "StationGovernment":"$government_Cooperative;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "engineer", "missions", "refuel", "stationMenu" ], "StationEconomy":"$economy_Colony;", "StationEconomies":[], "DistFromStarLS":1.0, "LandingPads":{ "Small":1, "Medium":1, "Large":0 } }';

const SCAN_ORGANIC =
  '{ "timestamp":"2026-08-29T18:48:28Z", "event":"ScanOrganic", "ScanType":"Log", "Genus":"$Codex_Ent_Fonticulus_Genus_Name;", "Genus_Localised":"Fonticulua", "Species":"$Codex_Ent_Fonticulus_02_Name;", "Species_Localised":"Fonticulua Campestris", "WasLogged":false, "SystemAddress":9480469554737, "Body":24 }';

const MUSIC = '{ "timestamp":"2026-09-01T13:28:26Z", "event":"Music", "MusicTrack":"NoTrack" }';

function stateWith(line?: string): CommanderState {
  const s = initialState();
  if (line) applyEvent(s, ev(line));
  return s;
}

describe('wiki URLs', () => {
  it('builds canonical EDFM URLs from page titles', () => {
    expect(pageUrl('Mining')).toBe('https://edfieldmanual.com/wiki/Mining');
    expect(pageUrl('Core Mining')).toBe('https://edfieldmanual.com/wiki/Core_Mining');
    expect(pageUrl('How to Use a Refinery')).toBe(
      'https://edfieldmanual.com/wiki/How_to_Use_a_Refinery',
    );
  });

  it('keeps slashes and colons, which are meaningful in titles', () => {
    expect(pageUrl('CMDR Fima/Privacy Policy')).toBe(
      'https://edfieldmanual.com/wiki/CMDR_Fima/Privacy_Policy',
    );
  });

  it('encodes characters that would otherwise break the URL', () => {
    expect(pageUrl('Tod "The Blaster" McQuinn')).toContain('%22');
  });

  it('refuses non-http schemes from an untrusted rule set', () => {
    // A rule set arrives over the network; it must not be able to hand the shell a
    // file: or custom-scheme URL to open.
    expect(resourceUrl({ url: 'file:///C:/Windows/System32' })).toBeNull();
    expect(resourceUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(resourceUrl({ url: 'https://example.com/x' })).toBe('https://example.com/x');
  });
});

describe('condition evaluation', () => {
  it('matches on event name, including a list', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(evaluate({ kind: 'event', name: 'ProspectedAsteroid' }, input)).toBe(true);
    expect(evaluate({ kind: 'event', name: 'Docked' }, input)).toBe(false);
    expect(evaluate({ kind: 'event', name: ['Docked', 'ProspectedAsteroid'] }, input)).toBe(true);
  });

  it('reads dotted paths out of the raw payload', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(
      evaluate({ kind: 'field', path: 'Materials.0.Name', op: 'eq', value: 'Painite' }, input),
    ).toBe(true);
    expect(evaluate({ kind: 'field', path: 'Remaining', op: 'gt', value: 50 }, input)).toBe(true);
    expect(evaluate({ kind: 'field', path: 'Nope', op: 'exists' }, input)).toBe(false);
  });

  it('matches station services case-insensitively', () => {
    // The raw array genuinely mixes cases (stationMenu, techBroker).
    const input = { event: ev(MUSIC), state: stateWith(DOCKED_ENGINEER) };
    expect(evaluate({ kind: 'service', id: 'engineer' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'stationMenu' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'stationmenu' }, input)).toBe(true);
    expect(evaluate({ kind: 'service', id: 'shipyard' }, input)).toBe(false);
  });

  it('treats an unknown service list as no match, not as an empty list', () => {
    const input = { event: ev(MUSIC), state: initialState() };
    expect(evaluate({ kind: 'service', id: 'engineer' }, input)).toBe(false);
  });

  it('combines with all/any/not', () => {
    const input = { event: ev(PROSPECTED), state: stateWith(DOCKED_ENGINEER) };
    expect(
      evaluate(
        { kind: 'all', of: [{ kind: 'event', name: 'ProspectedAsteroid' }, { kind: 'service', id: 'engineer' }] },
        input,
      ),
    ).toBe(true);
    expect(evaluate({ kind: 'not', of: { kind: 'event', name: 'Docked' } }, input)).toBe(true);
    expect(evaluate({ kind: 'all', of: [] }, input)).toBe(false); // vacuous truth is not useful here
  });

  it('refuses prototype-walking paths from an untrusted rule set', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    expect(evaluate({ kind: 'field', path: '__proto__.polluted', op: 'exists' }, input)).toBe(false);
    expect(evaluate({ kind: 'field', path: 'constructor.name', op: 'exists' }, input)).toBe(false);
  });

  it('does not throw on an unrecognised condition kind from a newer server', () => {
    const input = { event: ev(PROSPECTED), state: initialState() };
    const future = { kind: 'somethingNew', foo: 1 } as never;
    expect(evaluate(future, input)).toBe(false);
  });

  it('bounds recursion depth', () => {
    let nested = { kind: 'event', name: 'ProspectedAsteroid' } as never;
    for (let i = 0; i < 50; i += 1) nested = { kind: 'not', of: nested } as never;
    // Must return, not blow the stack.
    expect(typeof evaluate(nested, { event: ev(PROSPECTED), state: initialState() })).toBe('boolean');
  });
});

describe('ContextResolver', () => {
  function resolver(now: () => number) {
    return new ContextResolver(BUNDLED_RULES, { now, maxActive: 3 });
  }

  it('activates a context from a real prospecting event', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(true);

    const active = r.current();
    expect(active.map((a) => a.rule.id)).toContain('mining-prospecting');
    expect(active[0]!.triggerEvent).toBe('ProspectedAsteroid');
  });

  it('activates engineering context from station services alone', () => {
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_ENGINEER);
    r.observe(ev(MUSIC), state);
    expect(r.current().map((a) => a.rule.id)).toContain('station-engineer');
  });

  it('ranks by priority so the commander is not shown ten links at once', () => {
    const r = resolver(() => 1000);
    const state = stateWith(DOCKED_ENGINEER);
    r.observe(ev(MUSIC), state); // station-engineer (75)
    r.observe(ev(SCAN_ORGANIC), state); // exobiology-scan (80)
    r.observe(ev(PROSPECTED), state); // mining-prospecting (70)

    const ids = r.current().map((a) => a.rule.id);
    expect(ids[0]).toBe('exobiology-scan'); // highest priority wins
    expect(ids.length).toBeLessThanOrEqual(3);
  });

  it('expires contexts once their TTL passes', () => {
    let now = 1000;
    const r = resolver(() => now);
    r.observe(ev(PROSPECTED), initialState());
    expect(r.current().length).toBe(1);

    now += 901 * 1000; // mining-prospecting ttl is 900s
    expect(r.current().length).toBe(0);
  });

  it('refreshing an active context does not report a change', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(true);
    // Re-matching only extends expiry; forcing a re-render for that would be noise.
    expect(r.observe(ev(PROSPECTED), initialState())).toBe(false);
  });

  it('reports no change for the thousands of events that match nothing', () => {
    const r = resolver(() => 1000);
    expect(r.observe(ev(MUSIC), initialState())).toBe(false);
    expect(r.current()).toEqual([]);
  });

  it('drops active contexts when the rule set is replaced', () => {
    const r = resolver(() => 1000);
    r.observe(ev(PROSPECTED), initialState());
    expect(r.current().length).toBe(1);

    // Carrying contexts across a rule change would show guidance the new set does
    // not actually endorse.
    r.setRuleSet({ version: 2, updatedAt: 'x', source: 'remote', rules: [] });
    expect(r.current()).toEqual([]);
    expect(r.version).toBe(2);
  });
});

describe('sanitise', () => {
  const base = { version: 1, updatedAt: 'x', source: 'remote' as const };

  it('drops rules without an id, title or condition', () => {
    const set = sanitise({
      ...base,
      rules: [
        { id: '', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] },
        { id: 'ok', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] },
      ],
    } as ContextRuleSet);
    expect(set.rules.map((r) => r.id)).toEqual(['ok']);
  });

  it('rejects duplicate ids, which would make expiry ambiguous', () => {
    const rule = { id: 'dup', title: 'a', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1, resources: [] };
    const set = sanitise({ ...base, rules: [rule, rule] } as ContextRuleSet);
    expect(set.rules.length).toBe(1);
  });

  it('clamps an absurd or missing TTL so a context cannot pin itself on screen', () => {
    const set = sanitise({
      ...base,
      rules: [
        { id: 'a', title: 't', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 1e12, resources: [] },
        { id: 'b', title: 't', when: { kind: 'event', name: 'X' }, priority: 1, ttlSeconds: 0, resources: [] },
      ],
    } as ContextRuleSet);
    expect(set.rules[0]!.ttlSeconds).toBe(24 * 60 * 60);
    expect(set.rules[1]!.ttlSeconds).toBe(300);
  });
});

describe('bundled rule set', () => {
  it('has unique ids and survives sanitising unchanged', () => {
    const ids = BUNDLED_RULES.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sanitise(BUNDLED_RULES).rules.length).toBe(BUNDLED_RULES.rules.length);
  });

  it('only links pages verified to exist on EDFM', () => {
    // Checked against MediaWiki list=allpages on 2026-09-01. A rule pointing at a
    // page that does not exist produces a broken link that looks authoritative,
    // which is worse than showing nothing.
    const VERIFIED_PAGES = new Set([
      'Colonisation', 'Core Mining', 'Engineer Unlock Guide', 'Engineering',
      'Engineering Blueprints', 'Engineering Materials', 'Engineers', 'Exobiology',
      'Fleet Carrier Administration Systems', 'Fleet Carriers',
      'Frame Shift Drive Interdictor', 'How to Find a Mining Hotspot',
      'How to Resolve a Full Refinery', 'How to Use a Prospector Limpet',
      'How to Use a Refinery', 'Laser Mining', 'Mining', 'Mining Hotspot',
      'Pioneer Supplies', 'Planetary Rings', 'Powerplay', 'Refinery',
      'Ship Modules', 'Ships and Equipment', 'Trailblazers',
    ]);

    for (const rule of BUNDLED_RULES.rules) {
      for (const resource of rule.resources) {
        if (!resource.page) continue;
        expect(VERIFIED_PAGES.has(resource.page), `${rule.id} -> "${resource.page}"`).toBe(true);
      }
    }
  });

  it('gives every rule a resolvable URL', () => {
    for (const rule of BUNDLED_RULES.rules) {
      expect(rule.resources.length).toBeGreaterThan(0);
      for (const resource of rule.resources) {
        expect(resourceUrl(resource)).toMatch(/^https:\/\/edfieldmanual\.com\/wiki\//);
      }
    }
  });

  it('only triggers on events observed in the real journal corpus', () => {
    // Every event named here was counted in the 197,164-line corpus. A rule keyed
    // on an event the game never emits is dead weight that looks functional.
    const OBSERVED = new Set([
      'Interdicted', 'ColonisationConstructionDepot', 'ScanOrganic', 'ProspectedAsteroid',
      'SAASignalsFound', 'MiningRefined', 'PowerplayMerits', 'PowerplayCollect',
      'PowerplayDeliver', 'PowerplayRank',
    ]);

    const names: string[] = [];
    const walk = (c: unknown): void => {
      if (!c || typeof c !== 'object') return;
      const cond = c as { kind: string; name?: string | string[]; of?: unknown };
      if (cond.kind === 'event' && cond.name) {
        names.push(...(Array.isArray(cond.name) ? cond.name : [cond.name]));
      }
      if (Array.isArray(cond.of)) cond.of.forEach(walk);
      else if (cond.of) walk(cond.of);
    };
    BUNDLED_RULES.rules.forEach((r) => walk(r.when));

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(OBSERVED.has(name), name).toBe(true);
  });

  it('assigns distinct priorities to the top contexts so ranking is stable', () => {
    const top = [...BUNDLED_RULES.rules].sort((a, b) => b.priority - a.priority).slice(0, 5);
    expect(new Set(top.map((r) => r.priority)).size).toBe(top.length);
  });
});

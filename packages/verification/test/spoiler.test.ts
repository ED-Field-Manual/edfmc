/**
 * Spoiler-safety tests (§16).
 *
 * These are the tests that justify the claim that the Companion will not spoil
 * a commander's exploration. They are written against the real reveal ladder
 * measured from the journal corpus, using verbatim event payloads.
 *
 * The scenario throughout: EDFM already knows everything about
 * `Praea Euq PL-Q b5-4 A 12 e` — 5 biological signals, Stratum Tectonicas —
 * and the commander knows progressively more.
 */

import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  normalize,
  parseLine,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  DiscoveryState,
  VisibilityPolicy,
  buildNotification,
  gated,
  notificationStrings,
  opaqueReference,
  PUBLIC,
  VERIFICATION_ONLY,
  applyObservation,
  isSpoilerSensitive,
  type Discrepancy,
  type VerificationObservation,
} from '../src/index.js';

const SYSTEM = 9480469554737;
const BODY = 24;

let offset = 0;
function ev(line: string, ctx = new JournalSessionContext()): NormalizedEvent {
  const r = parseLine(line, 'J.log', (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

/* ---- Verbatim journal payloads, in reveal order ---- */

const ARRIVE = `{ "timestamp":"2026-08-29T18:00:00Z", "event":"FSDJump", "StarSystem":"Praea Euq PL-Q b5-4", "SystemAddress":${SYSTEM}, "StarPos":[1.0,2.0,3.0], "Body":"Praea Euq PL-Q b5-4 A", "BodyID":1, "BodyType":"Star", "JumpDist":8.0, "FuelUsed":1.0, "FuelLevel":30.0, "Population":0, "SystemAllegiance":"", "SystemEconomy":"$economy_None;", "SystemEconomy_Localised":"None", "SystemSecondEconomy":"$economy_None;", "SystemSecondEconomy_Localised":"None", "SystemGovernment":"$government_None;", "SystemGovernment_Localised":"None", "SystemSecurity":"$x;", "SystemSecurity_Localised":"Low", "Taxi":false, "Multicrew":false }`;

/** FSS: reveals COUNTS only. No genus, no species. */
const FSS_SIGNALS = `{ "timestamp":"2026-08-29T18:15:00Z", "event":"FSSBodySignals", "BodyName":"Praea Euq PL-Q b5-4 A 12 e", "BodyID":${BODY}, "SystemAddress":${SYSTEM}, "Signals":[ { "Type":"$SAA_SignalType_Biological;", "Type_Localised":"Biological", "Count":5 } ] }`;

/** DSS: reveals counts AND the genus list. Still no species. */
const DSS_SIGNALS = `{ "timestamp":"2026-08-29T18:30:00Z", "event":"SAASignalsFound", "BodyName":"Praea Euq PL-Q b5-4 A 12 e", "SystemAddress":${SYSTEM}, "BodyID":${BODY}, "Signals":[ { "Type":"$SAA_SignalType_Biological;", "Type_Localised":"Biological", "Count":5 } ], "Genuses":[ { "Genus":"$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised":"Stratum" } ] }`;

/** Organic scan: reveals genus, species and variant. */
const SCAN_ORGANIC = `{ "timestamp":"2026-08-29T18:48:28Z", "event":"ScanOrganic", "ScanType":"Log", "Genus":"$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised":"Stratum", "Species":"$Codex_Ent_Stratum_02_Name;", "Species_Localised":"Stratum Tectonicas", "Variant":"$Codex_Ent_Stratum_02_M_Name;", "Variant_Localised":"Stratum Tectonicas - Green", "WasLogged":false, "SystemAddress":${SYSTEM}, "Body":${BODY} }`;

/** What EDFM already knows. The Companion must not leak any of it early. */
const EDFM_KNOWS = {
  signalCount: 5,
  genus: 'Stratum',
  species: 'Stratum Tectonicas',
};

function policyAfter(...lines: string[]): { policy: VisibilityPolicy; discovery: DiscoveryState } {
  const discovery = new DiscoveryState('F-TEST');
  const ctx = new JournalSessionContext();
  for (const line of lines) discovery.observe(ev(line, ctx));
  return { policy: new VisibilityPolicy(discovery), discovery };
}

/** The gates EDFM's knowledge would sit behind. */
const SIGNAL_GATE = { kind: 'signals-known', systemAddress: SYSTEM, bodyId: BODY } as const;
const GENUS_GATE = { kind: 'genus-known', systemAddress: SYSTEM, bodyId: BODY, genus: EDFM_KNOWS.genus } as const;
const SPECIES_GATE = { kind: 'species-known', systemAddress: SYSTEM, bodyId: BODY, species: EDFM_KNOWS.species } as const;

describe('the commander has only arrived in the system', () => {
  it('does not reveal the biological signal count', () => {
    // EDFM knows there are 5. The commander has not run an FSS.
    const { policy } = policyAfter(ARRIVE);
    expect(policy.reveal(gated(EDFM_KNOWS.signalCount, SIGNAL_GATE))).toBeNull();
  });

  it('does not reveal the genus or the species', () => {
    const { policy } = policyAfter(ARRIVE);
    expect(policy.reveal(gated(EDFM_KNOWS.genus, GENUS_GATE))).toBeNull();
    expect(policy.reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBeNull();
  });

  it('omits hidden fields entirely rather than nulling them', () => {
    // A present-but-empty key still says "there is something here", and a count
    // of hidden items is itself a spoiler.
    const { policy } = policyAfter(ARRIVE);
    const view = policy.project({
      bodyName: gated('Praea Euq PL-Q b5-4 A 12 e', PUBLIC),
      signalCount: gated(EDFM_KNOWS.signalCount, SIGNAL_GATE),
      species: gated(EDFM_KNOWS.species, SPECIES_GATE),
    });

    expect(Object.keys(view)).toEqual(['bodyName']);
    expect('signalCount' in view).toBe(false);
    expect('species' in view).toBe(false);
  });
});

describe('the commander has run an FSS', () => {
  it('reveals the signal count, because their own game reported it', () => {
    const { policy } = policyAfter(ARRIVE, FSS_SIGNALS);
    expect(policy.reveal(gated(EDFM_KNOWS.signalCount, SIGNAL_GATE))).toBe(5);
  });

  it('still does not reveal genus or species', () => {
    // FSSBodySignals carries counts and nothing else -- measured, not assumed.
    const { policy } = policyAfter(ARRIVE, FSS_SIGNALS);
    expect(policy.reveal(gated(EDFM_KNOWS.genus, GENUS_GATE))).toBeNull();
    expect(policy.reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBeNull();
  });
});

describe('the commander has mapped the body with a DSS', () => {
  it('reveals the genus, which the DSS listed', () => {
    const { policy } = policyAfter(ARRIVE, DSS_SIGNALS);
    expect(policy.reveal(gated(EDFM_KNOWS.genus, GENUS_GATE))).toBe('Stratum');
  });

  it('still does not reveal the species', () => {
    // Knowing "Stratum" is not knowing "Stratum Tectonicas". Collapsing genus
    // and species into one gate would spoil the identification.
    const { policy } = policyAfter(ARRIVE, DSS_SIGNALS);
    expect(policy.reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBeNull();
  });
});

describe('the commander has scanned the organism', () => {
  it('reveals the species', () => {
    const { policy } = policyAfter(ARRIVE, FSS_SIGNALS, SCAN_ORGANIC);
    expect(policy.reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBe('Stratum Tectonicas');
  });

  it('reveals a different species only when that one was scanned', () => {
    const { policy } = policyAfter(ARRIVE, SCAN_ORGANIC);
    const other = { kind: 'species-known', systemAddress: SYSTEM, bodyId: BODY, species: 'Bacterium Informem' } as const;
    expect(policy.reveal(gated('Bacterium Informem', other))).toBeNull();
  });
});

describe('context links obey the same policy', () => {
  it('withholds a species article until the species is identified', () => {
    // The label alone is the spoiler; the link never has to be clicked.
    const resources = [
      gated({ label: 'Exobiology' }, PUBLIC),
      gated({ label: 'Stratum Tectonicas' }, SPECIES_GATE),
    ];

    const before = policyAfter(ARRIVE, DSS_SIGNALS).policy.revealAll(resources);
    expect(before.map((r) => r.label)).toEqual(['Exobiology']);

    const after = policyAfter(ARRIVE, DSS_SIGNALS, SCAN_ORGANIC).policy.revealAll(resources);
    expect(after.map((r) => r.label)).toEqual(['Exobiology', 'Stratum Tectonicas']);
  });
});

describe('discovery state is per commander and survives restart', () => {
  it('keeps legitimately discovered information across a restart', () => {
    const { discovery } = policyAfter(ARRIVE, FSS_SIGNALS, SCAN_ORGANIC);
    const restored = DiscoveryState.fromJSON(JSON.parse(JSON.stringify(discovery)), 'F-TEST');

    expect(new VisibilityPolicy(restored).reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBe(
      'Stratum Tectonicas',
    );
  });

  it('does not leak one commander’s discoveries to another', () => {
    // Two commanders on one PC is ordinary. Loading the wrong state would
    // reveal discoveries the second commander has not made.
    const { discovery } = policyAfter(ARRIVE, FSS_SIGNALS, SCAN_ORGANIC);
    const other = DiscoveryState.fromJSON(JSON.parse(JSON.stringify(discovery)), 'F-OTHER');

    expect(other.commanderFid).toBe('F-OTHER');
    expect(new VisibilityPolicy(other).reveal(gated(EDFM_KNOWS.species, SPECIES_GATE))).toBeNull();
    expect(new VisibilityPolicy(other).reveal(gated(EDFM_KNOWS.signalCount, SIGNAL_GATE))).toBeNull();
  });
});

describe('failing closed', () => {
  it('hides anything marked verification-only, always', () => {
    // Even a commander who has scanned everything must not see EDFM's expected
    // values through the UI.
    const { policy } = policyAfter(ARRIVE, FSS_SIGNALS, SCAN_ORGANIC);
    expect(policy.reveal(gated('EDFM expected value', VERIFICATION_ONLY))).toBeNull();
  });

  it('hides an unrecognised gate rather than showing it', () => {
    // A gate from a newer server than this client. Failing open would spoil
    // something, and that cannot be undone.
    const { policy } = policyAfter(ARRIVE, FSS_SIGNALS, SCAN_ORGANIC);
    const future = { kind: 'some-future-gate' } as never;
    expect(policy.reveal(gated('secret', future))).toBeNull();
  });
});

/* ------------------------------------------------------ Discord redaction */

function observation(overrides: Partial<VerificationObservation> = {}): VerificationObservation {
  return {
    entityType: 'body',
    entityId: `${SYSTEM}:${BODY}`,
    field: 'biologicalSignals',
    expectedValue: '5',
    observedValue: '3',
    rawToken: null,
    evidence: 'direct',
    confidence: 'high',
    volatility: 'static',
    visibility: SIGNAL_GATE,
    observedAt: '2026-08-29T18:15:00Z',
    commander: 'Sythan',
    commanderFid: 'F-TEST',
    gameVersion: '4.4.0.3',
    gameBuild: 'r330683/r0 ',
    companionVersion: '0.1.0',
    sourceEventId: 'J.log:100',
    sourceEvent: 'FSSBodySignals',
    sessionKey: 'J.log',
    ...overrides,
  };
}

function discrepancy(o: VerificationObservation): Discrepancy {
  return applyObservation(undefined, o, 'value_mismatch');
}

describe('Discord redaction', () => {
  it('treats an exploration discrepancy as spoiler-sensitive', () => {
    expect(isSpoilerSensitive(discrepancy(observation()))).toBe(true);
  });

  it('omits system, body, species and field from a redacted payload', () => {
    const payload = buildNotification(discrepancy(observation()), { reason: 'created' });
    const text = notificationStrings(payload).join(' | ');

    expect(payload.redacted).toBe(true);
    // Nothing that identifies the location or the discovery.
    expect(text).not.toContain(String(SYSTEM));
    expect(text).not.toContain(`${SYSTEM}:${BODY}`);
    expect(text).not.toContain('Praea Euq');
    expect(text).not.toContain('Stratum');
    expect(text).not.toContain('biologicalSignals');
    expect(text).toContain('Admin Review');
  });

  it('does not disclose the expected or observed values', () => {
    // Asserted on field values rather than by scanning the text for "5": a
    // single digit occurs by chance inside the opaque reference, so a substring
    // search there passes or fails for reasons unrelated to disclosure.
    // "EDFM says 5, game says 3" is the spoiler, and it is a *field* that would
    // carry it.
    const payload = buildNotification(discrepancy(observation()), { reason: 'created' });
    const values = payload.fields.map((f) => f.value);

    expect(values).not.toContain('5');
    expect(values).not.toContain('3');
    expect(payload.fields.map((f) => f.name)).not.toContain('EDFM');
    expect(payload.fields.map((f) => f.name)).not.toContain('Observed');
  });

  it('carries an opaque reference rather than the discrepancy key', () => {
    // The key is entityType|entityId|field|expected|observed|version. Posting
    // it would put everything the redaction removes straight back in.
    const d = discrepancy(observation());
    const payload = buildNotification(d, { reason: 'created' });

    expect(payload.reference).toMatch(/^EDFM-[0-9A-Z]+$/);
    expect(payload.reference).not.toContain(String(SYSTEM));
    expect(notificationStrings(payload).join(' ')).not.toContain(d.key);
    // Still resolvable to exactly one discrepancy for a reviewer.
    expect(opaqueReference(d.key)).toBe(payload.reference);
  });

  it('does not name the commander unless attribution was chosen', () => {
    const anon = buildNotification(discrepancy(observation()), { reason: 'created' });
    expect(notificationStrings(anon).join(' ')).not.toContain('Sythan');

    const named = buildNotification(discrepancy(observation()), {
      reason: 'created',
      attributeCommander: true,
    });
    expect(notificationStrings(named).join(' ')).toContain('Sythan');
  });

  it('includes full detail for a non-sensitive station discrepancy', () => {
    const station = observation({
      entityType: 'station',
      entityId: '128',
      field: 'service:vistagenomics',
      expectedValue: 'present',
      observedValue: 'absent',
      visibility: PUBLIC,
    });
    const payload = buildNotification(discrepancy(station), { reason: 'created' });
    const text = notificationStrings(payload).join(' | ');

    expect(payload.redacted).toBe(false);
    expect(text).toContain('service:vistagenomics');
    expect(text).toContain('128');
  });

  it('words a dynamic mismatch as staleness rather than error', () => {
    // Telling a maintainer EDFM is "wrong" about a faction that flipped last
    // week is untrue, and erodes trust in every other report.
    const dynamic = observation({
      entityType: 'station',
      visibility: PUBLIC,
      volatility: 'dynamic',
      field: 'stationFaction',
    });
    const payload = buildNotification(discrepancy(dynamic), { reason: 'created' });
    expect(payload.summary).toContain('outdated');
    expect(payload.summary).not.toContain('incorrect');
  });
});

describe('verification proceeds even when the player cannot see it', () => {
  it('records a hidden discrepancy without revealing anything to the player', () => {
    // Verify aggressively, reveal conservatively: the discrepancy is real and
    // reportable, and the commander learns nothing new from it.
    const d = discrepancy(observation());
    expect(d.status).toBe('new');
    expect(d.expectedValue).toBe('5');

    const { policy } = policyAfter(ARRIVE);
    expect(policy.reveal(gated(d.expectedValue, d.visibility))).toBeNull();
    expect(policy.reveal(gated(d.observedValue, d.visibility))).toBeNull();
  });
});

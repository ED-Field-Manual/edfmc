import { describe, expect, it } from 'vitest';
import {
  buildReportBody,
  buildResolutionBody,
  buildThreadName,
  buildUpdateBody,
  type ReportSubject,
} from '../src/lib/discord/format.js';
import { parseTagMap, resolveTags } from '../src/lib/discord/tags.js';

const subject: ReportSubject = {
  category: 'Service',
  summary: 'Incorrect Station Service',
  system: 'Shinrarta Dezhra',
  place: 'Jameson Memorial',
  field: 'Service: techbroker',
  edfmValue: 'techbroker',
  observedValue: null,
  observedFrom: 'Docked',
  detectedAt: '2026-09-02T19:00:00.000Z',
  companionVersion: '0.1.0',
  reference: 'EDFM-1XB7IM5',
};

describe('buildThreadName', () => {
  it('reads as a moderator would write it', () => {
    expect(buildThreadName(subject)).toBe('Incorrect Station Service — Jameson Memorial');
  });

  it('falls back through place, body, then system', () => {
    expect(buildThreadName({ ...subject, place: null })).toBe(
      'Incorrect Station Service — Shinrarta Dezhra',
    );
    expect(buildThreadName({ ...subject, place: null, system: null })).toBe(
      'Incorrect Station Service',
    );
  });

  it('carries no raw identifiers or JSON', () => {
    // A MarketID in a Forum list helps nobody scanning it; the body has it.
    const title = buildThreadName(subject);
    expect(title).not.toMatch(/[{}[\]"]/);
    expect(title).not.toMatch(/\d{6,}/);
  });
});

describe('buildReportBody', () => {
  it('includes only applicable fields', () => {
    const body = buildReportBody(subject);
    expect(body).toContain('**System:** Shinrarta Dezhra');
    expect(body).toContain('**EDFM Value:** techbroker');
    // observedValue is null -- the label would be noise, not information.
    expect(body).not.toContain('Observed Game Value');
    expect(body).not.toContain('Body:');
    expect(body).not.toContain('Commander:');
  });

  it('names the commander only when one was supplied', () => {
    expect(buildReportBody({ ...subject, commander: 'Hadfield' })).toContain(
      '**Commander:** Hadfield',
    );
  });

  it('carries the opaque reference for review', () => {
    expect(buildReportBody(subject)).toContain('EDFM-1XB7IM5');
  });
});

describe('buildUpdateBody', () => {
  it('says only what changed', () => {
    expect(buildUpdateBody('confirmed', subject, 3)).toContain('Distinct reporters: 3');
    expect(buildUpdateBody('observed-value-changed', subject, 1)).toContain(
      'observed in game has changed',
    );
    expect(buildUpdateBody('edfm-value-changed', subject, 1)).toContain(
      'reference value has changed',
    );
  });
});

describe('buildResolutionBody', () => {
  it('is one concise line', () => {
    expect(buildResolutionBody()).toBe(
      'Resolved: EDFM now matches the value observed by the Companion.',
    );
  });
});

describe('parseTagMap', () => {
  it('accepts the flat form', () => {
    expect(parseTagMap('Station=123,Service=456')).toEqual({ Station: '123', Service: '456' });
  });

  it('accepts JSON', () => {
    expect(parseTagMap('{"Station":"123"}')).toEqual({ Station: '123' });
  });

  it('accepts names containing a space', () => {
    expect(parseTagMap('Needs Review=789')).toEqual({ 'Needs Review': '789' });
  });

  it('drops an unknown category rather than throwing', () => {
    const warnings: string[] = [];
    expect(parseTagMap('Nonsense=123,Station=456', (m) => warnings.push(m))).toEqual({
      Station: '456',
    });
    expect(warnings).toContain('discord.tag_unknown');
  });

  it('rejects a display name pasted where an id belongs', () => {
    // The commonest configuration mistake: tags apply by snowflake, not name.
    const warnings: string[] = [];
    expect(parseTagMap('Station=Station Issues', (m) => warnings.push(m))).toEqual({});
    expect(warnings).toContain('discord.tag_not_a_snowflake');
  });

  it('survives malformed JSON without stopping the service', () => {
    expect(parseTagMap('{oops', () => {})).toEqual({});
  });

  it('treats absent configuration as no tags', () => {
    expect(parseTagMap(undefined)).toEqual({});
    expect(parseTagMap('')).toEqual({});
  });
});

describe('resolveTags', () => {
  const map = parseTagMap('Station=1,Service=2,Needs Review=3');

  it('resolves what is configured', () => {
    expect(resolveTags(map, ['Service', 'Needs Review'])).toEqual(['2', '3']);
  });

  it('silently omits an unconfigured category', () => {
    // §7: an optional tag must never fail the whole report.
    expect(resolveTags(map, ['Colonisation', 'Service'])).toEqual(['2']);
    expect(resolveTags({}, ['Station', 'Confirmed'])).toEqual([]);
  });

  it('stays within Discord’s five-tag limit', () => {
    const big = parseTagMap('Station=1,Service=2,System=3,Commodity=4,Engineer=5,Shipyard=6');
    expect(
      resolveTags(big, ['Station', 'Service', 'System', 'Commodity', 'Engineer', 'Shipyard']),
    ).toHaveLength(5);
  });

  it('does not repeat an id mapped to two names', () => {
    expect(resolveTags(parseTagMap('Station=1,Service=1'), ['Station', 'Service'])).toEqual(['1']);
  });
});

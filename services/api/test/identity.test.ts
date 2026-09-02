import { describe, expect, it } from 'vitest';
import { areIndependent, hashIdentity, independentCount, hashValue } from '../src/lib/identity.js';

const SALT = 'a'.repeat(64);

const id = (fid: string, cmdr: string, journal: string) =>
  hashIdentity(SALT, { mode: 'anonymous', fid, commanderName: cmdr, journalFile: journal });

describe('hashIdentity', () => {
  it('never returns the value it was given', () => {
    const hashed = hashIdentity(SALT, {
      mode: 'commander',
      fid: 'F1234567',
      commanderName: 'Hadfield',
      journalFile: 'Journal.2026-09-02T120000.01.log',
    });
    const serialised = JSON.stringify(hashed);
    // The whole basis of the privacy claim: a database dump must not contain
    // the identifiers, only distinguishers derived from them.
    expect(serialised).not.toContain('F1234567');
    expect(serialised).not.toContain('Hadfield');
    expect(serialised.toLowerCase()).not.toContain('journal.2026');
  });

  it('folds commander name case so one commander is one commander', () => {
    const a = hashIdentity(SALT, { mode: 'commander', commanderName: 'Hadfield' });
    const b = hashIdentity(SALT, { mode: 'commander', commanderName: 'hadfield' });
    expect(a.commanderHash).toBe(b.commanderHash);
  });

  it('separates domains so equal values in different fields do not collide', () => {
    // Without domain separation a commander named the same as their journal
    // file would corroborate themselves across two columns.
    expect(hashValue(SALT, 'fid', 'X')).not.toBe(hashValue(SALT, 'cmdr', 'X'));
  });

  it('produces different hashes under a different salt', () => {
    expect(hashValue(SALT, 'fid', 'F1')).not.toBe(hashValue('b'.repeat(64), 'fid', 'F1'));
  });

  it('leaves absent fields null rather than hashing an empty string', () => {
    const hashed = hashIdentity(SALT, { mode: 'anonymous' });
    expect(hashed).toMatchObject({ fidHash: null, commanderHash: null, journalHash: null });
  });
});

describe('areIndependent', () => {
  it('requires all three to differ', () => {
    expect(areIndependent(id('F1', 'A', 'j1'), id('F2', 'B', 'j2'))).toBe(true);
    expect(areIndependent(id('F1', 'A', 'j1'), id('F1', 'B', 'j2'))).toBe(false);
    expect(areIndependent(id('F1', 'A', 'j1'), id('F2', 'A', 'j2'))).toBe(false);
    expect(areIndependent(id('F1', 'A', 'j1'), id('F2', 'B', 'j1'))).toBe(false);
  });

  it('fails closed when a hash is missing', () => {
    // Cannot show they differ, so must not claim they do.
    const anonymous = hashIdentity(SALT, { mode: 'anonymous' });
    expect(areIndependent(anonymous, id('F2', 'B', 'j2'))).toBe(false);
    expect(areIndependent(anonymous, anonymous)).toBe(false);
  });
});

describe('independentCount', () => {
  it('counts one commander reporting repeatedly as one', () => {
    const same = [id('F1', 'A', 'j1'), id('F1', 'A', 'j1'), id('F1', 'A', 'j2')];
    expect(independentCount(same)).toBe(1);
  });

  it('counts genuinely distinct reporters', () => {
    expect(independentCount([id('F1', 'A', 'j1'), id('F2', 'B', 'j2'), id('F3', 'C', 'j3')])).toBe(3);
  });

  it('does not let anonymous reports inflate confirmation', () => {
    // Three reports with no distinguishers at all could be one person.
    const anon = hashIdentity(SALT, { mode: 'anonymous' });
    expect(independentCount([anon, anon, anon])).toBe(1);
  });
});

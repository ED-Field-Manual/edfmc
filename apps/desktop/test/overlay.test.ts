/**
 * Tests for the desktop app's pure presentation logic.
 *
 * The app had no test runner, so this logic went unverified while the packages
 * around it were covered. Anything here must stay free of Tauri and DOM: the
 * point is the arithmetic, not the wiring.
 */

import { describe, expect, it } from 'vitest';

import { countdownTo } from '../src/lib/overlay.js';

describe('countdownTo', () => {
  // A real DepartureTime, verbatim from the corpus.
  const DEPARTURE = '2026-08-14T00:32:10Z';
  const at = Date.parse(DEPARTURE);

  it('counts down in minutes and seconds', () => {
    expect(countdownTo(DEPARTURE, at - 900_000)).toBe('15:00');
    expect(countdownTo(DEPARTURE, at - 522_000)).toBe('8:42');
    expect(countdownTo(DEPARTURE, at - 59_000)).toBe('0:59');
    expect(countdownTo(DEPARTURE, at - 1_000)).toBe('0:01');
  });

  it('pads seconds so the line does not jitter as it ticks', () => {
    expect(countdownTo(DEPARTURE, at - 61_000)).toBe('1:01');
    expect(countdownTo(DEPARTURE, at - 600_000)).toBe('10:00');
  });

  it('adds an hours field only when there are hours', () => {
    // The longest countdown measured in the corpus was 2641s, so this is reachable.
    expect(countdownTo(DEPARTURE, at - 3_661_000)).toBe('1:01:01');
    expect(countdownTo(DEPARTURE, at - 2_641_000)).toBe('44:01');
  });

  it('returns null once the stated time has passed', () => {
    // The caller says "Departing" instead. A negative or zeroed clock would imply
    // we know the carrier left, and the journal has not said so.
    expect(countdownTo(DEPARTURE, at)).toBeNull();
    expect(countdownTo(DEPARTURE, at + 1_000)).toBeNull();
    expect(countdownTo(DEPARTURE, at + 86_400_000)).toBeNull();
  });

  it('returns null for a timestamp it cannot parse', () => {
    // Rather than rendering NaN over the game.
    expect(countdownTo('not a date', Date.now())).toBeNull();
    expect(countdownTo('', Date.now())).toBeNull();
  });
});

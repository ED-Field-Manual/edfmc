/**
 * Is the game running, and how much of the dashboard is live?
 *
 * Reading a journal is not evidence the game is running: the file stays there,
 * unchanged, after Elite exits, and a crash writes no `Shutdown`. So this
 * combines what the app can actually observe:
 *
 * - **the game window**, by its class name (the same check the overlay uses
 *   to find Elite), polled while the app runs;
 * - **`Shutdown`** in the journal, which a clean exit writes;
 * - **the journal reader's own state**: no folder, an error, or watching.
 *
 * Pure, so every combination is tested without a game or a window.
 */

export type ReaderState = 'starting' | 'watching' | 'no-directory' | 'stopped' | 'error';

export type SessionStatus =
  /** The game window is open. What the journal says is current. */
  | 'game-active'
  /** No game window, or the journal says the game exited. Last known state. */
  | 'game-offline'
  /** Window check unavailable and no Shutdown seen: cannot say either way. */
  | 'game-unknown'
  /** No journal folder, or the reader is starting up. */
  | 'waiting-for-journal'
  | 'journal-error';

export interface SessionInput {
  readonly reader: ReaderState;
  /** True/false from the window check; null when the check could not be made. */
  readonly gameWindow: boolean | null;
  /** The journal's newest session ended with `Shutdown`. */
  readonly shutdownSeen: boolean;
}

export function sessionStatus(i: SessionInput): SessionStatus {
  if (i.reader === 'error') return 'journal-error';
  if (i.reader === 'no-directory' || i.reader === 'starting' || i.reader === 'stopped') {
    return 'waiting-for-journal';
  }
  // The window is the stronger signal: it is there or it is not. A Shutdown
  // followed by a relaunch shows a window before the new LoadGame arrives.
  if (i.gameWindow === true) return 'game-active';
  if (i.gameWindow === false) return 'game-offline';
  return i.shutdownSeen ? 'game-offline' : 'game-unknown';
}

/** Whether location and ship can be described as current. */
export function isLive(status: SessionStatus): boolean {
  return status === 'game-active';
}

/** Words for the status pill; never colour alone. */
export const SESSION_LABEL: Readonly<Record<SessionStatus, string>> = {
  'game-active': 'Game active',
  'game-offline': 'Game offline',
  'game-unknown': 'Watching journal',
  'waiting-for-journal': 'Waiting for journal',
  'journal-error': 'Journal error',
};

/** Private group as the game names it; Open and Solo as they are. */
export function gameModeLabel(mode: string | null, group: string | null): string | null {
  if (mode === null) return null;
  if (mode === 'Group') return group ? `Private Group: ${group}` : 'Private Group';
  return mode;
}

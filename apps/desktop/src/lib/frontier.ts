/**
 * Frontier Developments login, as the Connections screen sees it.
 *
 * Status and three actions, nothing more. The login itself -- PKCE, the
 * browser round trip, the token exchange, storage and refresh -- happens in
 * Rust (src-tauri/src/frontier.rs). No token ever reaches this side: no
 * command returns one, and failures arrive as a category name.
 */

import { invoke } from '@tauri-apps/api/core';

export interface FrontierStatus {
  /** False until the approved Client ID and redirect URI are built in. */
  readonly configured: boolean;
  /** Why not, in words, when not configured. */
  readonly reason: string | null;
  readonly connected: boolean;
  readonly connecting: boolean;
}

/** Failure categories from Rust (`frontier::Failure`), in words. */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'not-configured': 'Frontier login is not set up in this build yet.',
  busy: 'A Frontier login is already in progress.',
  cancelled: 'Login cancelled.',
  'timed-out': 'The login was not finished in time. Try again.',
  denied: 'Frontier did not grant access.',
  'state-mismatch': 'The login response did not match this request, so it was ignored.',
  'callback-unavailable': 'EDFM Companion could not receive the login response.',
  'invalid-grant': 'Frontier no longer accepts this login. Connect again.',
  'bad-response': 'Frontier sent an unexpected response.',
  network: 'Frontier could not be reached.',
  'store-unavailable': 'Windows Credential Manager could not be used.',
  'not-connected': 'Not connected to Frontier.',
  internal: 'Something went wrong inside EDFM Companion.',
};

export function failureText(error: unknown): string {
  return (typeof error === 'string' && FAILURE_TEXT[error]) || 'The Frontier login failed.';
}

export const frontier = {
  status: () => invoke<FrontierStatus>('frontier_status'),
  /** Resolves when the login finishes; rejects with a failure category. */
  connect: () => invoke<void>('frontier_connect'),
  cancel: () => invoke<void>('frontier_cancel'),
  disconnect: () => invoke<void>('frontier_disconnect'),
};

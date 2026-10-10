/**
 * The app's global hotkeys, and which one already owns a combination.
 *
 * All of them are optional and unset until the commander picks one: Elite
 * setups are crowded, and claiming a key unasked could break something used in
 * flight. They are all bound together (`registerScreenshotHotkey` in
 * companion.ts), because the shortcut plugin's `unregisterAll` would otherwise
 * drop the ones not being changed. None of them sends anything to the game.
 */

export type HotkeyAction = 'screenshot' | 'routeCopy' | 'carrierCopy' | 'overlayToggle';

/** What each hotkey does, as the end of "That combination already …". */
export const HOTKEY_PURPOSE: Readonly<Record<HotkeyAction, string>> = {
  screenshot: 'captures screenshots',
  routeCopy: 'copies your next waypoint',
  carrierCopy: 'copies the carrier’s next jump',
  overlayToggle: 'shows and hides the overlay',
};

/**
 * Why `binding` cannot be given to `action`, or null when it can.
 * Compared ignoring case, as the OS does.
 */
export function hotkeyConflict(
  bindings: Readonly<Record<HotkeyAction, string | null>>,
  action: HotkeyAction,
  binding: string,
): string | null {
  const wanted = binding.toLowerCase();
  for (const [other, current] of Object.entries(bindings) as Array<[HotkeyAction, string | null]>) {
    if (other !== action && current !== null && current.toLowerCase() === wanted) {
      return `That combination already ${HOTKEY_PURPOSE[other]}.`;
    }
  }
  return null;
}

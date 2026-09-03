/**
 * Forum tag mapping.
 *
 * Discord applies Forum tags by **snowflake id**, not by the name a moderator
 * sees. Those ids are per-channel and differ between the test forum and the
 * real one, so they cannot be constants in the source: they are configuration.
 *
 * A missing mapping is not an error. A report that fails to post because
 * nobody configured a "Colonisation" tag id is strictly worse than one that
 * posts untagged, so an unmapped category is dropped and the report goes out.
 */

/** The categories a report can be filed under. */
export const REPORT_CATEGORIES = [
  'Station',
  'Settlement',
  'System',
  'Commodity',
  'Service',
  'Outfitting',
  'Shipyard',
  'Engineer',
  'Colonisation',
] as const;

/** Lifecycle tags, applied alongside a category. */
export const STATUS_CATEGORIES = ['Needs Review', 'Confirmed', 'Resolved'] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export type TagName = ReportCategory | StatusCategory;

export type TagMap = Readonly<Partial<Record<TagName, string>>>;

const ALL_NAMES: readonly string[] = [...REPORT_CATEGORIES, ...STATUS_CATEGORIES];

/** Discord snowflakes are numeric strings. */
const SNOWFLAKE = /^\d{1,20}$/;

/**
 * Parse the configured mapping.
 *
 * Accepts JSON (`{"Station":"123"}`) or the flatter `Station=123,Service=456`,
 * because a Forum tag list is the sort of thing that gets pasted into a shell
 * and JSON quoting there is a nuisance.
 *
 * Unknown names and malformed ids are dropped with a warning rather than
 * throwing: a typo in an optional tag must not stop the service from booting.
 */
export function parseTagMap(
  raw: string | undefined,
  warn: (message: string, detail?: Record<string, unknown>) => void = () => {},
): TagMap {
  if (!raw || raw.trim() === '') return {};

  const entries: [string, string][] = [];
  const trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [name, id] of Object.entries(parsed)) entries.push([name, String(id)]);
    } catch (error) {
      warn('discord.tags_unparsable', { detail: (error as Error).message });
      return {};
    }
  } else {
    for (const pair of trimmed.split(',')) {
      if (pair.trim() === '') continue;
      const index = pair.indexOf('=');
      if (index === -1) {
        warn('discord.tag_entry_malformed', { entry: pair.trim() });
        continue;
      }
      entries.push([pair.slice(0, index).trim(), pair.slice(index + 1).trim()]);
    }
  }

  const map: Record<string, string> = {};
  for (const [name, id] of entries) {
    if (!ALL_NAMES.includes(name)) {
      warn('discord.tag_unknown', { name });
      continue;
    }
    if (!SNOWFLAKE.test(id)) {
      // Almost always someone pasting the display name instead of the id.
      warn('discord.tag_not_a_snowflake', { name });
      continue;
    }
    map[name] = id;
  }
  return map;
}

/**
 * Resolve tag names to ids, dropping whatever is not configured.
 *
 * Discord caps applied tags at five; more is a 400, which would fail the whole
 * report over an optional field.
 */
export function resolveTags(map: TagMap, names: readonly TagName[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const id = map[name];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 5);
}

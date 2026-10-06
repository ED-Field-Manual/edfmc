/**
 * Update checks for Python plugins, against their GitHub repositories.
 *
 * Plugins do not say where they come from, and most never publish a release.
 * So this works in two steps, each with fallbacks, and says "unknown" rather
 * than guessing when neither step finds an answer.
 *
 * **Which repo.** In order: a link the commander pasted; the `origin` of a
 * plugin cloned with git; the community plugin index (EDMC's wiki "Plugins"
 * page, which lists SpanshRouter as norohind's fork); a GitHub link in the
 * plugin's README that names it.
 *
 * **Which version.** The latest GitHub release if there is one. Otherwise the
 * version the plugin states on its default branch: a bare `version.json`
 * (SpanshRouter) or `plugin_version` / `__version__` in `load.py`
 * (ConstructionTracker), found anywhere in the repo, shallowest first, because
 * repos do not always lay the plugin out the way it is installed.
 *
 * Read-only, and notify-only: nothing is downloaded into the plugin folder.
 * Replacing a plugin's folder would also replace data it keeps there.
 */

/** A GitHub repository, as `owner/name`. */
export interface Repo {
  readonly owner: string;
  readonly name: string;
}

export type RepoSource = 'pasted' | 'git' | 'index' | 'readme';

export type UpdateState =
  /** GitHub has a higher version than the installed one. */
  | 'update'
  | 'current'
  /** The installed copy is ahead of GitHub, e.g. modified locally. */
  | 'ahead'
  /** No repo found, or no version could be read from it. */
  | 'unknown';

export interface UpdateResult {
  readonly folder: string;
  readonly repo: Repo | null;
  readonly repoSource: RepoSource | null;
  readonly installed: string | null;
  readonly latest: string | null;
  /** Where `latest` was read from, for the card to say. */
  readonly latestSource: 'release' | 'version.json' | 'load.py' | null;
  readonly state: UpdateState;
  readonly checkedAt: string;
  /** Why the state is unknown, in words. */
  readonly reason: string | null;
}

/** The community plugin index: EDMC's wiki page listing plugins. */
export const PLUGIN_INDEX_URL = 'https://raw.githubusercontent.com/wiki/EDCD/EDMarketConnector/Plugins.md';

/** Links to these are about the host, not the plugin. */
const NOT_A_PLUGIN = new Set(['edcd/edmarketconnector']);

/** Parse `owner/name` out of a GitHub URL or a bare `owner/name`. */
export function parseRepo(text: string): Repo | null {
  const t = text.trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(t) ??
    /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(t) ??
    /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(t);
  if (!m) return null;
  return { owner: m[1]!, name: m[2]! };
}

export function repoKey(r: Repo): string {
  return `${r.owner}/${r.name}`.toLowerCase();
}

/**
 * Fold a name for comparison: case, punctuation and the common `EDMC` prefix
 * all vary between a plugin's folder, its display name and its repo.
 * `EDMC_SpanshRouter`, `SpanshRouter` and `spansh-router` all become
 * `spanshrouter`.
 */
export function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^edmc/, '');
}

/** Every GitHub repo link in a piece of Markdown, with its link text if any. */
function githubLinks(markdown: string): Array<{ text: string | null; repo: Repo }> {
  const out: Array<{ text: string | null; repo: Repo }> = [];
  const seen = new Set<string>();
  const re = /(?:\[([^\]]*)\]\()?(https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/g;
  for (const m of markdown.matchAll(re)) {
    const repo = parseRepo(m[2]!);
    if (!repo) continue;
    const key = repoKey(repo);
    if (NOT_A_PLUGIN.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: m[1] ?? null, repo });
  }
  return out;
}

/** The names a plugin goes by: its folder and the name it reports. */
function namesOf(plugin: { folder: string; name: string }): Set<string> {
  return new Set([foldName(plugin.folder), foldName(plugin.name)].filter((n) => n.length > 0));
}

/** Find a plugin in the community index, by its link text or its repo name. */
export function repoFromIndex(index: string, plugin: { folder: string; name: string }): Repo | null {
  const names = namesOf(plugin);
  for (const link of githubLinks(index)) {
    if (names.has(foldName(link.repo.name))) return link.repo;
    if (link.text !== null && names.has(foldName(link.text))) return link.repo;
  }
  return null;
}

/**
 * A repo linked from the plugin's README that is plausibly the plugin itself:
 * its name matches the plugin's. A README links all sorts of things (EDMC,
 * Spansh, other plugins), so an unrelated link is never taken on its own.
 */
export function repoFromReadme(readme: string | null, plugin: { folder: string; name: string }): Repo | null {
  if (!readme) return null;
  const names = namesOf(plugin);
  for (const link of githubLinks(readme)) {
    if (names.has(foldName(link.repo.name))) return link.repo;
  }
  return null;
}

/** The version string a `load.py` states, or null. */
export function versionFromLoadPy(source: string): string | null {
  const m = /^\s*(?:plugin_version|__version__|VERSION)\s*=\s*['"]([^'"]+)['"]/m.exec(source);
  return m ? m[1]!.trim() : null;
}

/** `version.json` is usually a bare string ("3.1.0"), sometimes JSON with a field. */
export function versionFromVersionJson(text: string): string | null {
  const t = text.trim();
  try {
    const v = JSON.parse(t) as unknown;
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const field = (v as Record<string, unknown>)['version'];
      if (typeof field === 'string' && field.trim()) return field.trim();
    }
  } catch {
    // Not JSON: SpanshRouter's is the bare text 3.1.0.
  }
  return /^v?\d+(\.\d+)*([-+.][A-Za-z0-9.]+)?$/.test(t) ? t : null;
}

/**
 * Compare two versions numerically, part by part: 1.10.0 is above 1.9.2.
 * Returns null when either is not a dotted number, so an unusual scheme is
 * reported as unknown rather than ordered by guesswork.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const core = v.trim().replace(/^v/i, '').split(/[-+ ]/)[0]!;
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split('.').map(Number);
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function stateFor(installed: string | null, latest: string | null): UpdateState {
  if (!installed || !latest) return 'unknown';
  const c = compareVersions(latest, installed);
  if (c === null) return 'unknown';
  return c > 0 ? 'update' : c < 0 ? 'ahead' : 'current';
}

/* --------------------------------------------------------------- fetching */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'EDFMCompanion',
};

async function getJson(fetchImpl: Fetch, url: string): Promise<unknown | null> {
  const r = await fetchImpl(url, { headers: HEADERS });
  if (!r.ok) return null;
  return (await r.json()) as unknown;
}

async function getText(fetchImpl: Fetch, url: string): Promise<string | null> {
  const r = await fetchImpl(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!r.ok) return null;
  return r.text();
}

/** The latest version on GitHub and where it came from, or nulls. */
export async function latestVersion(
  fetchImpl: Fetch,
  repo: Repo,
): Promise<{ version: string | null; source: UpdateResult['latestSource'] }> {
  const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;

  const release = await getJson(fetchImpl, `${base}/releases/latest`);
  const tag = release && typeof release === 'object' ? (release as Record<string, unknown>)['tag_name'] : null;
  if (typeof tag === 'string' && tag.trim()) return { version: tag.trim().replace(/^v/i, ''), source: 'release' };

  // No release: read what the default branch states. The tree says where the
  // files are; a repo often nests the plugin a folder deeper than it installs.
  const tree = await getJson(fetchImpl, `${base}/git/trees/HEAD?recursive=1`);
  const paths =
    tree && typeof tree === 'object' && Array.isArray((tree as Record<string, unknown>)['tree'])
      ? ((tree as { tree: Array<{ path?: unknown; type?: unknown }> }).tree
          .filter((e) => e.type === 'blob' && typeof e.path === 'string')
          .map((e) => e.path as string))
      : [];
  const shallowest = (file: string) =>
    paths
      .filter((p) => p === file || p.endsWith(`/${file}`))
      .sort((a, b) => a.split('/').length - b.split('/').length)[0];

  const raw = (path: string) =>
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${path.split('/').map(encodeURIComponent).join('/')}`;

  const vj = shallowest('version.json');
  if (vj) {
    const text = await getText(fetchImpl, raw(vj));
    const v = text === null ? null : versionFromVersionJson(text);
    if (v) return { version: v.replace(/^v/i, ''), source: 'version.json' };
  }
  const lp = shallowest('load.py');
  if (lp) {
    const text = await getText(fetchImpl, raw(lp));
    const v = text === null ? null : versionFromLoadPy(text);
    if (v) return { version: v.replace(/^v/i, ''), source: 'load.py' };
  }
  return { version: null, source: null };
}

export interface CheckablePlugin {
  readonly folder: string;
  readonly name: string;
  readonly version: string | null;
  readonly readme: string | null;
  /** `origin` from the plugin's own .git/config, if it was cloned. */
  readonly gitRemote: string | null;
}

/** Find the repo for one plugin, from the most to the least deliberate source. */
export function findRepo(
  plugin: CheckablePlugin,
  pasted: string | undefined,
  index: string | null,
): { repo: Repo; source: RepoSource } | null {
  const fromPasted = pasted ? parseRepo(pasted) : null;
  if (fromPasted) return { repo: fromPasted, source: 'pasted' };
  const fromGit = plugin.gitRemote ? parseRepo(plugin.gitRemote) : null;
  if (fromGit) return { repo: fromGit, source: 'git' };
  const fromIndex = index ? repoFromIndex(index, plugin) : null;
  if (fromIndex) return { repo: fromIndex, source: 'index' };
  const fromReadme = repoFromReadme(plugin.readme, plugin);
  if (fromReadme) return { repo: fromReadme, source: 'readme' };
  return null;
}

/** Check every plugin. One failing plugin never stops the others. */
export async function checkForUpdates(
  fetchImpl: Fetch,
  plugins: readonly CheckablePlugin[],
  pasted: Readonly<Record<string, string>>,
  now: () => Date = () => new Date(),
): Promise<UpdateResult[]> {
  let index: string | null = null;
  try {
    index = await getText(fetchImpl, PLUGIN_INDEX_URL);
  } catch {
    index = null;
  }

  const results: UpdateResult[] = [];
  for (const plugin of plugins) {
    const checkedAt = now().toISOString();
    const found = findRepo(plugin, pasted[plugin.folder], index);
    if (!found) {
      results.push({
        folder: plugin.folder,
        repo: null,
        repoSource: null,
        installed: plugin.version,
        latest: null,
        latestSource: null,
        state: 'unknown',
        checkedAt,
        reason: 'Could not tell which GitHub repository this plugin comes from.',
      });
      continue;
    }
    try {
      const { version, source } = await latestVersion(fetchImpl, found.repo);
      const state = stateFor(plugin.version, version);
      results.push({
        folder: plugin.folder,
        repo: found.repo,
        repoSource: found.source,
        installed: plugin.version,
        latest: version,
        latestSource: source,
        state,
        checkedAt,
        reason:
          state !== 'unknown'
            ? null
            : version === null
              ? 'The repository states no version the Companion can read.'
              : plugin.version === null
                ? 'This copy of the plugin states no version to compare.'
                : 'The versions are not in a form that can be compared.',
      });
    } catch (err) {
      results.push({
        folder: plugin.folder,
        repo: found.repo,
        repoSource: found.source,
        installed: plugin.version,
        latest: null,
        latestSource: null,
        state: 'unknown',
        checkedAt,
        reason: `GitHub could not be reached (${String(err)}).`,
      });
    }
  }
  return results;
}

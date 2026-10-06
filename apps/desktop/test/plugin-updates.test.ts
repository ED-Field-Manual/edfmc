import { describe, expect, it } from 'vitest';

import {
  PLUGIN_INDEX_URL,
  checkForUpdates,
  compareVersions,
  findRepo,
  foldName,
  latestVersion,
  parseRepo,
  repoFromIndex,
  repoFromReadme,
  stateFor,
  versionFromLoadPy,
  versionFromVersionJson,
} from '../src/lib/pluginUpdates';

/*
 * Fixtures are real: the SpanshRouter line of EDMC's wiki "Plugins" page, and
 * the files of the commander's two installed plugins (2026-10-06).
 */
const INDEX_LINE =
  '* [EDMC_SpanshRouter](https://github.com/norohind/EDMC_SpanshRouter) - Automatically copies to your clipboard the next waypoint on a route you planned using [Spansh](https://www.spansh.co.uk/plotter) Neutron Plotter.';
const SPANSH_README =
  "# EDMC_SpanshRouter\n## Note on norohind's fork\n... [this issue](https://github.com/norohind/EDMC_SpanshRouter/issues/6)";
const TRACKER_README =
  '# EDMC Construction Tracker Plugin\nAn [Elite Dangerous Market Connector (EDMC)](https://github.com/EDCD/EDMarketConnector) plugin that tracks construction site material requirements';
const SPANSH = { folder: 'SpanshRouter', name: 'SpanshRouter', version: '3.1.0', readme: SPANSH_README, gitRemote: null };
const TRACKER = {
  folder: 'ConstructionTracker',
  name: 'Construction Tracker',
  version: '1.4.0',
  readme: TRACKER_README,
  gitRemote: null,
};

describe('finding the repository', () => {
  it('reads owner/name from the forms a link takes', () => {
    expect(parseRepo('https://github.com/norohind/EDMC_SpanshRouter')).toEqual({ owner: 'norohind', name: 'EDMC_SpanshRouter' });
    expect(parseRepo('https://github.com/norohind/EDMC_SpanshRouter/issues/6')?.name).toBe('EDMC_SpanshRouter');
    expect(parseRepo('git@github.com:Greybaer/EDMC-ConstructionTracker.git')?.name).toBe('EDMC-ConstructionTracker');
    expect(parseRepo('Greybaer/EDMC-ConstructionTracker')?.owner).toBe('Greybaer');
    expect(parseRepo('https://www.spansh.co.uk/plotter')).toBeNull();
  });

  it('folds the EDMC prefix and punctuation that names vary by', () => {
    expect(foldName('EDMC_SpanshRouter')).toBe('spanshrouter');
    expect(foldName('EDMC-ConstructionTracker')).toBe(foldName('Construction Tracker'));
  });

  it('finds SpanshRouter in the community index', () => {
    expect(repoFromIndex(INDEX_LINE, SPANSH)).toEqual({ owner: 'norohind', name: 'EDMC_SpanshRouter' });
  });

  it('takes a README link only when it names the plugin', () => {
    expect(repoFromReadme(SPANSH_README, SPANSH)?.owner).toBe('norohind');
    // ConstructionTracker's README links only EDMC itself, which is not the plugin.
    expect(repoFromReadme(TRACKER_README, TRACKER)).toBeNull();
  });

  it('prefers a pasted link, then git, then the index, then the README', () => {
    expect(findRepo(TRACKER, 'https://github.com/Greybaer/EDMC-ConstructionTracker', INDEX_LINE)?.source).toBe('pasted');
    expect(findRepo({ ...SPANSH, gitRemote: 'https://github.com/someone/fork.git' }, undefined, INDEX_LINE)?.source).toBe('git');
    expect(findRepo(SPANSH, undefined, INDEX_LINE)?.source).toBe('index');
    expect(findRepo(SPANSH, undefined, null)?.source).toBe('readme');
    expect(findRepo(TRACKER, undefined, INDEX_LINE)).toBeNull();
  });
});

describe('reading and comparing versions', () => {
  it('reads the versions as the two plugins state them', () => {
    expect(versionFromVersionJson('3.1.0')).toBe('3.1.0'); // SpanshRouter: bare text
    expect(versionFromVersionJson('{"version": "2.0"}')).toBe('2.0');
    expect(versionFromLoadPy('plugin_name = "Construction Tracker"\nplugin_version = "1.4.0"\n')).toBe('1.4.0');
    expect(versionFromLoadPy('print("no version here")')).toBeNull();
  });

  it('compares numerically, part by part', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('v3.1.0', '3.1')).toBe(0);
    expect(compareVersions('nightly', '3.1.0')).toBeNull();
  });

  it('says ahead, not out of date, when the installed copy is newer', () => {
    // The commander's ConstructionTracker is 1.4.0 (changed locally); GitHub's is 1.3.0.
    expect(stateFor('1.4.0', '1.3.0')).toBe('ahead');
    expect(stateFor('3.1.0', '3.1.0')).toBe('current');
    expect(stateFor('3.1.0', '3.2.0')).toBe('update');
    expect(stateFor(null, '3.2.0')).toBe('unknown');
  });
});

/** A stand-in GitHub serving fixed responses by URL. */
function fakeGitHub(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, asked };
}

describe('asking GitHub', () => {
  it('uses the latest release when there is one', async () => {
    const gh = fakeGitHub({
      'https://api.github.com/repos/a/b/releases/latest': { tag_name: 'v2.0.1' },
    });
    expect(await latestVersion(gh.fetchImpl, { owner: 'a', name: 'b' })).toEqual({ version: '2.0.1', source: 'release' });
  });

  it('otherwise finds load.py wherever the repo keeps it', async () => {
    // Greybaer/EDMC-ConstructionTracker has no release and nests load.py one
    // folder deeper than it installs.
    const gh = fakeGitHub({
      'https://api.github.com/repos/Greybaer/EDMC-ConstructionTracker/git/trees/HEAD?recursive=1': {
        tree: [
          { path: 'EDMCConstructionTracker', type: 'tree' },
          { path: 'EDMCConstructionTracker/load.py', type: 'blob' },
          { path: 'README.md', type: 'blob' },
        ],
      },
      'https://raw.githubusercontent.com/Greybaer/EDMC-ConstructionTracker/HEAD/EDMCConstructionTracker/load.py':
        'plugin_version = "1.3.0"\n',
    });
    expect(await latestVersion(gh.fetchImpl, { owner: 'Greybaer', name: 'EDMC-ConstructionTracker' })).toEqual({
      version: '1.3.0',
      source: 'load.py',
    });
  });

  it('checks both plugins end to end, and one unknown does not stop the other', async () => {
    const gh = fakeGitHub({
      [PLUGIN_INDEX_URL]: INDEX_LINE,
      'https://api.github.com/repos/norohind/EDMC_SpanshRouter/git/trees/HEAD?recursive=1': {
        tree: [{ path: 'version.json', type: 'blob' }],
      },
      'https://raw.githubusercontent.com/norohind/EDMC_SpanshRouter/HEAD/version.json': '3.1.0',
    });
    const results = await checkForUpdates(gh.fetchImpl, [TRACKER, SPANSH], {});
    expect(results.find((r) => r.folder === 'SpanshRouter')).toMatchObject({
      state: 'current',
      latest: '3.1.0',
      latestSource: 'version.json',
      repoSource: 'index',
    });
    expect(results.find((r) => r.folder === 'ConstructionTracker')).toMatchObject({
      state: 'unknown',
      repo: null,
    });
    // Only GitHub was asked, and only to read.
    expect(gh.asked.every((u) => u.startsWith('https://api.github.com/repos/') || u.startsWith('https://raw.githubusercontent.com/'))).toBe(true);
  });
});

describe('a route a plugin publishes', () => {
  it('keeps only well-formed fields', async () => {
    const { readPluginRoute } = await import('../src/lib/pythonPlugins');
    // Verbatim from Router's publish, through the plugin host (2026-10-06).
    const r = readPluginRoute({
      next: 'PSR J1752-2806',
      nextIsNeutron: true,
      destination: 'Colonia',
      jumpsLeft: 166,
      totalJumps: 166,
      waypoint: 2,
      waypoints: 129,
      distanceLeft: 21629.3877108911,
      finished: false,
    });
    expect(r).toEqual({
      next: 'PSR J1752-2806',
      nextIsNeutron: true,
      destination: 'Colonia',
      jumpsLeft: 166,
      waypoint: 2,
      waypoints: 129,
      finished: false,
    });
    expect(readPluginRoute(null)).toBeNull();
    expect(readPluginRoute({ next: 42, jumpsLeft: -3 })).toMatchObject({ next: null, jumpsLeft: 0 });
  });
});

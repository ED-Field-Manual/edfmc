#!/usr/bin/env node
/**
 * Fetch the Python runtime bundled with the desktop app for Python plugins.
 *
 * Puts a portable CPython (with tkinter) and the libraries plugins expect into
 * `apps/desktop/src-tauri/python/`, which `tauri.conf.json` ships as a resource
 * and `plugin_host.rs` prefers over any installed Python.
 *
 * Everything is pinned by exact file and SHA-256. A download that does not
 * match is deleted and the script fails; nothing unverified is unpacked. To
 * upgrade, change a pin here and its hash, taken from the publisher (GitHub's
 * release asset digest, PyPI's `digests.sha256`), never from the downloaded file.
 *
 * Run from the repository root:  node scripts/fetch-python-runtime.mjs
 * The output folder is not committed; run this before `tauri build`.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(ROOT, 'apps', 'desktop', 'src-tauri');
const OUT = join(TAURI, 'python');
const CACHE = join(TAURI, 'target', 'python-downloads');

/** Portable CPython from Astral's python-build-standalone. Includes tkinter. */
const PYTHON = {
  file: 'cpython-3.13.16+20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
  url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.13.16%2B20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
  sha256: 'ec43f1a85c29f147d7ae2d13218c52c70b24a983a82ab22d6c607c0593060e10',
};

/** `requests` and its dependencies, from PyPI. */
const WHEELS = [
  {
    file: 'requests-2.34.2-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/a0/f4/c67b0b3f1b9245e8d266f0f112c500d50e5b4e83cb6f3b71b6528104182a/requests-2.34.2-py3-none-any.whl',
    sha256: '2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0',
  },
  {
    file: 'urllib3-2.8.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl',
    sha256: '0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3',
  },
  {
    file: 'idna-3.20-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/58/a2/bb081bab032533a855d44de1d56f8e8426114ff1ba5d1f07a438a0a654f8/idna-3.20-py3-none-any.whl',
    sha256: 'ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c',
  },
  {
    file: 'certifi-2026.7.22-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/0b/a7/71ac2cff56fec219ed242bb11b8efb69fcc4bec75db06fb7bfe35de520e6/certifi-2026.7.22-py3-none-any.whl',
    sha256: '62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775',
  },
  {
    file: 'charset_normalizer-3.5.2-cp313-cp313-win_amd64.whl',
    url: 'https://files.pythonhosted.org/packages/9c/76/b8ec57f4e9ee3253541abf95e4a462c0175fe8032dcd070f1f2421240942/charset_normalizer-3.5.2-cp313-cp313-win_amd64.whl',
    sha256: '78456a747de8dc58360ffa581f30a002baf5aa28cb262536545e91f113ed7639',
  },
];

const STAMP = join(OUT, '.edfmc-runtime.json');

/**
 * Windows' own bsdtar, which reads .tar.gz and .zip alike. A GNU tar earlier on
 * PATH (Git Bash ships one) reads `D:\...` as a remote host and fails.
 */
const TAR =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function fetchVerified({ file, url, sha256: expected }) {
  const path = join(CACHE, file);
  if (existsSync(path) && sha256(path) === expected) return path;

  console.log(`Downloading ${file}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));

  const actual = sha256(path);
  if (actual !== expected) {
    rmSync(path, { force: true });
    throw new Error(`${file}: checksum mismatch (expected ${expected}, got ${actual}). Nothing was unpacked.`);
  }
  return path;
}

async function main() {
  const wanted = JSON.stringify({ python: PYTHON.sha256, wheels: WHEELS.map((w) => w.sha256) });
  if (existsSync(STAMP) && readFileSync(STAMP, 'utf8') === wanted) {
    console.log('Python runtime already up to date.');
    return;
  }

  mkdirSync(CACHE, { recursive: true });
  const archive = await fetchVerified(PYTHON);
  const wheels = [];
  for (const wheel of WHEELS) wheels.push(await fetchVerified(wheel));

  // The archive's top-level folder is `python/`, so it unpacks into OUT.
  rmSync(OUT, { recursive: true, force: true });
  execFileSync(TAR, ['-xzf', archive, '-C', TAURI], { stdio: 'inherit' });

  // Not needed to run plugins: headers and import libraries for compiling
  // extensions, pip and its bootstrapper, and the IDLE editor. About 18 MB.
  for (const rel of ['include', 'libs', join('Lib', 'ensurepip'), join('Lib', 'idlelib')]) {
    rmSync(join(OUT, rel), { recursive: true, force: true });
  }
  for (const name of readdirSync(join(OUT, 'Lib', 'site-packages'))) {
    if (name === 'pip' || name.startsWith('pip-')) {
      rmSync(join(OUT, 'Lib', 'site-packages', name), { recursive: true, force: true });
    }
  }

  // A wheel is a zip laid out for site-packages; unpacking it is installing it.
  const sitePackages = join(OUT, 'Lib', 'site-packages');
  mkdirSync(sitePackages, { recursive: true });
  for (const wheel of wheels) {
    execFileSync(TAR, ['-xf', wheel, '-C', sitePackages], { stdio: 'inherit' });
  }

  // Prove the result works before anything ships it.
  const python = join(OUT, 'python.exe');
  const check = execFileSync(
    python,
    ['-c', 'import tkinter, requests, ssl; print(tkinter.TkVersion, requests.__version__)'],
    { encoding: 'utf8' },
  ).trim();
  console.log(`Python runtime ready: tkinter ${check.split(' ')[0]}, requests ${check.split(' ')[1]}`);

  writeFileSync(STAMP, wanted);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});

/**
 * EDFM wiki URL construction.
 *
 * Verified 2026-09-01: EDFM runs MediaWiki 1.46.0 at https://edfieldmanual.com/
 * with `articlepath = /wiki/$1` and `api.php` at the site root.
 *
 * Rules store page *titles*, not URLs, so a change of domain or path scheme is a
 * one-line change here rather than an edit to every rule.
 */

export interface WikiConfig {
  readonly base: string;
  /** MediaWiki `articlepath`, with `$1` where the title goes. */
  readonly articlePath: string;
}

export const EDFM_WIKI: WikiConfig = {
  base: 'https://edfieldmanual.com',
  articlePath: '/wiki/$1',
};

/**
 * Canonical URL for a wiki page title.
 *
 * MediaWiki maps spaces to underscores. Everything else is percent-encoded, but
 * `/` and `:` are left intact because they are meaningful in titles such as
 * `CMDR Fima/Privacy Policy`.
 *
 * A `#` separates an optional section anchor, as in
 * `Engineering Materials#Material Traders`. This is unambiguous: MediaWiki
 * forbids `#` in page titles outright, so it can only ever be a fragment. Linking
 * to the relevant section matters when one page covers several situations the
 * rules distinguish -- the three kinds of Material Trader share a page.
 */
export function pageUrl(title: string, config: WikiConfig = EDFM_WIKI): string {
  const hash = title.indexOf('#');
  const titlePart = hash === -1 ? title : title.slice(0, hash);
  const fragment = hash === -1 ? '' : title.slice(hash + 1);

  const encoded = encodePart(titlePart);
  // An empty fragment (`Page#`) is dropped rather than emitting a bare trailing
  // `#`, which would be a URL that looks broken for no benefit.
  const suffix = fragment.trim().length > 0 ? '#' + encodePart(fragment) : '';
  return config.base + config.articlePath.replace('$1', encoded) + suffix;
}

function encodePart(part: string): string {
  const normalised = part.trim().replace(/\s+/g, '_');
  return encodeURIComponent(normalised).replace(/%2F/g, '/').replace(/%3A/g, ':');
}

/**
 * An absolute URL that is safe to hand to the system browser, or null.
 *
 * Rule sets are untrusted input (plugins today, a server later), and whatever
 * this returns is opened by the shell. So: parsed rather than pattern-matched,
 * `https:` only (no `file:`, custom schemes, or plain `http:` that could be
 * rewritten in transit), and no embedded credentials, which exist mainly to
 * disguise where a link really goes (`https://edfieldmanual.com@evil.example`).
 * Returned in the parser's normalised form, so what is checked is what opens.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hostname === '') return null;
  return parsed.href;
}

/** Resolve a resource to a URL, preferring an explicit absolute URL. */
export function resourceUrl(
  resource: { readonly page?: string; readonly url?: string },
  config: WikiConfig = EDFM_WIKI,
): string | null {
  if (resource.url !== undefined) return safeExternalUrl(resource.url);
  if (typeof resource.page !== 'string' || resource.page.trim().length === 0) return null;
  return pageUrl(resource.page, config);
}

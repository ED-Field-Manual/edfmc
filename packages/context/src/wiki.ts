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
 */
export function pageUrl(title: string, config: WikiConfig = EDFM_WIKI): string {
  const normalised = title.trim().replace(/\s+/g, '_');
  const encoded = encodeURIComponent(normalised).replace(/%2F/g, '/').replace(/%3A/g, ':');
  return config.base + config.articlePath.replace('$1', encoded);
}

/** Resolve a resource to a URL, preferring an explicit absolute URL. */
export function resourceUrl(
  resource: { readonly page?: string; readonly url?: string },
  config: WikiConfig = EDFM_WIKI,
): string | null {
  if (resource.url) {
    // Only http(s). A rule set is untrusted input and must not be able to hand the
    // shell a `file:` or custom-scheme URL to open.
    return /^https?:\/\//i.test(resource.url) ? resource.url : null;
  }
  return resource.page ? pageUrl(resource.page, config) : null;
}

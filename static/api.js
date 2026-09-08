// api.js — reads the two config namespaces this app needs.
//
// config.swee.net is the source of truth. `sites` says which properties
// exist and which scheme each one is on; `bin_schemes` holds the schemes
// themselves. Both are read with the signed-in user's token — the server
// hosting this page never sees it.
//
// Documents are cached in localStorage and rendered immediately on the next
// visit, then refreshed in the background. A bin app that shows nothing
// until a network round-trip completes is a bin app you stop opening.

import { authedFetch } from './auth.js';
import { settings } from './settings.js';

const CACHE_KEY = 'bins.config_cache';
const CACHE_VERSION = 1;

async function readNamespace(namespace) {
  const url = `${settings.config_url}/api/v1/config/${encodeURIComponent(namespace)}`;
  const response = await authedFetch(url);

  if (!response.ok) {
    // The config service does not distinguish "missing" from "you may not
    // read it" — deliberately, so namespace names are not leaked. Say what
    // is actually knowable rather than guessing.
    if (response.status === 404) {
      throw new Error(`The "${namespace}" config is not visible to your account.`);
    }
    throw new Error(`Could not read "${namespace}" (HTTP ${response.status}).`);
  }
  return response.json();
}

/**
 * Fold the two raw config documents into the shape the app renders.
 *
 * This is the boundary between config's shape and the app's. The `sites`
 * namespace is shared with other swee.net apps and carries fields this one
 * has no use for — coordinates, MQTT topics, other namespace names — so
 * only `id`, `name` and `bin_scheme` are read, and `bin_scheme` becomes a
 * resolved `scheme` object the views can render directly.
 *
 * Sites with no `bin_scheme`, or one naming a scheme that does not exist,
 * are dropped: a bin app has nothing to say about a property that is not on
 * a collection round, and an empty switcher is honest where a broken card
 * would not be.
 *
 * Pure, and exported for that reason — it is the one piece of real logic in
 * this module, and it is worth testing without a browser.
 */
export function resolveSites(sitesDoc, schemesDoc) {
  const schemes = (schemesDoc && schemesDoc.schemes) || {};
  const sites = Array.isArray(sitesDoc && sitesDoc.sites) ? sitesDoc.sites : [];

  return sites
    .filter((site) => site && site.id && site.bin_scheme && schemes[site.bin_scheme])
    .map((site) => ({
      id: site.id,
      name: site.name || site.id,
      schemeId: site.bin_scheme,
      scheme: schemes[site.bin_scheme],
    }));
}

/** Read both namespaces and resolve them. Caches on success. */
export async function loadSites() {
  const [sitesDoc, schemesDoc] = await Promise.all([
    readNamespace(settings.sites_namespace),
    readNamespace(settings.schemes_namespace),
  ]);

  const data = {
    sites: resolveSites(sitesDoc, schemesDoc),
    fetchedAt: new Date().toISOString(),
  };
  cache(data);
  return data;
}

// ── Cache ───────────────────────────────────────────────────────────────

function cache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: CACHE_VERSION, data }));
  } catch {
    /* private mode, or the quota is full — the app still works online */
  }
}

/** The last successful read, or null. Shape-checked, so a stale or
 *  hand-edited entry cannot crash the first render. */
export function cached() {
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!stored || stored.version !== CACHE_VERSION) return null;
    if (!stored.data || !Array.isArray(stored.data.sites)) return null;
    return stored.data;
  } catch {
    return null;
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to do */
  }
}

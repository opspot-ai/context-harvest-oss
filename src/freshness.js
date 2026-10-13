import { statDocument, resolveRoot } from './connectors/folder.js';

/**
 * Freshness is computed here, at query time, from the source as it exists right now.
 * It is never read from a stored flag -- THREAT-MODEL.md T6.
 *
 *   fresh       a scoped, guarded read matches the harvested size, mtime AND content hash
 *   stale       the file is reachable-rooted but changed, or no longer present
 *   unverified  the source root itself is unreachable, so we cannot check at all
 *
 * Size and mtime are the cheap checks promised by the frozen slice. A content hash closes the
 * ordinary `touch -r`, `cp -p`, same-size rename and root-swap routes that can preserve both.
 */
export function makeFreshnessProbe() {
  const rootCache = new Map();   // source_id -> realRoot | null
  const statCache = new Map();   // source_id + ' ' + uri -> stat | null
  const remainingBySource = new Map(); // bounded total source reads per query

  const rootFor = (source) => {
    if (rootCache.has(source.id)) return rootCache.get(source.id);
    let real = null;
    try { real = resolveRoot(source.root, { mustBeCanonical: true }); } catch { real = null; }
    rootCache.set(source.id, real);
    return real;
  };

  return function freshnessFor(source, document, at = Date.now()) {
    const harvestedAtMs = Date.parse(document.harvested_at);
    const base = {
      harvested_at: document.harvested_at,
      source_modified_at: document.source_modified_at,
      age_seconds: Math.max(0, Math.round((at - harvestedAtMs) / 1000))
    };

    const realRoot = rootFor(source);
    if (!realRoot) return { ...base, state: 'unverified' };

    const cacheKey = `${source.id} ${document.uri}`;
    let stat;
    if (statCache.has(cacheKey)) {
      stat = statCache.get(cacheKey);
    } else {
      const scope = source.scope;
      const remaining = remainingBySource.get(source.id) ?? scope.max_total_bytes;
      // A fresh file must still have its harvested size. Reserve that amount before probing,
      // including failed probes, so concurrent growth cannot evade the per-query source budget.
      const budget = Math.min(scope.max_file_bytes, remaining, document.byte_size);
      remainingBySource.set(source.id, remaining - budget);
      stat = budget > 0 ? statDocument(realRoot, document.uri, scope, budget) : null;
      statCache.set(cacheKey, stat);
    }
    if (!stat) return { ...base, state: 'stale' };

    const sizeMatches = stat.size === document.byte_size;
    const mtimeMatches = stat.mtime_ns === document.source_mtime_ns;
    const contentMatches = stat.content_sha256 === document.content_sha256;
    if (sizeMatches && mtimeMatches && contentMatches) return { ...base, state: 'fresh' };
    return { ...base, state: 'stale', source_modified_at: stat.mtime_iso };
  };
}

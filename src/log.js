// The only logger in the process. It accepts a verb and a flat bag of primitives, and it
// refuses to emit anything that is not an id, a count, a timestamp, an outcome, or a
// bounded category string. There is no code path that logs a request body, a header, a
// filesystem path, or chunk text -- THREAT-MODEL.md T7.
const ALLOWED_KEYS = new Set([
  'verb', 'outcome', 'tenant_id', 'source_id', 'document_id', 'chunk_id', 'run_id',
  'key_id', 'document_count', 'chunk_count', 'byte_count', 'skipped_count', 'hit_count',
  'status', 'code', 'reason', 'duration_ms', 'transport', 'port', 'added', 'changed',
  'removed', 'purged'
]);

let sink = (line) => process.stderr.write(line + '\n');

export function setLogSink(fn) { sink = fn; }

export function log(fields) {
  const safe = { at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      // Bounded: an id or a category, never free text that could carry customer content.
      safe[key] = value.length > 64 ? value.slice(0, 64) : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  sink(JSON.stringify(safe));
}

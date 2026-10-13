import { badRequest } from './errors.js';

export const DEFAULT_SCOPE = Object.freeze({
  include: ['**/*'],
  exclude: [],
  max_file_bytes: 1_048_576,
  max_total_bytes: 268_435_456,
  follow_symlinks: false
});

// The customer's declared boundary. It is normalised once, stored verbatim, and enforced on
// every walk. follow_symlinks is accepted only as false in v0 -- THREAT-MODEL.md T5.
export function normalizeScope(input = {}) {
  const scope = { ...DEFAULT_SCOPE, ...input };
  const patterns = (value, name) => {
    if (!Array.isArray(value)) throw badRequest(`scope.${name}_must_be_array`);
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0) throw badRequest(`scope.${name}_must_be_strings`);
      if (item.includes('\0')) throw badRequest(`scope.${name}_invalid`);
    }
    return value.slice();
  };
  scope.include = patterns(scope.include, 'include');
  scope.exclude = patterns(scope.exclude, 'exclude');
  if (scope.include.length === 0) throw badRequest('scope.include_must_not_be_empty');

  const positiveInt = (value, name) => {
    if (!Number.isInteger(value) || value <= 0) throw badRequest(`scope.${name}_must_be_positive_integer`);
    return value;
  };
  scope.max_file_bytes = positiveInt(scope.max_file_bytes, 'max_file_bytes');
  scope.max_total_bytes = positiveInt(scope.max_total_bytes, 'max_total_bytes');

  if (scope.follow_symlinks !== false) throw badRequest('scope.follow_symlinks_must_be_false_in_v0');
  return {
    include: scope.include,
    exclude: scope.exclude,
    max_file_bytes: scope.max_file_bytes,
    max_total_bytes: scope.max_total_bytes,
    follow_symlinks: false
  };
}

import { randomBytes } from 'node:crypto';

// Crockford-ish base32 without ambiguous characters. Ids are opaque to the customer and
// unguessable, which is defence in depth. The tenant boundary is enforced in SQL, never here.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function randomId(prefix, bytes = 16) {
  const raw = randomBytes(bytes);
  let out = '';
  for (const byte of raw) out += ALPHABET[byte & 31];
  return `${prefix}_${out}`;
}

export const newTenantId = () => randomId('ten');
export const newSourceId = () => randomId('src');
export const newDocumentId = () => randomId('doc');
export const newChunkId = () => randomId('chk');
export const newRunId = () => randomId('run');
export const newKeyId = () => randomId('key');
export const newAuditId = () => randomId('aud');

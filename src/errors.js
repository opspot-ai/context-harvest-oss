// Errors carry a category and opaque ids. They never carry chunk text, file contents,
// filesystem paths, or credentials -- see THREAT-MODEL.md T7.
export class ChError extends Error {
  constructor(code, status, message, details = {}) {
    super(message);
    this.name = 'ChError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const unauthorized = (reason = 'invalid_or_revoked_key') =>
  new ChError('unauthorized', 401, 'unauthorized', { reason });
export const forbidden = (reason = 'insufficient_scope') =>
  new ChError('forbidden', 403, 'forbidden', { reason });
export const notFound = (what) => new ChError('not_found', 404, 'not_found', { what });
export const badRequest = (reason) => new ChError('bad_request', 400, 'bad_request', { reason });
export const conflict = (reason) => new ChError('conflict', 409, 'conflict', { reason });

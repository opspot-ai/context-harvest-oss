import {
  accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync,
  realpathSync, statSync
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { matchesAny } from '../glob.js';
import { badRequest } from '../errors.js';

export const KIND = 'folder';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Filesystem mtimes are read at nanosecond precision and compared at nanosecond precision.
// Truncating to milliseconds would let a same-millisecond, size-preserving rewrite read as
// fresh -- see THREAT-MODEL.md T6.
export const nsToIso = (mtimeNs) => new Date(Number(mtimeNs / 1000000n)).toISOString();

export function resolveRoot(root, { mustBeCanonical = false } = {}) {
  try {
    const real = realpathSync(root);
    // A registered root is already canonical. Do not silently broaden it when that root (or
    // one of its parents) has subsequently been replaced by a symlink.
    if (mustBeCanonical && real !== root) throw badRequest('root_unreachable');
    const stat = statSync(real);
    if (!stat.isDirectory()) throw badRequest('root_is_not_a_directory');
    // realpath/stat can succeed on a directory whose entries the process cannot inspect. Such a
    // root is unreachable for freshness purposes, not a reachable root full of stale files.
    accessSync(real, constants.R_OK | constants.X_OK);
    return real;
  } catch (err) {
    if (err?.code === 'bad_request') throw err;
    throw badRequest('root_unreachable');
  }
}

// True when `candidate` is the root itself or lies underneath it. Both arguments must already
// be fully resolved real paths. This is the containment check behind THREAT-MODEL.md T5.
export function isContained(realRoot, candidate) {
  if (candidate === realRoot) return true;
  const rel = relative(realRoot, candidate);
  return rel.length > 0 && !rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep);
}

function looksBinary(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  // Invalid UTF-8 cannot be decoded and re-encoded byte-for-byte: TextDecoder replacement
  // characters would make every locator over the affected bytes false. v0 is a text corpus, so
  // fail closed and report it with the existing binary skip category.
  return window.includes(0x00) || !isUtf8(buffer);
}

// Read in bounded blocks. A post-read size check alone cannot stop a concurrently growing file
// from consuming unbounded memory. No byte beyond the supplied budget is read, even before EOF.
export function readBoundedFile(fd, maxBytes, read = readSync) {
  const parts = [];
  let total = 0;
  while (total < maxBytes) {
    const block = Buffer.allocUnsafe(Math.min(65_536, maxBytes - total));
    const length = read(fd, block, 0, block.length, null);
    if (length === 0) break;
    parts.push(block.subarray(0, length));
    total += length;
  }
  return Buffer.concat(parts, total);
}

const FILE_IO = {
  realpath: (path) => realpathSync(path),
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path, flags) => openSync(path, flags),
  stat: (fd) => fstatSync(fd, { bigint: true }),
  read: readBoundedFile,
  close: (fd) => closeSync(fd)
};

const NOFOLLOW_READ_FLAGS = Number.isInteger(constants.O_NOFOLLOW)
  ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  : null;

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

function inspectPathChain(realRoot, candidatePath, io) {
  const rel = relative(realRoot, candidatePath);
  if (rel.length === 0 || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) {
    return { reason: 'escapes_root' };
  }

  const parts = rel.split(sep).filter(Boolean);
  const paths = [realRoot];
  for (let index = 0; index < parts.length; index += 1) {
    paths.push(join(realRoot, ...parts.slice(0, index + 1)));
  }

  const chain = [];
  try {
    for (let index = 0; index < paths.length; index += 1) {
      const stat = io.lstat(paths[index]);
      const isLeaf = index === paths.length - 1;
      if (stat.isSymbolicLink()) return { reason: 'symlink_not_followed' };
      if (isLeaf) {
        if (!stat.isFile()) return { reason: 'not_a_regular_file' };
        if (Number(stat.nlink) > 1) return { reason: 'multiple_hardlinks' };
      } else if (!stat.isDirectory()) {
        return { reason: 'path_changed_during_open' };
      }
      chain.push(stat);
    }
  } catch {
    return { reason: 'unreadable_file' };
  }
  return { chain };
}

function sameChain(left, right) {
  return left.length === right.length
    && left.every((entry, index) => sameIdentity(entry, right[index]));
}

function readOpenedFile(fd, maxFileBytes, remainingBytes, io, before = io.stat(fd)) {
  if (!before.isFile()) return { reason: 'not_a_regular_file' };
  if (Number(before.nlink) > 1) return { reason: 'multiple_hardlinks' };
  if (Number(before.size) > maxFileBytes) return { reason: 'max_file_bytes' };
  if (Number(before.size) > remainingBytes) return { reason: 'max_total_bytes' };

  const content = io.read(fd, Math.min(maxFileBytes, remainingBytes));
  const after = io.stat(fd);
  if (!after.isFile()) return { reason: 'not_a_regular_file' };
  if (Number(after.nlink) > 1) return { reason: 'multiple_hardlinks' };
  // These checks intentionally use the bytes read, not only either stat snapshot.
  if (content.length > maxFileBytes || Number(after.size) > maxFileBytes) {
    return { reason: 'max_file_bytes' };
  }
  if (content.length > remainingBytes || Number(after.size) > remainingBytes) {
    return { reason: 'max_total_bytes' };
  }
  if (!sameIdentity(before, after) || Number(after.size) !== content.length
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
    return { reason: 'file_changed_during_read' };
  }
  return { content, stat: after };
}

/**
 * Open one candidate and enforce limits against the file descriptor and the bytes actually read.
 * The descriptor pins the inode between stat and read. The post-read checks close the classic
 * stat/read growth race instead of trusting the earlier size.
 */
export function readCandidateFile(realPath, maxFileBytes, remainingBytes, io = FILE_IO) {
  let fd;
  try {
    fd = io.open(realPath, NOFOLLOW_READ_FLAGS ?? constants.O_RDONLY);
    return readOpenedFile(fd, maxFileBytes, remainingBytes, io);
  } catch {
    return { reason: 'unreadable_file' };
  } finally {
    if (fd !== undefined) {
      try { io.close(fd); } catch { /* already closed or unreadable */ }
    }
  }
}

/**
 * Resolve and open one in-root candidate without trusting the path twice. Every component's
 * device/inode identity is captured around the containment check. The leaf is then opened with
 * O_NOFOLLOW, the descriptor must be the captured leaf, and the full chain must still be the
 * captured chain before any byte is read. A moved final entry or ancestor therefore fails closed.
 */
export function readContainedCandidate(
  realRoot, candidatePath, maxFileBytes, remainingBytes, io = FILE_IO
) {
  if (NOFOLLOW_READ_FLAGS === null) return { reason: 'secure_open_unavailable' };

  const beforeResolve = inspectPathChain(realRoot, candidatePath, io);
  if (beforeResolve.reason) return beforeResolve;

  let realPath;
  try { realPath = io.realpath(candidatePath); } catch { return { reason: 'unreadable_file' }; }
  if (!isContained(realRoot, realPath)) return { reason: 'escapes_root' };

  const afterResolve = inspectPathChain(realRoot, candidatePath, io);
  if (afterResolve.reason) return afterResolve;
  if (!sameChain(beforeResolve.chain, afterResolve.chain)) {
    return { reason: 'path_changed_during_open' };
  }

  let fd;
  try {
    // Test-only fault injection lives at this exact resolve/open seam. Production FILE_IO has no
    // hook, and no path or content is emitted if a defensive probe forces an identity change.
    io.beforeOpen?.();
    fd = io.open(candidatePath, NOFOLLOW_READ_FLAGS);
    const opened = io.stat(fd);
    const expectedLeaf = afterResolve.chain[afterResolve.chain.length - 1];
    if (!sameIdentity(expectedLeaf, opened)) return { reason: 'path_changed_during_open' };

    const afterOpen = inspectPathChain(realRoot, candidatePath, io);
    if (afterOpen.reason || !sameChain(afterResolve.chain, afterOpen.chain)) {
      return { reason: 'path_changed_during_open' };
    }
    return readOpenedFile(fd, maxFileBytes, remainingBytes, io, opened);
  } catch {
    return { reason: 'unreadable_file' };
  } finally {
    if (fd !== undefined) {
      try { io.close(fd); } catch { /* already closed or unreadable */ }
    }
  }
}

/**
 * Walk the source root under the customer's declared scope.
 * Returns { files, skipped, bytes_total, truncated }.
 *
 * Nothing here follows a symlink, opens a non-regular file, or reads a byte of a file that the
 * scope excluded. Limits are applied during the walk, never after.
 */
export function walkFolder(realRoot, scope, io = FILE_IO) {
  const files = [];
  const skipped = [];
  let bytesTotal = 0;
  let truncated = false;

  const skip = (uri, reason) => skipped.push({ uri, reason });

  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      skip(relDir || '.', 'unreadable_directory');
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = join(absDir, entry.name);

      // follow_symlinks is false and not configurable in v0. A symlink is never followed and
      // never read, whether it points inside the root or outside it.
      if (entry.isSymbolicLink()) { skip(relPath, 'symlink_not_followed'); continue; }

      if (entry.isDirectory()) {
        if (matchesAny(relPath, scope.exclude)) { skip(relPath, 'excluded'); continue; }
        if (visit(absPath, relPath)) return true;
        continue;
      }

      if (!entry.isFile()) { skip(relPath, 'not_a_regular_file'); continue; }
      if (matchesAny(relPath, scope.exclude)) { skip(relPath, 'excluded'); continue; }
      if (!matchesAny(relPath, scope.include)) { skip(relPath, 'not_included'); continue; }

      const candidate = readContainedCandidate(
        realRoot, absPath, scope.max_file_bytes, scope.max_total_bytes - bytesTotal, io
      );
      if (candidate.reason === 'max_total_bytes') {
        truncated = true;
        skip(relPath, 'max_total_bytes');
        return true;
      }
      if (candidate.reason) { skip(relPath, candidate.reason); continue; }
      const { content, stat } = candidate;
      if (content.length === 0) { skip(relPath, 'empty_file'); continue; }
      if (looksBinary(content)) { skip(relPath, 'binary'); continue; }

      bytesTotal += content.length;
      files.push({
        uri: relPath,
        content,
        byte_size: content.length,
        content_sha256: sha256(content),
        source_modified_at: nsToIso(stat.mtimeNs),
        source_mtime_ns: String(stat.mtimeNs),
        size: content.length
      });
    }
    return false;
  };

  visit(realRoot, '');
  return { files, skipped, bytes_total: bytesTotal, truncated };
}

/** Inspect and hash a harvested document under the same scope and secure-open rules as harvest. */
export function statDocument(realRoot, uri, scope, remainingBytes = scope.max_total_bytes, io = FILE_IO) {
  if (typeof uri !== 'string' || isAbsolute(uri)
      || uri.split(/[\\/]/).some((part) => part === '..')) return null;
  if (!matchesAny(uri, scope.include) || matchesAny(uri, scope.exclude)) return null;
  const absPath = join(realRoot, uri);
  const candidate = readContainedCandidate(realRoot, absPath, scope.max_file_bytes, remainingBytes, io);
  if (candidate.reason) return null;
  const { content, stat } = candidate;
  return {
    size: content.length, mtime_ns: String(stat.mtimeNs), mtime_iso: nsToIso(stat.mtimeNs),
    content_sha256: sha256(content)
  };
}

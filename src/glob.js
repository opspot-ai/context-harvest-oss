// A small, deterministic glob matcher over POSIX-style relative paths.
// Written rather than imported so the walk has no dependency that could open a socket, and so
// the auditor can read the whole matching rule in one screen.
//
//   *   matches any run of characters except '/'
//   ?   matches one character except '/'
//   **  matches any run of characters including '/'
//   a leading '**/' also matches zero directories, so '**/*.md' matches 'top.md'
const ESCAPE = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern) {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        if (pattern.slice(i, i + 3) === '**/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i += 1; continue;
    }
    if (char === '?') { out += '[^/]'; i += 1; continue; }
    out += char.replace(ESCAPE, '\\$&');
    i += 1;
  }
  return new RegExp(out + '$');
}

export function matchesAny(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globToRegExp(p).test(relPath));
}

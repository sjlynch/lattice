export type CommentSyntax = {
  line?: string[];
  blockOpen?: string;
  blockClose?: string;
  // Rust: a `'` that starts a lifetime or loop label (`&'a str`, `<'a>`,
  // `'static`, `'outer: loop`) — i.e. `'` + identifier NOT closed as a char
  // literal (`'a'`, `'\n'`) — is code, not a string opener. Without it the
  // strip pass read `'a` as a string running to the next quote and blanked
  // real code in between. Only consulted by `strip.ts`.
  quoteLifetimes?: boolean;
};

export const COMMENT_BY_EXT: Record<string, CommentSyntax> = {
  '.ts': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.tsx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.js': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.jsx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.mjs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cjs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.go': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.rs': { line: ['//'], blockOpen: '/*', blockClose: '*/', quoteLifetimes: true },
  '.java': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.kt': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.kts': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.scala': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cs': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.c': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cc': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cpp': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.cxx': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.h': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.hpp': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.swift': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.dart': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.php': { line: ['//', '#'], blockOpen: '/*', blockClose: '*/' },
  '.py': { line: ['#'] },
  '.pyi': { line: ['#'] },
  '.rb': { line: ['#'] },
  '.sh': { line: ['#'] },
  '.bash': { line: ['#'] },
  '.zsh': { line: ['#'] },
  '.ps1': { line: ['#'] },
  '.r': { line: ['#'] },
  '.toml': { line: ['#'] },
  '.yaml': { line: ['#'] },
  '.yml': { line: ['#'] },
  '.sql': { line: ['--'], blockOpen: '/*', blockClose: '*/' },
  '.lua': { line: ['--'], blockOpen: '--[[', blockClose: ']]' },
  '.html': { blockOpen: '<!--', blockClose: '-->' },
  '.xml': { blockOpen: '<!--', blockClose: '-->' },
  '.css': { blockOpen: '/*', blockClose: '*/' },
  '.scss': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.sass': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
  '.less': { line: ['//'], blockOpen: '/*', blockClose: '*/' },
};

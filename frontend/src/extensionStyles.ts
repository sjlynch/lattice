// Single source of truth for how a file extension renders in the
// 3D graph and in the Legend. Shape + color(s) are shared.

export type Shape = 'circle' | 'square' | 'diamond' | 'hexagon' | 'triangle';

export type ExtStyle = {
  ext: string;       // canonical key, includes the leading dot ('.ts')
  label: string;     // human-readable language name
  shape: Shape;
  color1: string;
  color2?: string;   // optional — diagonal split (top-left = color2, bottom-right = color1)
};

// Saturated, language-canonical palette. Shapes follow these rules:
//   circle    — general source (default)
//   square    — Python + structured data formats
//   diamond   — Ruby family (red gem) + Scala (rotated diamond glyph)
//   hexagon   — systems / native (Rust gear, C/C++/Zig)
//   triangle  — UI components (Vue/Svelte/Astro/JSX/TSX) + Kotlin (logo wedge)
export const EXT_STYLES: Record<string, ExtStyle> = {
  // ---- TypeScript / JavaScript family ----
  '.ts':     { ext: '.ts',     label: 'TypeScript',        shape: 'circle',   color1: '#3178c6' },
  '.tsx':    { ext: '.tsx',    label: 'TS React',          shape: 'triangle', color1: '#3178c6', color2: '#61dafb' },
  '.js':     { ext: '.js',     label: 'JavaScript',        shape: 'circle',   color1: '#f7df1e' },
  '.mjs':    { ext: '.mjs',    label: 'JS Module',         shape: 'circle',   color1: '#f7df1e' },
  '.cjs':    { ext: '.cjs',    label: 'CommonJS',          shape: 'circle',   color1: '#f7df1e' },
  '.jsx':    { ext: '.jsx',    label: 'React',             shape: 'triangle', color1: '#61dafb' },

  // ---- Python (square + blue/yellow split per logo) ----
  '.py':     { ext: '.py',     label: 'Python',            shape: 'square',   color1: '#306998', color2: '#FFD43B' },
  '.pyi':    { ext: '.pyi',    label: 'Python stub',       shape: 'square',   color1: '#306998', color2: '#FFD43B' },

  // ---- Markdown / docs ----
  '.md':     { ext: '.md',     label: 'Markdown',          shape: 'circle',   color1: '#4ade80' },
  '.mdx':    { ext: '.mdx',    label: 'MDX',               shape: 'circle',   color1: '#4ade80', color2: '#3178c6' },

  // ---- Ruby family (red diamond — gem) ----
  '.rb':     { ext: '.rb',     label: 'Ruby',              shape: 'diamond',  color1: '#cc342d' },
  '.erb':    { ext: '.erb',    label: 'ERB',               shape: 'diamond',  color1: '#cc342d', color2: '#f56565' },
  '.rake':   { ext: '.rake',   label: 'Rake',              shape: 'diamond',  color1: '#cc342d' },
  '.gemspec':{ ext: '.gemspec',label: 'Gemspec',           shape: 'diamond',  color1: '#cc342d' },

  // ---- Systems / native (hexagon — Rust gear, C-family, Zig) ----
  '.rs':     { ext: '.rs',     label: 'Rust',              shape: 'hexagon',  color1: '#dea584', color2: '#1f1f1f' },
  '.c':      { ext: '.c',      label: 'C',                 shape: 'hexagon',  color1: '#5b6770' },
  '.h':      { ext: '.h',      label: 'C header',          shape: 'hexagon',  color1: '#a8b3bf' },
  '.cpp':    { ext: '.cpp',    label: 'C++',               shape: 'hexagon',  color1: '#f34b7d' },
  '.cc':     { ext: '.cc',     label: 'C++',               shape: 'hexagon',  color1: '#f34b7d' },
  '.cxx':    { ext: '.cxx',    label: 'C++',               shape: 'hexagon',  color1: '#f34b7d' },
  '.hpp':    { ext: '.hpp',    label: 'C++ header',        shape: 'hexagon',  color1: '#f3a8c4' },
  '.zig':    { ext: '.zig',    label: 'Zig',               shape: 'hexagon',  color1: '#ec915c' },

  // ---- JVM ----
  '.java':   { ext: '.java',   label: 'Java',              shape: 'circle',   color1: '#ec8a4b' },
  '.kt':     { ext: '.kt',     label: 'Kotlin',            shape: 'triangle', color1: '#A97BFF', color2: '#ff8E3C' },
  '.kts':    { ext: '.kts',    label: 'Kotlin Script',     shape: 'triangle', color1: '#A97BFF', color2: '#ff8E3C' },
  '.scala':  { ext: '.scala',  label: 'Scala',             shape: 'diamond',  color1: '#c22d40' },
  '.gradle': { ext: '.gradle', label: 'Gradle',            shape: 'circle',   color1: '#02303a', color2: '#76d04b' },
  '.groovy': { ext: '.groovy', label: 'Groovy',            shape: 'circle',   color1: '#4298b8' },

  // ---- .NET / Apple / Google ----
  '.cs':     { ext: '.cs',     label: 'C#',                shape: 'circle',   color1: '#9b4f96' },
  '.fs':     { ext: '.fs',     label: 'F#',                shape: 'circle',   color1: '#b845fc' },
  '.fsx':    { ext: '.fsx',    label: 'F# Script',         shape: 'circle',   color1: '#b845fc' },
  '.swift':  { ext: '.swift',  label: 'Swift',             shape: 'circle',   color1: '#F05138' },
  '.dart':   { ext: '.dart',   label: 'Dart',              shape: 'circle',   color1: '#00B4AB' },
  '.go':     { ext: '.go',     label: 'Go',                shape: 'circle',   color1: '#00ADD8' },

  // ---- PHP ----
  '.php':    { ext: '.php',    label: 'PHP',               shape: 'circle',   color1: '#6c7eb7' },

  // ---- UI components (triangle) ----
  '.vue':    { ext: '.vue',    label: 'Vue',               shape: 'triangle', color1: '#41b883', color2: '#34495e' },
  '.svelte': { ext: '.svelte', label: 'Svelte',            shape: 'triangle', color1: '#ff3e00' },
  '.astro':  { ext: '.astro',  label: 'Astro',             shape: 'triangle', color1: '#ff5d01', color2: '#d83fe9' },

  // ---- Styles ----
  '.css':    { ext: '.css',    label: 'CSS',               shape: 'circle',   color1: '#8a5cf6' },
  '.scss':   { ext: '.scss',   label: 'Sass',              shape: 'circle',   color1: '#d65c9b' },
  '.sass':   { ext: '.sass',   label: 'Sass',              shape: 'circle',   color1: '#d65c9b' },
  '.less':   { ext: '.less',   label: 'Less',              shape: 'circle',   color1: '#2868a8' },

  // ---- Markup ----
  '.html':   { ext: '.html',   label: 'HTML',              shape: 'circle',   color1: '#e34c26' },
  '.xml':    { ext: '.xml',    label: 'XML',               shape: 'square',   color1: '#a16207' },

  // ---- Data (square) ----
  '.json':   { ext: '.json',   label: 'JSON',              shape: 'square',   color1: '#ebcb1a' },
  '.yaml':   { ext: '.yaml',   label: 'YAML',              shape: 'square',   color1: '#d33232' },
  '.yml':    { ext: '.yml',    label: 'YAML',              shape: 'square',   color1: '#d33232' },
  '.toml':   { ext: '.toml',   label: 'TOML',              shape: 'square',   color1: '#c2602b' },
  '.sql':    { ext: '.sql',    label: 'SQL',               shape: 'square',   color1: '#f08c20' },
  '.csv':    { ext: '.csv',    label: 'CSV',               shape: 'square',   color1: '#90b04b' },

  // ---- Shells ----
  '.sh':     { ext: '.sh',     label: 'Shell',             shape: 'circle',   color1: '#89e051' },
  '.bash':   { ext: '.bash',   label: 'Bash',              shape: 'circle',   color1: '#89e051' },
  '.zsh':    { ext: '.zsh',    label: 'Zsh',               shape: 'circle',   color1: '#89e051' },
  '.ps1':    { ext: '.ps1',    label: 'PowerShell',        shape: 'circle',   color1: '#012456', color2: '#5391FE' },

  // ---- Functional / scripting ----
  '.lua':    { ext: '.lua',    label: 'Lua',               shape: 'circle',   color1: '#000080', color2: '#ffffff' },
  '.r':      { ext: '.r',      label: 'R',                 shape: 'circle',   color1: '#198CE7' },
  '.pl':     { ext: '.pl',     label: 'Perl',              shape: 'circle',   color1: '#0298c3' },
  '.pm':     { ext: '.pm',     label: 'Perl module',       shape: 'circle',   color1: '#0298c3' },
  '.ex':     { ext: '.ex',     label: 'Elixir',            shape: 'circle',   color1: '#7c3aed' },
  '.exs':    { ext: '.exs',    label: 'Elixir Script',     shape: 'circle',   color1: '#7c3aed' },
  '.erl':    { ext: '.erl',    label: 'Erlang',            shape: 'circle',   color1: '#B83998' },
  '.clj':    { ext: '.clj',    label: 'Clojure',           shape: 'circle',   color1: '#db5855', color2: '#5881d8' },
  '.cljs':   { ext: '.cljs',   label: 'ClojureScript',     shape: 'circle',   color1: '#db5855', color2: '#5881d8' },
  '.hs':     { ext: '.hs',     label: 'Haskell',           shape: 'circle',   color1: '#5e5086' },
  '.ml':     { ext: '.ml',     label: 'OCaml',             shape: 'circle',   color1: '#3be133' },
  '.mli':    { ext: '.mli',    label: 'OCaml interface',   shape: 'circle',   color1: '#3be133' },
  '.nim':    { ext: '.nim',    label: 'Nim',               shape: 'circle',   color1: '#ffc200', color2: '#2a2a2a' },
  '.jl':     { ext: '.jl',     label: 'Julia',             shape: 'circle',   color1: '#a270ba' },
  '.v':      { ext: '.v',      label: 'V',                 shape: 'circle',   color1: '#5d87bf' },
};

export const DEFAULT_STYLE: ExtStyle = {
  ext: '*',
  label: 'Other',
  shape: 'circle',
  color1: '#9aa0a6',
};

export const DIR_STYLE: ExtStyle = {
  ext: 'dir',
  label: 'Directory',
  shape: 'circle',
  color1: '#c0c4cb',
};

export function getStyleFor(ext?: string): ExtStyle {
  if (!ext) return DEFAULT_STYLE;
  return EXT_STYLES[ext.toLowerCase()] ?? DEFAULT_STYLE;
}

export function styleKey(s: ExtStyle): string {
  return `${s.shape}|${s.color1}|${s.color2 ?? ''}`;
}

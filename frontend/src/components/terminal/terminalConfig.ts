import type { ITerminalOptions, ITheme } from '@xterm/xterm';

export const TERMINAL_THEME = {
  background: '#0e1014',
  foreground: '#e3e5e9',
  cursor: '#6aa9ff',
  cursorAccent: '#0e1014',
  selectionBackground: 'rgba(106,169,255,0.30)',
  black: '#0e1014',
  brightBlack: '#3d4350',
  red: '#ff8888',
  brightRed: '#ffa3a3',
  green: '#9ed28e',
  brightGreen: '#bce3ad',
  yellow: '#e7c986',
  brightYellow: '#f0d8a4',
  blue: '#6aa9ff',
  brightBlue: '#88bcff',
  magenta: '#c89cff',
  brightMagenta: '#dab8ff',
  cyan: '#83d6e3',
  brightCyan: '#a4e1ec',
  white: '#cfd2d8',
  brightWhite: '#ebecef',
} satisfies ITheme;

export const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, Menlo, monospace',
  fontSize: 12.5,
  lineHeight: 1.25,
  letterSpacing: 0,
  allowProposedApi: true,
  // How many lines xterm retains for scroll-back in the LIVE terminal. This is
  // the cap that bounds scrolling up in a long-running session (independent of
  // the server-side replay window used on reattach). Raised from 5000 so a
  // long Claude session stays scrollable to its start; only paid per actually-
  // mounted (viewed) terminal, and roughly matched to the backend's ~2 MB
  // SCROLLBACK_REPLAY_BYTES window so a reload restores a comparable amount.
  scrollback: 20000,
  theme: TERMINAL_THEME,
} satisfies ITerminalOptions;

import { COLORS } from './config.mjs';

// vite's proxy middleware logs each proxy error as a multi-line block:
//
//   [vite] ws proxy error:
//   Error: connect ECONNREFUSED 127.0.0.1:5184
//       at TCPConnectWrap.afterConnect (...)
//       ... more stack ...
//
// or with an error-object dump:
//
//   [vite] http proxy error: /api/scan
//   Error: connect ECONNREFUSED 127.0.0.1:5184
//       at ...  {
//     errno: -4078,
//     code: 'ECONNREFUSED',
//     ...
//   }
//
// vite's customLogger doesn't catch these (they take a different code
// path), so we filter at the pipe level. State machine: trigger line
// switches to "suppress mode"; we stay in suppress mode while lines
// look like a continuation (Error: …, stack frames, object props,
// braces, blanks). Any other line exits suppress and is emitted.
const ANSI = /\x1b\[[0-9;]*m/g;
const VITE_PROXY_TRIGGER = /\[vite\]\s+(ws|http) proxy (?:socket )?error/i;
const STACK_LINE = /^\s+at\s/;
const ERROR_HEADER = /^Error[:]/;
const ERROR_PROP = /^\s+(errno|code|syscall|address|port|hostname|info|message)[:]/;
const OPEN_BRACE = /^\s*\{\s*$/;
const CLOSE_BRACE = /^\s*\}\s*$/;

export function isContinuation(plain) {
  if (plain.trim() === '') return true;
  if (ERROR_HEADER.test(plain)) return true;
  if (STACK_LINE.test(plain)) return true;
  if (ERROR_PROP.test(plain)) return true;
  if (OPEN_BRACE.test(plain)) return true;
  if (CLOSE_BRACE.test(plain)) return true;
  return false;
}

export function prefixLines(stream, sink, { label, color, filterViteProxy = false }) {
  let buffer = '';
  let suppressing = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (filterViteProxy) {
        const plain = line.replace(ANSI, '');
        // Trigger always opens (or extends) a suppressed block — even
        // when we were already suppressing the previous one. Without
        // this, two back-to-back proxy errors would have the second
        // trigger line treated as the "exit" of the first block.
        if (VITE_PROXY_TRIGGER.test(plain)) {
          suppressing = true;
          continue;
        }
        if (suppressing) {
          if (isContinuation(plain)) continue;
          suppressing = false;
          // fall through and emit this line
        }
      }
      sink.write(`${color}[${label}]${COLORS.reset} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffer) sink.write(`${color}[${label}]${COLORS.reset} ${buffer}\n`);
  });
}

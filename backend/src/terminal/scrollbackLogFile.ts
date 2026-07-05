import fs from 'node:fs';

// Low-level file-tail mechanics for the disk-backed scrollback log. Pure,
// stateless helpers over a log file path; the pending-buffer/degraded-mode
// state lives in `ScrollbackStore` (scrollbackStore.ts), which uses `readTail`
// for both windowed replay and inline compaction.

const NEWLINE = 0x0a;

// Drop a partial leading line so a windowed replay never begins mid-escape-
// sequence (which would render as garbage on the first visible line). If the
// window has no newline (one enormous line) we keep it as-is.
export function trimToLineStart(buf: Buffer): Buffer {
  const nl = buf.indexOf(NEWLINE);
  if (nl >= 0 && nl < buf.length - 1) return buf.subarray(nl + 1);
  return buf;
}

// Read the last `maxBytes` bytes of a file, trimmed to a line boundary.
// Byte-level (Buffer) so multibyte UTF-8 in the body is never corrupted; only
// the dropped partial first line is affected. Throws if the file is missing.
export function readTail(filePath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return start > 0 ? trimToLineStart(buf) : buf;
  } finally {
    fs.closeSync(fd);
  }
}

// Decode a source file's bytes for the analyzer. UTF-8 is the overwhelming
// case, but a UTF-16 file (PowerShell ISE and some Visual Studio saves write
// `.ps1`/`.cs` as UTF-16LE with a BOM) decoded as UTF-8 becomes NUL-interleaved
// text: every universal smell regex then runs over garbage and reports
// `magic_number` / `long_string_literal` noise for a perfectly ordinary file.
// A BOM is the only cheap, reliable signal, so that is all this checks.
export function decodeSourceText(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // Node has no big-endian UTF-16 decoder; swap into little-endian first.
      const le = Buffer.from(buf.subarray(2));
      if (le.length % 2 === 1) return le.subarray(0, le.length - 1).swap16().toString('utf16le');
      return le.swap16().toString('utf16le');
    }
  }
  return buf.toString('utf8');
}

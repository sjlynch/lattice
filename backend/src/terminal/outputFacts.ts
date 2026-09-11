// Raw PTY facts for activity consumers. Cursor movement, redraw synchronization,
// queries and OSC payloads are not printable output. Escape sequences can cross
// onData chunks. Retain no terminal contents, history or escape payloads.
type Mode = 'text' | 'escape' | 'charset' | 'csi' | 'osc' | 'string';

export class TerminalOutputFacts {
  lastTextOutputAt = 0;
  private mode: Mode = 'text';
  private stringEscape = false;

  write(data: string, at: number): void {
    for (const char of data) {
      const code = char.codePointAt(0)!;
      if (this.mode === 'osc' || this.mode === 'string') {
        if (code === 0x9c || (this.stringEscape && char === '\\') ||
            (this.mode === 'osc' && code === 0x07)) {
          this.mode = 'text';
          this.stringEscape = false;
          continue;
        }
        if (code === 0x18 || code === 0x1a) {
          this.mode = 'text';
          this.stringEscape = false;
          continue;
        }
        this.stringEscape = code === 0x1b;
        continue;
      }
      if (code === 0x1b) { this.mode = 'escape'; continue; }
      if (code === 0x9b) { this.mode = 'csi'; continue; }
      if (code === 0x9d) { this.beginOsc(); continue; }
      if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.mode = 'string'; this.stringEscape = false; continue;
      }
      if (this.mode === 'escape') {
        if (char === '[') this.mode = 'csi';
        else if (char === ']') this.beginOsc();
        else if ('PX^_'.includes(char)) { this.mode = 'string'; this.stringEscape = false; }
        else if (code >= 0x20 && code <= 0x2f) this.mode = 'charset';
        else this.mode = 'text';
        continue;
      }
      if (this.mode === 'charset') {
        if (code >= 0x30 && code <= 0x7e) this.mode = 'text';
        continue;
      }
      if (this.mode === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.mode = 'text';
        else if (code === 0x18 || code === 0x1a) this.mode = 'text';
        continue;
      }
      if (code > 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
        this.lastTextOutputAt = at;
      }
    }
  }

  private beginOsc(): void {
    this.mode = 'osc';
    this.stringEscape = false;
  }
}

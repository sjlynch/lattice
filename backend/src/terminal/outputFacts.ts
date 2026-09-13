// Raw PTY facts for activity consumers. Cursor movement, redraw synchronization,
// queries and OSC payloads are not printable output. Escape sequences can cross
// onData chunks. Retain only the latest bounded window title, never screen
// contents, history or unrelated escape payloads.
type Mode = 'text' | 'escape' | 'charset' | 'csi' | 'osc' | 'string';

export class TerminalOutputFacts {
  lastTextOutputAt = 0;
  terminalTitle: string | null = null;
  private mode: Mode = 'text';
  private stringEscape = false;
  private oscCommand = '';
  private oscTitle: string | null = null;
  private oscHasSeparator = false;
  private oscInvalid = false;

  get isGround(): boolean { return this.mode === 'text'; }

  write(data: string, at: number): void {
    for (const char of data) {
      const code = char.codePointAt(0)!;
      if (this.mode === 'osc' || this.mode === 'string') {
        if (code === 0x9c || (this.stringEscape && char === '\\') ||
            (this.mode === 'osc' && code === 0x07)) {
          if (this.mode === 'osc' && this.oscHasSeparator &&
              (this.oscCommand === '0' || this.oscCommand === '2')) {
            this.terminalTitle = this.oscInvalid ? null : this.oscTitle;
          }
          this.mode = 'text';
          this.stringEscape = false;
          continue;
        }
        if (code === 0x18 || code === 0x1a) {
          this.mode = 'text';
          this.stringEscape = false;
          continue;
        }
        if (this.mode === 'osc' && this.stringEscape) this.oscInvalid = true;
        if (this.mode === 'osc' && code !== 0x1b) {
          if (!this.oscHasSeparator) {
            if (char === ';') {
              this.oscHasSeparator = true;
              this.oscTitle = this.oscCommand === '0' || this.oscCommand === '2' ? '' : null;
            } else if (this.oscCommand.length < 2) this.oscCommand += char;
          } else if (this.oscTitle !== null) {
            // Oversized titles become unknown, never a truncated status match.
            this.oscTitle = code < 0x20 || this.oscTitle.length + char.length > 128
              ? null : this.oscTitle + char;
          }
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
    this.oscCommand = '';
    this.oscTitle = null;
    this.oscHasSeparator = false;
    this.oscInvalid = false;
  }
}

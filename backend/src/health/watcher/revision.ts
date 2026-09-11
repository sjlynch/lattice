// Events are stamped before any asynchronous config/read/analysis work. A
// later event for the same path owns publication, including cache writes.
export class WatcherRevision {
  private version = 0;
  private pending = new Map<string, symbol>();

  begin(filePath: string): { isCurrent: () => boolean; finish: () => void } {
    this.invalidate();
    const token = Symbol(filePath);
    this.pending.set(filePath, token);
    return {
      isCurrent: () => this.pending.get(filePath) === token,
      finish: () => {
        if (this.pending.get(filePath) === token) {
          this.pending.delete(filePath);
          this.invalidate();
        }
      },
    };
  }

  invalidate(): void {
    this.version++;
  }

  get current(): number {
    return this.version;
  }

  // A scan cannot safely replace state while an earlier event is still being
  // analyzed: its result could be older than that event's eventual result.
  snapshot(): number | null {
    return this.pending.size === 0 ? this.version : null;
  }

  matches(version: number | null): boolean {
    return version !== null && this.snapshot() === version;
  }
}

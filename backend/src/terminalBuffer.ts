import { TERMINAL_CONFIG } from './terminalConfig.js';

export class SessionBuffer {
  private chunks: string[] = [];
  private bufferSize = 0;
  private maxBytes: number;

  constructor(maxBytes = TERMINAL_CONFIG.BUFFER_REPLAY_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  append(data: string): void {
    this.chunks.push(data);
    this.bufferSize += data.length;
    this.resize(this.maxBytes);
  }

  resize(maxBytes: number): void {
    this.maxBytes = maxBytes;
    while (this.bufferSize > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed) this.bufferSize -= removed.length;
    }
  }

  replay(): string {
    return this.chunks.join('');
  }

  get size(): number {
    return this.bufferSize;
  }
}

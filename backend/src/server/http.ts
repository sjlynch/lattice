import http from 'node:http';
import type { Express } from 'express';
import { attachWebSockets } from '../ws/wsServer.js';

export function createHttpServerWithWebSockets(app: Express): http.Server {
  const server = http.createServer(app);
  attachWebSockets(server);
  return server;
}

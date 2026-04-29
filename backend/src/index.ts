import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { scan } from './scanner.js';
import { listDir } from './fsbrowse.js';
import { attachTerminal } from './terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5184;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/default-root', (_req, res) => {
  res.json({ path: DEFAULT_ROOT });
});

app.get('/api/scan', async (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : DEFAULT_ROOT;
  try {
    const result = await scan(target);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/list-dir', async (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : undefined;
  try {
    const result = await listDir(target);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const cwd = url.searchParams.get('cwd') || undefined;
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  attachTerminal(ws, { cwd, cols, rows });
});

server.listen(PORT, () => {
  console.log(`[lattice-backend] listening on http://localhost:${PORT}`);
  console.log(`[lattice-backend] default root: ${DEFAULT_ROOT}`);
});

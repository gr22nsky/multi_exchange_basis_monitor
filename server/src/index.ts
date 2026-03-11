import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketMonitorService } from './service.js';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const monitor = new MarketMonitorService();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.get('/api/snapshot', (_request, response) => {
  response.json(monitor.getSnapshot());
});

app.get('/api/stream', (request, response) => {
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });

  const sendSnapshot = () => {
    response.write('event: snapshot\n');
    response.write(`data: ${JSON.stringify(monitor.getSnapshot())}\n\n`);
  };

  sendSnapshot();
  const timer = setInterval(sendSnapshot, 1000);

  request.on('close', () => {
    clearInterval(timer);
    response.end();
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../dist/client');

app.use(express.static(clientDist));
app.use((request, response, next) => {
  if (request.path.startsWith('/api')) {
    next();
    return;
  }

  response.sendFile(path.join(clientDist, 'index.html'), (error) => {
    if (error) {
      next();
    }
  });
});

async function main(): Promise<void> {
  await monitor.start();
  app.listen(port, () => {
    console.log(`multiexchange monitor server listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error('failed to start server', error);
  monitor.stop();
  process.exit(1);
});

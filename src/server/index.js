import { createPostgresDb } from '../db/postgres.js';
import { createMetrics, startEventLoopLagMonitor } from '../observability/metrics.js';
import { createPostgresUpdateQueue } from '../queue/postgres.js';
import { createWebhookIngress } from '../webhook/ingress.js';
import { createWebhookHttpServer } from './http.js';

const port = Number(process.env.PORT || 3000);
const db = await createPostgresDb();
const queue = createPostgresUpdateQueue({ pool: db?.pool });
const metrics = createMetrics();
const stopLagMonitor = startEventLoopLagMonitor({ metrics });
const ingress = createWebhookIngress({ queue, metrics });
const server = createWebhookHttpServer({ ingress, queue, metrics });

server.listen(port, () => {
  console.log(`Ayau webhook ingress listening on ${port}`);
});

const shutdown = async (signal) => {
  console.log('webhook ingress shutting down', { signal });
  stopLagMonitor();
  await new Promise((resolve) => server.close(resolve));
  await db?.close();
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

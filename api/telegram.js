import { createPostgresDb } from '../src/db/postgres.js';
import { createMetrics } from '../src/observability/metrics.js';
import { createPostgresUpdateQueue } from '../src/queue/postgres.js';
import { createWebhookIngress } from '../src/webhook/ingress.js';

const webhookSecret = process.env.WEBHOOK_SECRET;
const db = await createPostgresDb();
const queue = createPostgresUpdateQueue({ pool: db?.pool });
const metrics = createMetrics();
const ingress = createWebhookIngress({ queue, metrics });

export default async function handler(request, response) {
  try {
    if (request.method !== 'POST') {
      response.status(200).json({ ok: true, queue: Boolean(queue) });
      return;
    }
    if (webhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      response.status(401).json({ ok: false });
      return;
    }

    await ingress.enqueue(request.body);
    response.status(200).json({ ok: true });
  } catch (error) {
    console.error('serverless webhook enqueue failed', error);
    response.status(200).json({ ok: true });
  }
}

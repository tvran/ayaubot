import { createServer } from 'node:http';
import { Redis } from '@upstash/redis';
import { createAnalyticsService } from '../analytics/service.js';
import { createBotApp } from '../bot/app.js';
import { createPostgresDb } from '../db/postgres.js';
import { createMediaDownloadService } from '../media/service.js';

const port = Number(process.env.PORT || 3000);
const webhookSecret = process.env.WEBHOOK_SECRET;
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;
const db = await createPostgresDb();
const analytics = createAnalyticsService({ db });
const mediaDownloader = createMediaDownloadService();
const bot = createBotApp({ redis, analytics, mediaDownloader });

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method !== 'POST' || request.url !== '/telegram/webhook') {
      sendJson(response, 404, { ok: false });
      return;
    }

    if (webhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      sendJson(response, 401, { ok: false });
      return;
    }

    await bot.handleUpdate(await readJson(request));
    sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error(error);
    sendJson(response, 200, { ok: true });
  }
});

server.listen(port, () => {
  console.log(`Ayau bot listening on ${port}`);
});

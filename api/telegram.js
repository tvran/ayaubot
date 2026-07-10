import { Redis } from '@upstash/redis';
import { createAnalyticsService } from '../src/analytics/service.js';
import { createBotApp } from '../src/bot/app.js';
import { createPostgresDb } from '../src/db/postgres.js';

const webhookSecret = process.env.WEBHOOK_SECRET;
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;
const db = await createPostgresDb();
const analytics = createAnalyticsService({ db });
const bot = createBotApp({ redis, analytics });

export default async function handler(request, response) {
  try {
    if (request.method !== 'POST') {
      response.status(200).json({ ok: true });
      return;
    }
    if (webhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
      response.status(401).json({ ok: false });
      return;
    }

    await bot.handleUpdate(request.body);
    response.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    response.status(200).json({ ok: true });
  }
}

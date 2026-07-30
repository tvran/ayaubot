import { Redis } from '@upstash/redis';
import { createAnalyticsService } from '../src/analytics/service.js';
import { createBirthdayService } from '../src/birthday/service.js';
import { createBotApp } from '../src/bot/app.js';
import { createDemotivationFrameExtractor } from '../src/demotivation/frame.js';
import { createPostgresDb } from '../src/db/postgres.js';
import { createMediaDownloadService } from '../src/media/service.js';
import { createPercentGameService } from '../src/games/percent.js';
import { createDailySummaryService } from '../src/summary/service.js';

const webhookSecret = process.env.WEBHOOK_SECRET;
const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;
const db = await createPostgresDb();
const analytics = createAnalyticsService({ db });
const birthdays = createBirthdayService({ db });
const mediaDownloader = createMediaDownloadService();
const demotivationFrameExtractor = createDemotivationFrameExtractor();
const percentGame = createPercentGameService({ redis });
const dailySummary = createDailySummaryService({ db });
const bot = createBotApp({
  redis,
  analytics,
  mediaDownloader,
  demotivationFrameExtractor,
  birthdays,
  percentGame,
  dailySummary
});

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

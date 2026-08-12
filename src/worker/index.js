import { createAnalyticsService } from '../analytics/service.js';
import { createBirthdayService } from '../birthday/service.js';
import { createBotApp } from '../bot/app.js';
import { createRateLimiter } from '../bot/rate-limit.js';
import { createPostgresDb } from '../db/postgres.js';
import { createDemotivationFrameExtractor } from '../demotivation/frame.js';
import { createPercentGameService } from '../games/percent.js';
import { createMediaDownloadService } from '../media/service.js';
import { createKinoClient } from '../kino/client.js';
import { createKinoMonitorService } from '../kino/service.js';
import { createMetrics, startEventLoopLagMonitor } from '../observability/metrics.js';
import { createPostgresUpdateQueue } from '../queue/postgres.js';
import { createUpdateWorker } from '../queue/worker.js';
import { createRedisCircuit, createRedisClient } from '../redis/client.js';
import { createPostgresSchedulerLease } from '../scheduler/postgres-lease.js';
import { createDailySummaryService } from '../summary/service.js';
import { createCourtService } from '../court/service.js';
import { createWorkerHttpServer } from './http.js';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const port = Number(process.env.PORT || 3001);
const db = await createPostgresDb();
if (!db) throw new Error('Worker requires DATABASE_URL.');

const queue = createPostgresUpdateQueue({ pool: db.pool });
const metrics = createMetrics();
const stopLagMonitor = startEventLoopLagMonitor({ metrics });
const redis = createRedisClient();
const redisGateway = createRedisCircuit({ redis, metrics });
const analytics = createAnalyticsService({ db });
const birthdays = createBirthdayService({ db });
const kinoClient = createKinoClient();
const kino = createKinoMonitorService({ db, client: kinoClient });
const mediaDownloader = createMediaDownloadService();
const demotivationFrameExtractor = createDemotivationFrameExtractor();
const percentGame = createPercentGameService({ redis, redisGateway });
const dailySummary = createDailySummaryService({ db });
const court = createCourtService({ db });
const rateLimiter = createRateLimiter();
const schedulerLease = createPostgresSchedulerLease({ pool: db.pool });
const bot = createBotApp({
  redis,
  redisGateway,
  analytics,
  mediaDownloader,
  demotivationFrameExtractor,
  birthdays,
  kino,
  percentGame,
  dailySummary,
  court,
  rateLimiter,
  metrics
});

const worker = createUpdateWorker({
  queue,
  handleUpdate: (update, executionContext) => bot.handleUpdate(update, executionContext),
  metrics
});

const stopBirthdayScheduler = birthdays.startScheduler({
  sendMessage: (chatId, text, extra = {}) => bot.api('sendMessage', {
    chat_id: chatId,
    text,
    ...extra
  }),
  runExclusive: (name, task) => schedulerLease.run(name, task)
});

const stopKinoScheduler = kino.startScheduler({
  notify: (alert) => bot.notifyKinoAvailability(alert),
  runExclusive: (name, task) => schedulerLease.run(name, task)
});

const courtScheduler = setInterval(() => {
  court.closeExpired(async (item) => {
    await bot.api('stopPoll', { chat_id: item.chat_id, message_id: item.message_id });
    await bot.api('sendMessage', { chat_id: item.chat_id, text: court.resultText(item), reply_to_message_id: item.message_id });
  })
    .catch((error) => console.error('court scheduler failed', error));
}, 30_000);
courtScheduler.unref?.();
const courtBankScheduler = setInterval(() => {
  court.refreshQuestionBank().catch((error) => console.error('court bank refresh failed', error));
}, 12 * 60 * 60 * 1000);
courtBankScheduler.unref?.();
court.refreshQuestionBank().catch((error) => console.error('initial court bank refresh failed', error));

await queue.recoverStale();
worker.start();

const queueAlertDepth = positiveInteger(process.env.QUEUE_ALERT_DEPTH, 50);
const queueAlertAgeSeconds = positiveInteger(process.env.QUEUE_ALERT_AGE_SECONDS, 60);
const monitorIntervalMs = positiveInteger(process.env.QUEUE_MONITOR_INTERVAL_MS, 30_000);
const monitor = setInterval(async () => {
  try {
    await queue.recoverStale();
    const stats = await queue.stats();
    let activeJobs = 0;
    for (const [key, value] of Object.entries(stats.byStatus)) {
      const [lane, status] = key.split(':');
      metrics.setGauge('telegram_queue_jobs', value, { lane, status });
      if (['pending', 'retry', 'processing'].includes(status)) activeJobs += value;
    }
    metrics.setGauge('telegram_queue_oldest_pending_age_seconds', stats.oldestPendingAgeSeconds);
    if (activeJobs >= queueAlertDepth || stats.oldestPendingAgeSeconds >= queueAlertAgeSeconds) {
      console.warn('telegram queue backlog', {
        activeJobs,
        oldestPendingAgeSeconds: stats.oldestPendingAgeSeconds,
        byStatus: stats.byStatus
      });
    }
  } catch (error) {
    console.error('queue monitor failed', error);
  }
}, monitorIntervalMs);
monitor.unref?.();

const cleanup = setInterval(async () => {
  try {
    const deleted = await queue.cleanup({
      completedDays: positiveInteger(process.env.QUEUE_COMPLETED_RETENTION_DAYS, 7),
      deadDays: positiveInteger(process.env.QUEUE_DEAD_RETENTION_DAYS, 30)
    });
    rateLimiter.prune();
    if (deleted) console.log('queue history cleaned', { deleted });
  } catch (error) {
    console.error('queue cleanup failed', error);
  }
}, positiveInteger(process.env.QUEUE_CLEANUP_INTERVAL_MS, 60 * 60 * 1000));
cleanup.unref?.();

const server = createWorkerHttpServer({ queue, worker, metrics });
server.listen(port, () => console.log(`Ayau worker health server listening on ${port}`));

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('worker shutting down', { signal });
  clearInterval(monitor);
  clearInterval(cleanup);
  clearInterval(courtScheduler);
  clearInterval(courtBankScheduler);
  stopBirthdayScheduler();
  stopKinoScheduler();
  stopLagMonitor();
  await new Promise((resolve) => server.close(resolve));
  await Promise.race([
    worker.stop(),
    new Promise((resolve) => setTimeout(resolve, 20_000))
  ]);
  await db.close();
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

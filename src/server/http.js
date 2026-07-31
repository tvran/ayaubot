import { createServer } from 'node:http';

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readJson = async (request, maxBytes) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`Webhook body exceeds ${maxBytes} bytes.`);
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const queueMetricGauges = (stats = {}) => {
  const gauges = [{
    name: 'telegram_queue_oldest_pending_age_seconds',
    value: stats.oldestPendingAgeSeconds || 0,
    labels: {}
  }];
  for (const [key, value] of Object.entries(stats.byStatus || {})) {
    const [lane, status] = key.split(':');
    gauges.push({
      name: 'telegram_queue_jobs',
      value,
      labels: { lane, status }
    });
  }
  return gauges;
};

export const createWebhookRequestHandler = ({
  ingress,
  queue,
  metrics,
  env = process.env,
  logger = console
} = {}) => {
  const webhookSecret = env.WEBHOOK_SECRET;
  const metricsToken = env.METRICS_TOKEN;
  const maxBodyBytes = asPositiveInteger(env.WEBHOOK_MAX_BODY_BYTES, 1024 * 1024);

  return async (request, response) => {
    const startedAt = Date.now();
    try {
      if (request.method === 'GET' && request.url === '/health') {
        await queue?.ping();
        sendJson(response, queue ? 200 : 503, { ok: Boolean(queue), queue: Boolean(queue) });
        return;
      }

      if (request.method === 'GET' && request.url === '/metrics') {
        if (metricsToken && request.headers.authorization !== `Bearer ${metricsToken}`) {
          sendJson(response, 401, { ok: false });
          return;
        }
        const stats = await queue?.stats();
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(metrics?.render(queueMetricGauges(stats)) || '');
        return;
      }

      if (request.method !== 'POST' || request.url !== '/telegram/webhook') {
        sendJson(response, 404, { ok: false });
        return;
      }

      if (webhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
        metrics?.increment('webhook_http_requests_total', { result: 'unauthorized' });
        sendJson(response, 401, { ok: false });
        return;
      }

      await ingress.enqueue(await readJson(request, maxBodyBytes));
      metrics?.increment('webhook_http_requests_total', { result: 'ok' });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      metrics?.increment('webhook_http_requests_total', { result: 'error' });
      logger.error('webhook request failed', {
        code: error?.code,
        error: error?.stack || error?.message || String(error)
      });
      sendJson(response, 200, { ok: true });
    } finally {
      metrics?.observe('webhook_http_duration_seconds', (Date.now() - startedAt) / 1000, {
        method: request.method || 'unknown',
        path: request.url || 'unknown'
      });
    }
  };
};

export const createWebhookHttpServer = (options = {}) =>
  createServer(createWebhookRequestHandler(options));

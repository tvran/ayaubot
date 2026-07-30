import { createServer } from 'node:http';

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export const createWorkerHttpServer = ({
  queue,
  worker,
  metrics,
  env = process.env,
  logger = console
} = {}) => createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      await queue.ping();
      sendJson(response, 200, { ...worker.health(), queue: true });
      return;
    }
    if (request.method === 'GET' && request.url === '/metrics') {
      if (env.METRICS_TOKEN && request.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
        sendJson(response, 401, { ok: false });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(metrics.render());
      return;
    }
    sendJson(response, 404, { ok: false });
  } catch (error) {
    logger.error('worker health request failed', error);
    sendJson(response, 503, { ok: false });
  }
});

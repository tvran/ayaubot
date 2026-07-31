import { updateQueueRecord } from '../queue/classify.js';

export const createWebhookIngress = ({ queue, metrics, logger = console } = {}) => {
  const enqueue = async (update) => {
    const record = updateQueueRecord(update);
    if (!record) {
      metrics?.increment('webhook_updates_total', { result: 'ignored' });
      return { accepted: false, ignored: true };
    }
    if (!queue) throw new Error('PostgreSQL webhook queue is unavailable.');

    const startedAt = Date.now();
    const result = await queue.enqueue(record);
    const durationMs = Date.now() - startedAt;
    metrics?.increment('webhook_updates_total', {
      result: result.inserted ? 'enqueued' : 'duplicate',
      lane: record.lane
    });
    metrics?.observe('webhook_enqueue_duration_seconds', durationMs / 1000, { lane: record.lane });
    logger.log('webhook update accepted', {
      updateId: String(record.updateId),
      chatId: String(record.chatId),
      lane: record.lane,
      inserted: result.inserted,
      durationMs
    });
    return { accepted: true, duplicate: !result.inserted, lane: record.lane };
  };

  return { enqueue };
};

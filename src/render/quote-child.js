import { createQuoteRenderer } from './quote.js';
import { fetchWithTimeout } from '../runtime/fetch.js';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const token = process.env.BOT_TOKEN;
const apiTimeoutMs = positiveInteger(process.env.TELEGRAM_API_TIMEOUT_MS, 15_000);
const fileTimeoutMs = positiveInteger(process.env.TELEGRAM_FILE_TIMEOUT_MS, 30_000);

const api = async (method, payload) => {
  if (!token) throw new Error('BOT_TOKEN is required by quote render child');
  const response = await fetchWithTimeout(
    fetch,
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' }
    },
    { timeoutMs: apiTimeoutMs, label: `Telegram ${method}` }
  );
  const data = await response.json().catch(() => ({
    ok: false,
    error_code: response.status,
    description: `HTTP ${response.status}`
  }));
  if (!data.ok) {
    const error = new Error(`${method}: ${data.description || `HTTP ${response.status}`}`);
    error.code = data.error_code || response.status;
    throw error;
  }
  return data.result;
};

const downloadTelegramFile = async (fileId) => {
  const file = await api('getFile', { file_id: fileId });
  const response = await fetchWithTimeout(
    fetch,
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    {},
    { timeoutMs: fileTimeoutMs, label: 'Telegram quote file download' }
  );
  if (!response.ok) throw new Error(`quote file download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const renderer = createQuoteRenderer({
  api,
  downloadTelegramFile,
  env: process.env
});

const reply = (message, exitCode) => {
  if (!process.send) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
};

process.once('message', async (message) => {
  if (message?.type !== 'renderStickerWebp' || !Array.isArray(message.messages)) {
    reply({
      type: 'error',
      error: { code: 'invalid_render_request', message: 'invalid quote render request' }
    }, 1);
    return;
  }

  try {
    const result = await renderer.renderStickerWebp(message.messages);
    reply({ type: 'result', data: result.toString('base64') }, 0);
  } catch (error) {
    reply({
      type: 'error',
      error: {
        name: error?.name,
        code: error?.code,
        message: error?.message || String(error)
      }
    }, 1);
  }
});

process.once('disconnect', () => process.exit(1));

const token = process.env.BOT_TOKEN;
const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.APP_URL;
const secret = process.env.WEBHOOK_SECRET;
const webhookPath = process.env.WEBHOOK_PATH || '/api/telegram';
const maxConnections = Math.min(
  100,
  Math.max(1, Number.parseInt(process.env.TELEGRAM_MAX_CONNECTIONS || '10', 10) || 10)
);
const dropPendingUpdates = process.env.TELEGRAM_DROP_PENDING_UPDATES === 'true';

if (!token) throw new Error('BOT_TOKEN is required');
if (!appUrl) throw new Error('APP_URL or VERCEL_PROJECT_PRODUCTION_URL is required');
if (!secret) throw new Error('WEBHOOK_SECRET is required');

const url = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
const webhookUrl = `${url}${webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`}`;

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message'],
    max_connections: maxConnections,
    drop_pending_updates: dropPendingUpdates
  })
});

const data = await response.json();
if (!data.ok) throw new Error(data.description);

console.log(`Webhook set: ${webhookUrl}; max_connections=${maxConnections}; drop_pending_updates=${dropPendingUpdates}`);

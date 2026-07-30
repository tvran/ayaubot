# Входные точки, worker и регистрация webhook

## `api/telegram.js`: Vercel Function

Модуль создаёт PostgreSQL adapter, очередь и ingress. Bot App, Redis, renderer и media-зависимости в webhook-функции больше не инициализируются.

Handler:

- любой метод кроме POST возвращает 200;
- проверяет `x-telegram-bot-api-secret-token`, если задан `WEBHOOK_SECRET`;
- принимает только `message`/`edited_message` с корректными `update_id` и chat ID;
- фиксирует update в `telegram_update_jobs`;
- отвечает 200 после INSERT; duplicate `update_id` также считается успехом;
- внутреннюю ошибку логирует и согласно контракту проекта всё равно отвечает 200.

## `src/server/index.js`: Railway web-service

Постоянный HTTP-сервис выполняет ту же enqueue-функцию и слушает `PORT` либо 3000:

- `POST /telegram/webhook` — проверка секрета и постановка update в очередь;
- `GET /health` — проверка соединения и наличия таблицы очереди;
- `GET /metrics` — Prometheus text format;
- остальные маршруты — 404.

Размер request body ограничен `WEBHOOK_MAX_BODY_BYTES`. Bot App и birthday scheduler в web-процессе не запускаются, поэтому web-service можно горизонтально масштабировать.

## `src/worker/index.js`: Railway worker-service

Команда `npm run worker` создаёт Bot App и все его зависимости, запускает PostgreSQL queue worker, birthday scheduler и небольшой HTTP-сервер для `/health` и `/metrics`.

Worker обрабатывает разные чаты параллельно, но использует PostgreSQL chat lease для последовательности внутри одного чата. Тяжёлые задачи имеют отдельный лимит конкурентности. При `SIGTERM` worker прекращает polling, останавливает scheduler и ждёт активные задачи до 20 секунд.

Birthday scheduler выполняет tick через `scheduler_leases`, поэтому несколько worker replicas не дублируют планировщик. Delivery markers остаются вторым уровнем идемпотентности.

## `scripts/set-webhook.js`: регистрация

Скрипт требует `BOT_TOKEN`, `WEBHOOK_SECRET` и `VERCEL_PROJECT_PRODUCTION_URL` либо `APP_URL`. `WEBHOOK_PATH` по умолчанию `/api/telegram`.

Payload содержит:

```json
{
  "url": "https://example.com/api/telegram",
  "secret_token": "<WEBHOOK_SECRET>",
  "allowed_updates": ["message", "edited_message"],
  "max_connections": 10,
  "drop_pending_updates": false
}
```

`TELEGRAM_MAX_CONNECTIONS` ограничивает давление Telegram на web-service. Очередь по умолчанию сохраняется. Для аварийного безвозвратного удаления накопленных updates нужно явно установить `TELEGRAM_DROP_PENDING_UPDATES=true` на один запуск.

## Production-порядок

1. `npm run migrate` с production `DATABASE_URL`.
2. Развернуть worker и дождаться успешного `/health`.
3. Развернуть web-service и дождаться успешного `/health`.
4. Выполнить `npm run set-webhook` с `TELEGRAM_DROP_PENDING_UPDATES=false`.
5. Проверить queue metrics и логи обоих сервисов.

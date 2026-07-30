# Очередь Telegram updates и worker

Webhook больше не выполняет команды внутри HTTP-запроса. `src/webhook/ingress.js` выбирает `message` или `edited_message`, формирует запись по `update_id` и сохраняет её в PostgreSQL через `src/queue/postgres.js`. После успешного INSERT HTTP endpoint отвечает Telegram `200`.

`update_id` — первичный ключ очереди. Повторная доставка того же update выполняет `ON CONFLICT DO NOTHING`, поэтому уже поставленная задача не дублируется.

## Миграция

Таблицы создаёт отдельная миграция `migrations/001_webhook_queue.sql`, которая запускается командой:

```bash
npm run migrate
```

`schema_migrations` хранит имя и SHA-256 каждого применённого SQL-файла. Изменение уже применённой миграции считается ошибкой; новую схему нужно добавлять следующим файлом.

## Таблицы

`telegram_update_jobs` хранит payload, lane, статус, число попыток и timestamps. Допустимые статусы:

- `pending` — новая задача;
- `retry` — отложенная повторная попытка;
- `processing` — задача арендована worker;
- `completed` — успешно выполнена; payload сразу заменяется пустым JSON;
- `dead` — исчерпан лимит попыток, payload и ошибка остаются для диагностики.

`telegram_chat_job_locks` содержит lease конкретного чата. Пока update обрабатывается, другой worker не может взять следующий update того же чата. Это сохраняет порядок внутри чата при параллельной обработке разных чатов. Heartbeat продлевает lease; после падения процесса просроченная задача возвращается в `retry`.

## Lanes и параллельность

`src/queue/classify.js` отправляет в `heavy`:

- `/q`, `/qs`, `/demotivation`;
- `#итогидня`;
- сообщения с поддерживаемым Instagram/TikTok URL.

Остальные updates используют `default`. Worker по умолчанию запускает четыре default-loop и один heavy-loop. Конкурентность настраивается `WORKER_CONCURRENCY` и `WORKER_HEAVY_CONCURRENCY`; порядок одного чата всё равно остаётся последовательным.

## Повторы и dead-letter

Необработанная ошибка получает экспоненциальную задержку с jitter. После `QUEUE_MAX_ATTEMPTS` задача переходит в `dead`. Успешная история хранится 7 дней, dead-letter — 30 дней; интервалы меняются переменными retention.

Гарантия обработки — at-least-once. Первичный ключ защищает от повторной доставки Telegram, но ошибка после частично успешного внешнего API-вызова теоретически может повторить побочный эффект.

## Наблюдаемость

Web и worker предоставляют `GET /health` и `GET /metrics`. При заданном `METRICS_TOKEN` metrics требует `Authorization: Bearer <token>`.

Метрики включают:

- количество задач по lane/status;
- возраст старейшей активной задачи;
- число и длительность worker jobs;
- длительность enqueue, Telegram API и Redis;
- rate-limit events, ошибки worker-loop;
- event-loop lag и память процесса.

Worker дополнительно пишет `telegram queue backlog`, если глубина или возраст очереди превышают `QUEUE_ALERT_DEPTH`/`QUEUE_ALERT_AGE_SECONDS`.

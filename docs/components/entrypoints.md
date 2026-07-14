# Входные точки и регистрация webhook

## `api/telegram.js`: Vercel Function

Модуль при загрузке:

1. создаёт Redis client, только если заданы обе Upstash-переменные;
2. вызывает `createPostgresDb()` и ждёт инициализации схемы;
3. создаёт Analytics Service и Birthday Service даже при `db === null`;
4. создаёт Media Download Service;
5. создаёт Bot App и экспортирует HTTP handler по умолчанию.

Контракт handler:

- любой метод кроме POST возвращает 200 и `{ ok: true }`;
- при заданном `WEBHOOK_SECRET` неверный заголовок возвращает 401;
- тело POST без дополнительной валидации передаётся в `bot.handleUpdate`;
- успешная обработка возвращает 200;
- исключение логируется и тоже возвращает 200.

Vercel-конфигурация в `vercel.json` ограничивает выполнение функции 60 секундами. Долгие запросы чаще всего связаны с последовательной загрузкой аватаров/медиа, CDN emoji или Telegram API.

## `src/server/index.js`: Node.js HTTP-сервер

Сборка зависимостей совпадает с Vercel-вариантом. Дополнительно модуль запускает планировщик дней рождения, создаёт `node:http` server и слушает `PORT` либо 3000. Vercel handler планировщик не запускает.

`readJson(request)` полностью собирает body в память и разбирает JSON. Лимит размера тела не установлен. Пустое тело превращается в `{}`.

`sendJson(response, status, body)` всегда выставляет `content-type: application/json` и сериализует объект.

Маршрутизация жёстко задана:

- health check: `GET /health`;
- Telegram: `POST /telegram/webhook`;
- всё остальное: 404.

Ошибки JSON и приложения логируются, но ответ Telegram остаётся успешным 200.

## `scripts/set-webhook.js`: регистрация

Скрипт требует `BOT_TOKEN`, `WEBHOOK_SECRET` и одну из переменных URL:

1. `VERCEL_PROJECT_PRODUCTION_URL` — приоритетная;
2. `APP_URL` — резервная.

Если URL не начинается с `http`, добавляется `https://`. `WEBHOOK_PATH` нормализуется добавлением начального `/`; значение по умолчанию — `/api/telegram`.

В Telegram `setWebhook` отправляются:

```json
{
  "url": "https://example.com/api/telegram",
  "secret_token": "<WEBHOOK_SECRET>",
  "allowed_updates": ["message", "edited_message"],
  "drop_pending_updates": true
}
```

Если Telegram возвращает `ok: false`, скрипт завершается исключением с `description`. При успехе печатается итоговый URL.

Важно: `drop_pending_updates: true` удаляет очередь необработанных обновлений при каждом повторном запуске скрипта.

## Различия режимов

| Характеристика | Vercel | Node.js server |
| --- | --- | --- |
| Endpoint | `/api/telegram` | `/telegram/webhook` |
| Health | Любой не-POST к функции | Только `GET /health` |
| Порт | Управляется Vercel | `PORT`, по умолчанию 3000 |
| Максимальное время | 60 секунд в конфигурации | Явного лимита нет |
| Запуск | `npm run dev` / deployment | `npm start` |

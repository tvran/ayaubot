# Настройка и эксплуатация

## Требования

- Node.js 18+;
- Telegram-бот с токеном от BotFather;
- публичный HTTPS endpoint для webhook;
- Upstash Redis для создания цитат и суточных результатов `/percent`;
- PostgreSQL для webhook queue, аналитики, игр и дней рождения;
- `yt-dlp` и `ffmpeg` для Instagram Reels/TikTok; `ffmpeg` также нужен для демотиватора из видеокружка.

Redis необязателен: без него команды цитирования не смогут собрать timeline, а `/percent` вернёт сообщение о недоступном хранилище. PostgreSQL обязателен для production webhook и worker; без него update невозможно надёжно зафиксировать до HTTP 200.

## Пакет и зависимости

`package.json` объявляет приватный ESM-пакет `ayaubot` версии 0.1.0. `package-lock.json` фиксирует точное дерево npm-зависимостей и должен использоваться через `npm install`/`npm ci`, а не редактироваться вручную.

Runtime-зависимости:

| Пакет | Роль |
| --- | --- |
| `@fontsource/tinos` | Свободный Times New Roman-совместимый шрифт подписей демотиватора |
| `@upstash/redis` | REST-клиент Redis для timeline сообщений и суточных результатов |
| `pg` | PostgreSQL pool и SQL-запросы |
| `satori` | Преобразование JS-дерева разметки в SVG |
| `sharp` | Resize, crop и кодирование PNG/JPEG/WebP |

`vercel` является единственной dev dependency и предоставляет локальный режим `vercel dev`.

Npm scripts:

| Script | Команда | Назначение |
| --- | --- | --- |
| `dev` | `vercel dev` | Локальная среда Vercel |
| `start` | `node src/server/index.js` | Быстрый HTTP ingress |
| `worker` | `node src/worker/index.js` | Queue worker, Bot App и scheduler |
| `migrate` | `node scripts/migrate.js` | Применение версионированных SQL-миграций |
| `lint` | набор `node --check` | Синтаксическая проверка исходников |
| `test` | `node --test` | Автоматические тесты доменных сервисов |
| `set-webhook` | `node scripts/set-webhook.js` | Регистрация Telegram webhook |

## Переменные окружения

| Переменная | Обязательность | Значение и значение по умолчанию |
| --- | --- | --- |
| `BOT_TOKEN` | Обязательна | Токен Telegram. Числовая часть до `:` также используется как ID бота |
| `WEBHOOK_SECRET` | Настоятельно рекомендуется; обязательна для `set-webhook` | Секрет заголовка Telegram webhook |
| `ALLOWED_CHAT_IDS` | Необязательна | Список разрешённых chat ID через запятую |
| `ALLOWED_CHAT_ID` | Необязательна | Совместимый вариант для одного или нескольких ID; используется, если `ALLOWED_CHAT_IDS` пуст |
| `UPSTASH_REDIS_REST_URL` | Для Redis | REST URL Upstash; Redis включается только вместе с токеном |
| `UPSTASH_REDIS_REST_TOKEN` | Для Redis | REST token Upstash |
| `DATABASE_URL` | Обязательна для ingress/worker | PostgreSQL connection string |
| `PGSSLMODE` | Необязательна | Только значение `disable` выключает SSL; иначе используется SSL без проверки сертификата |
| `PG_POOL_SIZE` | Необязательна | Размер пула PostgreSQL, по умолчанию `5` |
| `PG_CONNECT_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, `PG_QUERY_TIMEOUT_MS` | Необязательны | Таймауты PostgreSQL: 5000, 15000 и 20000 ms |
| `WEBHOOK_ENQUEUE_TIMEOUT_MS` | Необязательна | Максимум enqueue-запроса к БД, по умолчанию 1500 ms |
| `WEBHOOK_MAX_BODY_BYTES` | Необязательна | Лимит JSON body, по умолчанию 1 MiB |
| `TELEGRAM_MAX_CONNECTIONS` | Необязательна | Давление Telegram webhook, по умолчанию 10 |
| `TELEGRAM_DROP_PENDING_UPDATES` | Необязательна | Только явное `true` безвозвратно очищает очередь Telegram; default `false` |
| `TELEGRAM_API_TIMEOUT_MS`, `TELEGRAM_UPLOAD_TIMEOUT_MS`, `TELEGRAM_FILE_TIMEOUT_MS` | Необязательны | Таймауты Telegram: 15, 120 и 30 секунд |
| `TELEGRAM_API_RETRIES` | Необязательна | Повторы Telegram 429/5xx, по умолчанию 2 |
| `EMOJI_CDN_TIMEOUT_MS` | Необязательна | Таймаут каждого emoji CDN fallback, по умолчанию 5000 ms |
| `REDIS_TIMEOUT_MS`, `REDIS_RETRIES`, `REDIS_CIRCUIT_OPEN_MS` | Необязательны | Redis timeout/retries/circuit: 1000 ms, 0, 30000 ms |
| `STICKER_SET_NAME` | Для `/qs` | Техническое имя Telegram sticker set, обычно оканчивается на `_by_<bot_username>` |
| `STICKER_SET_TITLE` | Необязательна | Видимый заголовок набора, по умолчанию `Group Quotes` |
| `PORT` | Только Node server | HTTP-порт, по умолчанию `3000` |
| `APP_URL` | Для `set-webhook` | Публичный URL приложения; используется после Vercel-переменной |
| `VERCEL_PROJECT_PRODUCTION_URL` | Автоматически на Vercel | Production hostname, имеет приоритет над `APP_URL` |
| `WEBHOOK_PATH` | Для `set-webhook` | Путь endpoint, по умолчанию `/api/telegram` |
| `MEDIA_DOWNLOADS_ENABLED` | Необязательна | `false` полностью отключает обработку внешних видео; по умолчанию включена |
| `YT_DLP_PATH` | Необязательна | Путь или имя executable, по умолчанию `yt-dlp` |
| `FFMPEG_PATH` | Необязательна | Путь или имя executable для первого кадра видеокружка, по умолчанию `ffmpeg` |
| `YT_DLP_COOKIES_FILE` | Необязательна | Путь к Netscape cookies-файлу для роликов, требующих авторизации |
| `MEDIA_MAX_BYTES` | Необязательна | Максимальный размер файла, по умолчанию 49 MiB (`51380224`) |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | Необязательна | Таймаут одного процесса yt-dlp, по умолчанию 90 000 ms |
| `MEDIA_MAX_LINKS` | Необязательна | Максимум уникальных роликов из одного сообщения, по умолчанию 3 |
| `DEMOTIVATION_FRAME_TIMEOUT_MS` | Необязательна | Таймаут извлечения первого кадра видеокружка, по умолчанию 15 000 ms |
| `BIRTHDAY_SCHEDULER_ENABLED` | Необязательна | `false` отключает фоновые поздравления; по умолчанию включены |
| `BIRTHDAY_TIME_ZONE` | Необязательна | Часовой пояс календаря, по умолчанию `Asia/Almaty` |
| `BIRTHDAY_CHECK_HOUR` | Необязательна | Первый локальный час отправки, по умолчанию `9` |
| `BIRTHDAY_CHECK_INTERVAL_MS` | Необязательна | Интервал проверок, по умолчанию `900000`, минимум 60 секунд |
| `TICKETON_MONITOR_ENABLED` | Необязательна | `false` отключает scheduler Ticketon; по умолчанию включён |
| `TICKETON_BASE_URL`, `TICKETON_API_URL` | Необязательны | Сайт и публичный JSON API Ticketon |
| `TICKETON_CITY_ID`, `TICKETON_CITY_CODE`, `TICKETON_TIME_ZONE` | Необязательны | По умолчанию Астана: `1`, `astana`, `Asia/Almaty` |
| `TICKETON_CHECK_INTERVAL_MS`, `TICKETON_LOOKAHEAD_DAYS` | Необязательны | Интервал пробуждения scheduler и горизонт мониторинга: 3600000 ms и 7 дней |
| `TICKETON_DAILY_CHECK_HOUR` | Необязательна | Первый локальный час ежедневного дайджеста, по умолчанию 9 |
| `TICKETON_ADJACENT_SEATS`, `TICKETON_MAX_SESSIONS_PER_RUN` | Необязательны | Размер блока по умолчанию для чата и лимит карт за tick: 2 и 300 |
| `TICKETON_MANUAL_MAX_SESSIONS` | Необязательна | Лимит карт зала за ручную проверку: 30, но не выше общего лимита tick |
| `TICKETON_REQUEST_TIMEOUT_MS` | Необязательна | Timeout read-only запроса Ticketon, по умолчанию 15000 ms |
| `SCHEDULER_LEASE_MS` | Необязательна | TTL distributed scheduler lease, по умолчанию 10 минут |
| `WORKER_CONCURRENCY`, `WORKER_HEAVY_CONCURRENCY` | Необязательны | Default/heavy параллельность, по умолчанию 4/1 |
| `WORKER_JOB_TIMEOUT_MS`, `WORKER_HEAVY_JOB_TIMEOUT_MS` | Необязательны | Общий timeout задачи, 120/180 секунд |
| `QUOTE_RENDER_TIMEOUT_MS` | Необязательна | Жёсткий timeout изолированного `/q` renderer, по умолчанию 30 секунд; дочерний процесс завершается через `SIGKILL` |
| `QUEUE_POLL_MS`, `QUEUE_LOCK_MS`, `QUEUE_MAX_ATTEMPTS` | Необязательны | Poll, lease и попытки: 1000 ms, 60000 ms, 5 |
| `QUEUE_RETRY_BASE_MS`, `QUEUE_RETRY_MAX_MS` | Необязательны | Границы exponential backoff: 1000/60000 ms |
| `QUEUE_ALERT_DEPTH`, `QUEUE_ALERT_AGE_SECONDS` | Необязательны | Warning при 50 задачах или возрасте 60 секунд |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_COMMANDS`, `RATE_LIMIT_HEAVY` | Необязательны | Окно 60 секунд, лимиты 10/2 |
| `METRICS_TOKEN` | Рекомендуется | Bearer token для `/metrics`; без него endpoint открыт |
| `OPENAI_TIMEOUT_MS` | Необязательна | Таймаут `#итогидня`, по умолчанию 45 секунд |

Файл `.env.example` содержит основной минимум, PostgreSQL, media-сервис, планировщик дней рождения и монитор кино Ticketon, но не перечисляет `APP_URL`, `WEBHOOK_PATH`, `PORT` и множественный `ALLOWED_CHAT_IDS`.

## Установка yt-dlp и ffmpeg

Проверьте, что оба executable доступны тому же системному пользователю, под которым работает Node.js:

```bash
yt-dlp --version
ffmpeg -version
```

Media Service вызывает `yt-dlp` напрямую через `spawn`, а yt-dlp самостоятельно находит `ffmpeg` в `PATH`. Извлечение первого кадра видеокружка вызывает ffmpeg отдельно. Если бинарники расположены нестандартно, задайте абсолютные `YT_DLP_PATH` и `FFMPEG_PATH`.

Стандартный runtime Vercel не гарантирует наличие этих бинарников. Для Vercel deployment их необходимо включить в bundle/слой исполнения и задать исполняемый `YT_DLP_PATH`; кроме того, нужно учитывать 60-секундный лимит функции, тогда как сервис по умолчанию ждёт 90 секунд. Для такого deployment задайте `MEDIA_DOWNLOAD_TIMEOUT_MS` меньше лимита функции. Альтернатива — использовать самостоятельный HTTP-сервер или контейнер, где пакеты установлены системно.

## Установка и проверки

```bash
npm install
npm run migrate
npm run lint
npm test
```

`npm run lint` запускает `node --check` для каждого JavaScript-файла. Он не проверяет стиль, типы, SQL или внешние подключения. `npm test` также проверяет суточный кеш Percent Game с fake Redis, распознавание URL, Media Service и дни рождения; реальные Redis, Instagram/TikTok и Telegram API в тестах не вызываются.

## Запуск ingress и worker

```bash
npm start
npm run worker
```

Маршруты:

- `GET /health` → проверка PostgreSQL queue;
- `GET /metrics` → Prometheus metrics;
- `POST /telegram/webhook` → enqueue Telegram Update и быстрый `200`;
- остальные маршруты → `404 {"ok":false}`.

Для регистрации этого endpoint:

```bash
APP_URL=https://example.com \
WEBHOOK_PATH=/telegram/webhook \
npm run set-webhook
```

Сервер сам не загружает `.env`; переменные должны быть переданы средой процесса или через поддерживаемый вашей версией Node.js механизм `--env-file`.

Для Railway используйте два сервиса из одного source: web со Start Command `npm start` и worker со Start Command `npm run worker`. Оба получают один `DATABASE_URL`; только worker требует bot/Redis/media-переменные. Web можно масштабировать независимо. Scheduler запускается только в worker и защищён PostgreSQL lease.

## Запуск на Vercel

Команда разработки:

```bash
npm run dev
```

Vercel использует `api/telegram.js` только для enqueue. Путь webhook по умолчанию — `/api/telegram`; тяжёлая обработка всё равно требует постоянно работающий worker с той же PostgreSQL.

После production deployment выполните `npm run set-webhook`. Скрипт отправляет `allowed_updates: ["message", "edited_message", "callback_query", "poll_answer"]`, `TELEGRAM_MAX_CONNECTIONS` и по умолчанию `drop_pending_updates: false`. Очистка требует отдельного явного запуска с `TELEGRAM_DROP_PENDING_UPDATES=true`.

## Настройка Telegram-чата

Чтобы бот видел обычные сообщения группы и мог собирать многострочные цитаты, отключите privacy mode через BotFather или выдайте боту подходящие административные права. Для работы со стикерпаками Telegram также применяет собственные правила владения и имени набора.

Для личных напоминаний о днях рождения каждый зарегистрированный участник должен открыть бота в ЛС и нажать Start: Telegram запрещает боту первым начинать личный диалог.

Если задан allowlist, ID группы должен точно присутствовать в `ALLOWED_CHAT_IDS`/`ALLOWED_CHAT_ID`. Отрицательные ID групп указываются как обычные строки, например:

```dotenv
ALLOWED_CHAT_IDS=-1001234567890,-1009876543210
```

Пустой allowlist разрешает все чаты.

## Инициализация хранилищ

Redis не требует ручной схемы. Ключи создаются по мере поступления сообщений:

```text
chat:<chatId>:timeline
chat:<chatId>:message:<messageId>
percent-game:v1:<userId>:<parameter>
```

Историческая PostgreSQL-схема выполняется при старте через `CREATE TABLE/INDEX IF NOT EXISTS`. Queue и scheduler tables создаются версионированными миграциями. Перед первым запуском новой версии обязательно выполните `npm run migrate`; повторный запуск безопасен и сверяет checksum.

## Наблюдаемость и обработка ошибок

При старте worker выводит allowlist, имя стикерпака, queue concurrency и признаки включённых Redis/аналитики. Job logs содержат update ID, chat ID, lane, попытку и длительность, но не payload сообщения. Для запрещённых чатов старый диагностический log всё ещё содержит text/caption — это нужно учитывать с точки зрения приватности.

Ошибки после enqueue повторяются worker с backoff; после лимита задача попадает в `dead`. `/metrics` показывает глубину и возраст очереди, длительность jobs/Telegram/Redis и event-loop lag. Enqueue-ошибка логируется, но endpoint согласно контракту отвечает 200, поэтому такой update нужно считать потерянным.

## Диагностика

| Симптом | Что проверить |
| --- | --- |
| `/q` сообщает, что не видит кеш | Обе Upstash-переменные; privacy mode; allowlist; поступали ли сообщения боту |
| `/percent` сообщает, что игра недоступна | Обе Upstash-переменные; после изменения `config/percent-game.json` перезапустить приложение |
| Аналитика не настроена | `DATABASE_URL`, доступ к БД и DDL-права |
| Дни рождения не сохраняются | `DATABASE_URL`, тип чата должен быть `group`/`supergroup`, корректность формата даты |
| Напоминание не пришло в ЛС | Получатель зарегистрирован в этом чате, открыл бота в ЛС и нажал Start; логи `birthday notification failed` |
| Поздравление не появилось | Worker работает через `npm run worker`, scheduler включён, timezone/hour, `scheduler_leases` и `birthday_notifications` |
| Команды игнорируются | Формат команды, allowlist, наличие `analytics` для аналитических команд |
| `/qs` не работает | `STICKER_SET_NAME`, статический стикер создан именно этим ботом, права Telegram |
| Webhook получает 401 | Совпадение `WEBHOOK_SECRET` и зарегистрированного `secret_token` |
| Webhook не вызывается | Правильный `WEBHOOK_PATH`, публичный HTTPS, результат Telegram `getWebhookInfo` |
| Webhook отвечает медленно | `/health`, `WEBHOOK_ENQUEUE_TIMEOUT_MS`, PostgreSQL latency и наличие миграции |
| Растёт очередь | `telegram_queue_jobs`, oldest age, worker `/health`, default/heavy concurrency и dead jobs |
| Redis timeout | `REDIS_TIMEOUT_MS`; circuit breaker временно отключит кеш без остановки worker |
| Рендер падает на старте | Рабочая директория и наличие файлов в `assets/fonts` |
| Emoji отсутствуют | Сетевой доступ к jsDelivr; при двух неудачных CDN-запросах emoji рендерится обычным текстом |
| Бот пишет, что загрузчик не настроен | Доступность `YT_DLP_PATH` и executable-права |
| Reels/TikTok не скачивается | Публичность ролика, свежая версия yt-dlp, cookies для age/login restriction и наличие ffmpeg |
| Видео слишком большое | `MEDIA_MAX_BYTES`, фактический Telegram upload limit и память процесса |
| Worker обрывает загрузку | `MEDIA_DOWNLOAD_TIMEOUT_MS` должен быть меньше `WORKER_HEAVY_JOB_TIMEOUT_MS` |

# Настройка и эксплуатация

## Требования

- Node.js 18+;
- Telegram-бот с токеном от BotFather;
- публичный HTTPS endpoint для webhook;
- Upstash Redis для создания цитат;
- PostgreSQL для аналитики, игр и дней рождения;
- `yt-dlp` и `ffmpeg` для Instagram Reels/TikTok.

Redis и PostgreSQL технически необязательны и включаются независимо. Без Redis команды цитирования не смогут собрать сообщения. Без PostgreSQL аналитические команды вернут служебный текст, а обычные сообщения не будут сохраняться.

## Пакет и зависимости

`package.json` объявляет приватный ESM-пакет `ayaubot` версии 0.1.0. `package-lock.json` фиксирует точное дерево npm-зависимостей и должен использоваться через `npm install`/`npm ci`, а не редактироваться вручную.

Runtime-зависимости:

| Пакет | Роль |
| --- | --- |
| `@upstash/redis` | REST-клиент Redis для timeline сообщений |
| `pg` | PostgreSQL pool и SQL-запросы |
| `satori` | Преобразование JS-дерева разметки в SVG |
| `sharp` | Resize, crop и кодирование PNG/JPEG/WebP |

`vercel` является единственной dev dependency и предоставляет локальный режим `vercel dev`.

Npm scripts:

| Script | Команда | Назначение |
| --- | --- | --- |
| `dev` | `vercel dev` | Локальная среда Vercel |
| `start` | `node src/server/index.js` | Самостоятельный HTTP-сервер |
| `lint` | набор `node --check` | Синтаксическая проверка исходников |
| `test` | `node --test` | Автоматические тесты Media Service и дней рождения |
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
| `DATABASE_URL` | Для аналитики и дней рождения | PostgreSQL connection string; при отсутствии DB adapter равен `null` |
| `PGSSLMODE` | Необязательна | Только значение `disable` выключает SSL; иначе используется SSL без проверки сертификата |
| `PG_POOL_SIZE` | Необязательна | Размер пула PostgreSQL, по умолчанию `5` |
| `STICKER_SET_NAME` | Для `/qs` | Техническое имя Telegram sticker set, обычно оканчивается на `_by_<bot_username>` |
| `STICKER_SET_TITLE` | Необязательна | Видимый заголовок набора, по умолчанию `Group Quotes` |
| `PORT` | Только Node server | HTTP-порт, по умолчанию `3000` |
| `APP_URL` | Для `set-webhook` | Публичный URL приложения; используется после Vercel-переменной |
| `VERCEL_PROJECT_PRODUCTION_URL` | Автоматически на Vercel | Production hostname, имеет приоритет над `APP_URL` |
| `WEBHOOK_PATH` | Для `set-webhook` | Путь endpoint, по умолчанию `/api/telegram` |
| `MEDIA_DOWNLOADS_ENABLED` | Необязательна | `false` полностью отключает обработку внешних видео; по умолчанию включена |
| `YT_DLP_PATH` | Необязательна | Путь или имя executable, по умолчанию `yt-dlp` |
| `YT_DLP_COOKIES_FILE` | Необязательна | Путь к Netscape cookies-файлу для роликов, требующих авторизации |
| `MEDIA_MAX_BYTES` | Необязательна | Максимальный размер файла, по умолчанию 49 MiB (`51380224`) |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | Необязательна | Таймаут одного процесса yt-dlp, по умолчанию 90 000 ms |
| `MEDIA_MAX_LINKS` | Необязательна | Максимум уникальных роликов из одного сообщения, по умолчанию 3 |
| `BIRTHDAY_SCHEDULER_ENABLED` | Необязательна | `false` отключает фоновые поздравления; по умолчанию включены |
| `BIRTHDAY_TIME_ZONE` | Необязательна | Часовой пояс календаря, по умолчанию `Asia/Almaty` |
| `BIRTHDAY_CHECK_HOUR` | Необязательна | Первый локальный час отправки, по умолчанию `9` |
| `BIRTHDAY_CHECK_INTERVAL_MS` | Необязательна | Интервал проверок, по умолчанию `900000`, минимум 60 секунд |

Файл `.env.example` содержит основной минимум, PostgreSQL, media-сервис и планировщик дней рождения, но не перечисляет `APP_URL`, `WEBHOOK_PATH`, `PORT` и множественный `ALLOWED_CHAT_IDS`.

## Установка yt-dlp и ffmpeg

Проверьте, что оба executable доступны тому же системному пользователю, под которым работает Node.js:

```bash
yt-dlp --version
ffmpeg -version
```

Media Service вызывает `yt-dlp` напрямую через `spawn`, а yt-dlp самостоятельно находит `ffmpeg` в `PATH`. Если бинарник yt-dlp расположен нестандартно, задайте абсолютный `YT_DLP_PATH`.

Стандартный runtime Vercel не гарантирует наличие этих бинарников. Для Vercel deployment их необходимо включить в bundle/слой исполнения и задать исполняемый `YT_DLP_PATH`; кроме того, нужно учитывать 60-секундный лимит функции, тогда как сервис по умолчанию ждёт 90 секунд. Для такого deployment задайте `MEDIA_DOWNLOAD_TIMEOUT_MS` меньше лимита функции. Альтернатива — использовать самостоятельный HTTP-сервер или контейнер, где пакеты установлены системно.

## Установка и проверки

```bash
npm install
npm run lint
npm test
```

`npm run lint` запускает `node --check` для каждого JavaScript-файла. Он не проверяет стиль, типы, SQL или внешние подключения. `npm test` проверяет распознавание URL, безопасную передачу аргументов и контроль размера в Media Service с подменённым дочерним процессом; реальные Instagram/TikTok и Telegram API в тестах не вызываются.

## Запуск обычного HTTP-сервера

```bash
npm start
```

Маршруты:

- `GET /health` → `200 {"ok":true}`;
- `POST /telegram/webhook` → обработка Telegram Update;
- остальные маршруты → `404 {"ok":false}`.

Для регистрации этого endpoint:

```bash
APP_URL=https://example.com \
WEBHOOK_PATH=/telegram/webhook \
npm run set-webhook
```

Сервер сам не загружает `.env`; переменные должны быть переданы средой процесса или через поддерживаемый вашей версией Node.js механизм `--env-file`.

Для Railway используйте этот режим с Start Command `npm start`, подключённым PostgreSQL и `BIRTHDAY_TIME_ZONE=Asia/Almaty`. Фоновый планировщик запускается внутри постоянного процесса и не требует cron job. В Vercel-компоненте interval намеренно не запускается, потому что serverless function не гарантирует постоянную работу между webhook-запросами.

## Запуск на Vercel

Команда разработки:

```bash
npm run dev
```

Vercel использует `api/telegram.js` как функцию. `vercel.json` задаёт максимальную длительность выполнения 60 секунд. Путь webhook по умолчанию — `/api/telegram`; любой не-POST запрос к функции возвращает успешный health-like ответ.

После production deployment выполните `npm run set-webhook`. Скрипт отправляет `allowed_updates: ["message", "edited_message"]` и `drop_pending_updates: true`, поэтому накопленные до регистрации обновления будут удалены.

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
```

PostgreSQL-схема выполняется автоматически при старте приложения через `CREATE TABLE/INDEX IF NOT EXISTS`. У пользователя БД должны быть DDL-права. Миграционного инструмента и версионирования схемы нет.

## Наблюдаемость и обработка ошибок

При старте Bot App выводит allowlist, имя стикерпака и признаки включённых Redis/аналитики. Для запрещённых чатов логируются ID, название, тип и текст/caption сообщения — это важно учитывать с точки зрения приватности логов.

Необработанные ошибки печатаются через `console.error`, после чего webhook отвечает HTTP 200. Telegram не повторит такое обновление. Отдельных метрик, structured logging и dead-letter queue нет.

## Диагностика

| Симптом | Что проверить |
| --- | --- |
| `/q` сообщает, что не видит кеш | Обе Upstash-переменные; privacy mode; allowlist; поступали ли сообщения боту |
| Аналитика не настроена | `DATABASE_URL`, доступ к БД и DDL-права |
| Дни рождения не сохраняются | `DATABASE_URL`, тип чата должен быть `group`/`supergroup`, корректность формата даты |
| Напоминание не пришло в ЛС | Получатель зарегистрирован в этом чате, открыл бота в ЛС и нажал Start; логи `birthday notification failed` |
| Поздравление не появилось | Railway service работает через `npm start`, планировщик включён, timezone/hour и таблица `birthday_notifications` |
| Команды игнорируются | Формат команды, allowlist, наличие `analytics` для аналитических команд |
| `/qs` не работает | `STICKER_SET_NAME`, статический стикер создан именно этим ботом, права Telegram |
| Webhook получает 401 | Совпадение `WEBHOOK_SECRET` и зарегистрированного `secret_token` |
| Webhook не вызывается | Правильный `WEBHOOK_PATH`, публичный HTTPS, результат Telegram `getWebhookInfo` |
| Рендер падает на старте | Рабочая директория и наличие файлов в `assets/fonts` |
| Emoji отсутствуют | Сетевой доступ к jsDelivr; при двух неудачных CDN-запросах emoji рендерится обычным текстом |
| Бот пишет, что загрузчик не настроен | Доступность `YT_DLP_PATH` и executable-права |
| Reels/TikTok не скачивается | Публичность ролика, свежая версия yt-dlp, cookies для age/login restriction и наличие ffmpeg |
| Видео слишком большое | `MEDIA_MAX_BYTES`, фактический Telegram upload limit и память процесса |
| Загрузка обрывается на Vercel | `MEDIA_DOWNLOAD_TIMEOUT_MS` должен быть меньше лимита функции; бинарники должны быть в deployment |

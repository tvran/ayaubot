# PostgreSQL и модель данных

Файл `src/db/postgres.js` одновременно содержит DDL-схему и реализацию DB adapter.

## Создание adapter

```js
await createPostgresDb(env = process.env)
```

Если `DATABASE_URL` отсутствует, функция возвращает `null` и даже не импортирует `pg`. Иначе динамически импортируется `Pool`, создаётся пул и немедленно выполняется вся схема.

Настройки пула:

- connection string: `DATABASE_URL`;
- SSL выключен только при `PGSSLMODE=disable`;
- иначе SSL включён с `rejectUnauthorized: false`;
- максимум соединений: `PG_POOL_SIZE` либо 5.
- таймаут подключения: `PG_CONNECT_TIMEOUT_MS`, по умолчанию 5 секунд;
- statement timeout: `PG_STATEMENT_TIMEOUT_MS`, по умолчанию 15 секунд;
- client query timeout: `PG_QUERY_TIMEOUT_MS`, по умолчанию 20 секунд.

Adapter возвращает публичное поле `pool` для queue/lease adapters и метод `close()` для корректного shutdown постоянных процессов.

## Таблица `users`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `chat_id` | bigint, PK | Чат Telegram |
| `user_id` | bigint, PK | Пользователь Telegram |
| `first_name` | text | Имя |
| `last_name` | text | Фамилия |
| `username` | text | Username без `@` |
| `updated_at` | timestamptz | Последнее обновление профиля |

Один пользователь хранится отдельно для каждого чата. `upsertUser` обновляет все отображаемые поля и timestamp. `usersForChat` возвращает профили конкретного чата от недавно обновлённых к старым; `/all` затем сверяет их актуальный статус через Telegram.

## Таблица `word_counts`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `chat_id` | bigint, PK | Чат |
| `user_id` | bigint, PK | Автор |
| `word` | text, PK | Нормализованное слово |
| `day` | date, PK | День сообщения |
| `count` | integer | Число употреблений |

`incrementWordCounts` строит один многозначный INSERT и при конфликте увеличивает существующий count. Размер запроса пропорционален числу уникальных слов в одном сообщении; отдельного лимита нет.

Индексы оптимизируют агрегацию по `(chat_id, day, word)` и `(chat_id, day, user_id)`.

`topWords` суммирует слова за период, сортирует по total и ограничивает результат. Условие `day >= current_date - N days` включает текущий день и граничную дату, то есть может охватывать N+1 календарных дат.

`topUsersForWords` группирует статистику каждого пользователя и через `DISTINCT ON` оставляет лидера для слова. При равном total дополнительного tie-breaker нет, поэтому победитель не определён.

## Таблица `codeword_games`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `id` | bigserial, PK | ID игры |
| `chat_id` | bigint | Чат |
| `word` | text | Кодовое слово |
| `started_at` | timestamptz | Время создания |
| `expires_at` | timestamptz | Время истечения |
| `guessed_at` | timestamptz | Время угадывания |
| `guessed_by_user_id` | bigint | Победитель |
| `guessed_message_id` | bigint | Сообщение-победитель |
| `status` | text | `active`, `expired` или `guessed` |

`createCodeword` устанавливает `expires_at = now() + 3 days`. `activeCodeword` выбирает последнюю активную игру. Схема не содержит уникального ограничения на одну активную игру в чате, поэтому конкурентное создание допускает дубликаты.

`expireCodeword` и `guessCodeword` меняют только строки со статусом `active`. Результат update вызывающему коду не возвращается.

## Таблица `daily_picks`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `chat_id` | bigint, PK | Чат |
| `kind` | text, PK | Вид выбора, сейчас `pidor` |
| `day` | date, PK | День |
| `user_id` | bigint | Выбранный пользователь |
| `created_at` | timestamptz | Время записи |

`dailyPick` сначала ищет готовую запись. При отсутствии выбирает случайного пользователя чата с исключением переданных ID и вставляет результат с `ON CONFLICT DO NOTHING`.

`resetDailyPick` удаляет запись текущего дня. `dailyPickHistory` соединяет историю с актуальным профилем пользователя и сортирует по дате назад.

## Даты и часовые пояса

Для записи `word_counts` и ежедневного выбора дата формируется в приложении через `Date#toISOString()`, то есть в UTC. Фильтры топов используют PostgreSQL `current_date`, зависящий от timezone сессии БД. При отличающейся timezone границы периода могут расходиться около полуночи.

## Таблицы дней рождения

`birthdays` хранит одну запись на `(chat_id, user_id)`: отображаемый профиль, название чата, день и месяц, необязательный год рождения и timestamps. Индекс `(birth_month, birth_day)` используется ежедневной проверкой. `upsertBirthday` позволяет повторной команде обновить дату, `listBirthdays` строит календарь, а `birthdayReminderRecipients` возвращает остальных зарегистрированных участников того же чата.

`birthday_notifications` содержит delivery marker с составным ключом `(chat_id, birthday_user_id, recipient_user_id, event_date, kind)`. `claimBirthdayNotification` вставляет marker через `ON CONFLICT DO NOTHING` до Telegram API-вызова, поэтому параллельные процессы не отправят одно событие дважды. При временной ошибке `releaseBirthdayNotification` разрешает повтор на следующей проверке; записи старше 400 дней удаляются.

## Миграции и хранение

Базовая историческая схема по-прежнему идемпотентно создаёт отсутствующие объекты при старте. Новые production-изменения выполняются версионированными SQL-файлами из `migrations/` через `npm run migrate`. `schema_migrations` хранит checksum и запрещает незаметно переписать применённую миграцию. PostgreSQL advisory lock сериализует одновременные pre-deploy запуски web и worker.

## Таблицы монитора кино Ticketon

`ticketon_watched_movies` хранит выбранные фильмы по ключу `(chat_id, movie_id)`, отображаемое имя, slug и автора изменения. `ticketon_watched_cinemas` имеет тот же контракт для фильтра кинотеатров. Отсутствие строк кинотеатров у чата означает проверку всех кинотеатров Астаны. Старые таблицы `kino_*` не переиспользуются, поскольку ID разных провайдеров могут совпасть.

`ticketon_notifications` содержит delivery marker `(chat_id, session_id)` и связанные IDs фильма/кинотеатра. `claimTicketonNotification` вставляет его через `ON CONFLICT DO NOTHING` перед Telegram-вызовом. Временная ошибка освобождает marker; успешный сеанс больше не оповещается. Записи старше 90 дней очищает scheduler.

## Очередь и leases

`telegram_update_jobs` хранит идемпотентную очередь по `update_id`, lane, status, attempts и timestamps. Частичные индексы ускоряют выбор готовых задач и проверку более старых update того же чата. Completed payload очищается сразу, completed rows удаляются через 7 дней; dead-letter по умолчанию хранится 30 дней.

`telegram_chat_job_locks` содержит краткоживущую аренду chat ID и гарантирует последовательность внутри одного чата при нескольких worker loops или replicas.

`scheduler_leases` реализует singleton-запуск периодических задач. Birthday и Ticketon delivery markers остаются отдельной гарантией идемпотентности конкретного уведомления.

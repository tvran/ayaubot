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

Adapter возвращает публичное поле `pool`, но штатный код его напрямую не использует и не вызывает `pool.end()`.

## Таблица `users`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `chat_id` | bigint, PK | Чат Telegram |
| `user_id` | bigint, PK | Пользователь Telegram |
| `first_name` | text | Имя |
| `last_name` | text | Фамилия |
| `username` | text | Username без `@` |
| `updated_at` | timestamptz | Последнее обновление профиля |

Один пользователь хранится отдельно для каждого чата. `upsertUser` обновляет все отображаемые поля и timestamp.

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

## Миграции и хранение

Схема идемпотентно создаёт отсутствующие объекты, но не умеет изменять существующие столбцы. Версий миграций нет. Также нет foreign key, check constraint для статусов, retention policy или очистки старых агрегатов.

Для production-изменений схемы следует ввести отдельные миграции и не полагаться только на `CREATE IF NOT EXISTS`.


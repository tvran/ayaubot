# Загрузчик Instagram Reels и TikTok

`src/media/service.js` — изолированный adapter системного `yt-dlp`. Он отвечает за валидацию URL, управление дочерним процессом, временными файлами и лимитами. Отправкой в Telegram занимается Bot App.

## Публичный API

```js
isSupportedVideoUrl(value)
extractSupportedVideoUrls(text, limit)

const service = createMediaDownloadService({ env, spawnProcess });
// → {
//   enabled, maxBytes, maxLinks,
//   urlsFromMessage(message),
//   downloadVideo(url)
// }
```

`spawnProcess` по умолчанию равен `node:child_process.spawn` и может быть заменён в тестах.

## Поддерживаемые URL

Принимаются только HTTP/HTTPS URL на точном домене или поддомене площадки:

- Instagram: пути `/reel/<id>` и `/reels/<id>`;
- TikTok: пути с `/video/`, короткие `vm.tiktok.com/<id>` и `vt.tiktok.com/<id>`, а также `/t/<id>`.

Instagram posts `/p/...`, профили, поисковые страницы TikTok и похожие домены вроде `evilinstagram.com` отклоняются. Финальную поддержку конкретного ролика определяет yt-dlp.

`extractSupportedVideoUrls` находит URL в произвольном text/caption, удаляет завершающую пунктуацию, сохраняет порядок, удаляет дубликаты и применяет лимит. По умолчанию из одного сообщения берутся первые три ссылки.

## Команда yt-dlp

Для каждой ссылки создаётся уникальная директория `ayaubot-media-*` внутри `os.tmpdir()`. Процесс запускается без shell примерно со следующими аргументами:

```text
yt-dlp
  --no-playlist
  --no-warnings
  --restrict-filenames
  --format bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b
  --format-sort codec:h264
  --merge-output-format mp4
  --recode-video mp4
  --max-filesize <MEDIA_MAX_BYTES>
  --output <temp>/video.%(ext)s
  [--cookies <YT_DLP_COOKIES_FILE>]
  -- <url>
```

`--` отделяет пользовательский URL от опций командной строки. `--no-playlist` запрещает случайное скачивание коллекции. Сортировка предпочитает H.264 для совместимости Telegram. Объединение дорожек и перекодирование требуют ffmpeg.

После успешного завершения сервис выбирает самый большой готовый файл, игнорируя `.part` и `.ytdl`, повторно проверяет размер и читает содержимое в Buffer. Директория всегда удаляется в `finally`.

## Лимиты

| Настройка | По умолчанию | Поведение |
| --- | ---: | --- |
| `MEDIA_MAX_BYTES` | 49 MiB | Передаётся yt-dlp и повторно проверяется после загрузки |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | 90 секунд | После таймаута процесс получает `SIGKILL` |
| `MEDIA_MAX_LINKS` | 3 | Ограничивает ролики из одного сообщения |

Нечисловое, нулевое или отрицательное значение заменяется default. `MEDIA_MAX_LINKS` округляется вниз.

## Ошибки

`MediaDownloadError` содержит поле `code`:

| Код | Причина |
| --- | --- |
| `disabled` | Сервис отключён |
| `unsupported_url` | URL не прошёл allowlist |
| `spawn_failed` | yt-dlp отсутствует или не запускается |
| `timeout` | Превышен таймаут |
| `download_failed` | yt-dlp завершился ненулевым кодом |
| `missing_file` | Процесс успешен, но результата нет |
| `file_too_large` | Итоговый файл превысил лимит |

Последние 4 000 символов stderr включаются во внутреннюю ошибку `download_failed`, но пользователю не отправляются. Bot App преобразует коды в безопасные короткие ответы.

## Безопасность и эксплуатационные свойства

- shell не используется, поэтому URL не интерпретируется командной оболочкой;
- домены проверяются до запуска процесса;
- output template задаёт приложение, а не пользователь;
- cookies-файл только читается yt-dlp и не должен попадать в репозиторий или логи;
- Buffer удваивает часть memory footprint относительно файла во временной директории;
- одновременно обрабатываемые webhook-запросы могут запустить несколько yt-dlp/ffmpeg процессов — глобального semaphore или очереди нет;
- обновлённое Telegram-сообщение со ссылкой может повторно скачать и отправить тот же ролик.

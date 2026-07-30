# Рендерер демотиваторов

`src/render/demotivation.js` строит JPEG по референсу 271×300 в четырёхкратном разрешении. Командная валидация отделена в `src/demotivation/service.js`.

## Публичный API

```js
const renderer = createDemotivationRenderer();
const jpeg = await renderer.renderJpeg(imageBuffer, text);

const frames = createDemotivationFrameExtractor({ env, spawnProcess });
const firstFrame = await frames.extractFirstFrame(videoBuffer);
```

`imageBuffer` должен быть непустым `Buffer` поддерживаемого Sharp формата. Метод возвращает JPEG `Buffer` размером 1084×1200.

## Макет

- canvas: 1084×1200, чёрный фон;
- внешняя рамка: `(80, 76)`, размер 920×888, белая линия 6 px;
- внутренняя область фото: `(86, 82)`, размер 908×876;
- подпись: область `(62, 1008)` размером 960×170, белый Times New Roman Bold-совместимый serif по центру.

Размер подписи зависит от её длины: 84, 68, 54 или 42 px. Длинные слова разрешено переносить между любыми символами. Satori использует свободный Tinos Bold из `@fontsource/tinos`, метрически совместимый с Times New Roman; отдельно загружаются Cyrillic и Latin WOFF subsets. Затем Sharp добавляет изображение и кодирует итог в JPEG quality 92.

## Геометрия изображения

Sharp сначала применяет EXIF-ориентацию через `rotate()`, затем выполняет `resize(908, 876, { fit: 'fill' })`. Поэтому внутренняя рамка заполнена полностью, ни одна часть фотографии не обрезается, а исходное соотношение сторон намеренно меняется до соотношения рамки. Маленькие изображения при необходимости увеличиваются.

## Вход команды

`replyDemotivationSource(reply)` принимает самое крупное Telegram-фото, image-document, статический стикер или `video_note`. `normalizeDemotivationText` схлопывает пробельные символы, а Bot App отклоняет подписи длиннее 100 Unicode-символов до загрузки файла.

## Первый кадр видеокружка

Для `video_note` Bot App скачивает исходный MP4 и вызывает `src/demotivation/frame.js`. Сервис записывает video buffer во временную директорию и запускает без shell:

```text
ffmpeg -hide_banner -loglevel error -y -i video-note.mp4 -frames:v 1 -q:v 2 first-frame.jpg
```

JPEG первого кадра передаётся обычному renderer. Временная директория удаляется в `finally` при успехе, ошибке и таймауте. Путь к executable задаёт `FFMPEG_PATH` (`ffmpeg` по умолчанию), таймаут — `DEMOTIVATION_FRAME_TIMEOUT_MS` (15 секунд).

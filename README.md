# MoonLight Community — бэкенд меток

Сервер для системы общих меток («Community») в моде MoonLight. Хранит метки в памяти,
разделяя их **по адресу Minecraft-сервера**, и автоматически удаляет по истечении времени жизни.

Зависимостей нет — нужен только Node.js 18+.

## Запуск

```bash
node server.js
# или
npm start
```

Порт по умолчанию `8080`. Переменные окружения:

| Переменная        | По умолчанию | Назначение                                   |
|-------------------|--------------|----------------------------------------------|
| `PORT`                 | `8080`  | Порт прослушивания                                         |
| `MAX_TTL`              | `3600`  | Жёсткий потолок времени жизни метки (сек)                  |
| `MAX_PER_SERVER`       | `256`   | Лимит активных меток на один игровой сервер                |
| `FUNTIME_API_TOKEN`    | —       | Сид-токен FunTime API (можно задать и через admin-эндпоинт)|
| `FUNTIME_ADMIN_SECRET` | —       | Секрет для `/api/admin/funtime`. Пусто → admin отключён    |
| `FUNTIME_POLL_MS`      | `1000`  | Период фонового опроса FunTime API (мс)                    |
| `FUNTIME_TOKEN_FILE`   | `.funtime-token` | Файл, где персистится токен (переживает рестарт)  |

## Подключение мода

В моде включите модуль **Community** (категория Render) и в его настройке **«Сервер (URL)»**
укажите базовый адрес этого бэкенда, например:

```
https://markers.ваш-домен.рф
```

Без `/` на конце и без пути — мод сам добавит `/api/markers`.

Затем задайте **«Кнопка метки»**. Нажатие, когда смотрите на блок, ставит маяк; повторное
нажатие по своей метке — убирает её. Метку видят все игроки с включённым модулем **на том же
Minecraft-сервере**.

## API

```
POST /api/markers
  body: { server, owner, x, y, z, color, ttl, label }
  ->    { ok: true, id, expiresAt }

GET  /api/markers?server=<id>
  ->    { ok: true, markers: [ { id, owner, x, y, z, color, label, createdAt, expiresAt } ] }

POST /api/markers/delete
  body: { server, id }
  ->    { ok: true|false }

GET  /            (health) -> { ok: true, markers, servers }
```

## FunTime-ивенты

Раньше «проверка ивентов» жила на сайте (Vercel, serverless) с кэшем в Postgres — костыль, потому что
serverless не держит состояние между холодными стартами. Здесь логика перенесена на этот персистентный
VPS-процесс: фоновый поллер **раз в секунду** опрашивает FunTime API (`api.funtime.su`) и держит готовый
снапшот **в памяти**. Любой запрос клиента отдаётся мгновенно из кэша — FunTime API видит ровно один
refresh в секунду независимо от числа игроков.

```
GET  /api/client/funtime/events?mode=current|upcoming|mines
  ->  { success, error, entries: [ { server, name, details, coords, source, status, timeSeconds, mine, running } ], updatedAt, mode, source, nextRefreshInMs }
  (алиас: GET /api/funtime/events)

GET  /api/admin/funtime?secret=<FUNTIME_ADMIN_SECRET>
  ->  { ok, configured, tokenPreview, cachedAt, cachedEntries, cacheSuccess, cacheError, pollMs, nextRefreshInMs }

POST /api/admin/funtime
  body: { secret, action: "token"|"refresh", token? }
  ->    { ok, ...adminState }   // action "token" сохраняет токен (в файл), "refresh" форсит опрос сейчас
```

Установка токена в рантайме (сохранится в `FUNTIME_TOKEN_FILE` и переживёт рестарт):

```bash
curl -X POST http://45.132.19.133/api/admin/funtime \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<ваш-секрет>","action":"token","token":"<токен-funtime>"}'
```

- Без `FUNTIME_ADMIN_SECRET` в окружении admin-эндпоинты отвечают `503 admin disabled`.
- Если упрётесь в лимит токена FunTime (HTTP 402) — поднимите `FUNTIME_POLL_MS` (например, до `2000`).
- Мод (`FunTimeEventsClient`) ходит на `GET /api/client/funtime/events` того же хоста, что и Community.

- `server` — адрес Minecraft-сервера (мод подставляет его автоматически, в нижнем регистре).
- `color` — упакованный ARGB `int` (как в Java). `-1` означает «использовать цвет из настроек клиента».
- `ttl` — время жизни в секундах (обрезается до `MAX_TTL`).

## Деплой на хостинг

### systemd (VPS)

```ini
# /etc/systemd/system/moonlight-community.service
[Unit]
Description=MoonLight Community backend
After=network.target

[Service]
WorkingDirectory=/opt/moonlight-community
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now moonlight-community
```

Поставьте перед сервисом nginx/Caddy с HTTPS и проксируйте на `127.0.0.1:8080`.

### pm2

```bash
pm2 start server.js --name moonlight-community
pm2 save
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server.js funtime.js package.json ./
EXPOSE 8080
CMD ["node", "server.js"]
```

## Заметки

- Хранилище **в памяти**: при перезапуске метки сбрасываются (для временных маяков это норм).
  Если нужна постоянность — замените `STORE` на Redis/SQLite, контракт API менять не придётся.
- CORS открыт (`*`), чтобы при желании можно было сделать веб-карту меток.
- Все входные строки чистятся и обрезаются; тело запроса ограничено 16 КБ.

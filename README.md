# 🕵️ Находка для шпиона (Spyfall)

Лёгкая мультиплеерная веб-игра в стиле Spyfall. Работает в реальном времени через WebSocket.

- **Фронтенд:** один файл `index.html` (React 18 + Tailwind + Socket.IO Client), хостится на GitHub Pages.
- **Бэкенд:** Node.js + Express + Socket.IO, полностью In-Memory, хостится на Render (Docker).
- Без базы данных. При перезапуске бэкенда комнаты сбрасываются — это нормально.

---

## Локальный запуск бэкенда

```bash
npm install
npm start
# сервер на http://localhost:3000
```

Проверка: `GET http://localhost:3000/health` → `{ "ok": true }`

## Локальный запуск фронтенда

Откройте `index.html` через локальный сервер (например, VS Code Live Server на порту 5500),
зайдите в ⚙️ настройки и укажите URL бэкенда `http://localhost:3000`.

---

## Деплой

### 1. Бэкенд на Render
1. Создайте **Web Service**, источник — этот GitHub-репозиторий.
2. Environment: **Docker** (Render сам найдёт `Dockerfile`).
3. После деплоя получите URL вида `https://<имя>.onrender.com`.
4. Проверьте `https://<имя>.onrender.com/health`.

### 2. Фронтенд на GitHub Pages
1. Settings → Pages → Source: ветка `main`, папка `/ (root)`.
2. Файл `CNAME` уже содержит `getscriptwave.online`.
3. В игре откройте ⚙️ и впишите URL вашего Render-бэкенда (или поправьте `DEFAULT_BACKEND_URL` в `index.html`).

### 3. DNS для домена getscriptwave.online (Spaceship)
A-записи для корня `@`:
```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```
CNAME для `www` → `fa4891922-boop.github.io`

---

## Игра
- Создайте комнату, поделитесь 4-буквенным кодом.
- Минимум 3 игрока, максимум 12. Раунд — 8 минут.
- Сервер тайно выбирает локацию и одного шпиона.
- Удерживайте кнопку, чтобы посмотреть свою роль.
- Тапайте по игрокам — формируется тепловая карта подозрений.

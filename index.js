// ============================================================================
// Spyfall — "Находка для шпиона"
// Backend: Node.js + Express + Socket.IO 4. Полностью In-Memory.
// ============================================================================

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

// ----------------------------------------------------------------------------
// Константы
// ----------------------------------------------------------------------------
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const ROUND_DURATION_SECONDS = 480; // 8 минут
const ROOM_CODE_LENGTH = 4;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 минут
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
// Локации (>= 30)
// ----------------------------------------------------------------------------
const LOCATIONS = [
  "Аэропорт", "Банк", "Больница", "Отель", "Ресторан",
  "Школа", "Университет", "Полицейский участок", "Пожарная станция", "Космическая станция",
  "Пиратский корабль", "Подводная лодка", "Поезд", "Самолёт", "Круизный лайнер",
  "Кинотеатр", "Театр", "Музей", "Библиотека", "Супермаркет",
  "Торговый центр", "Стадион", "Фитнес-клуб", "Спа-салон", "Пляж",
  "Горнолыжный курорт", "Военная база", "Посольство", "Церковь", "Зоопарк",
  "Цирк", "Ферма", "Стройплощадка", "Завод", "Офис",
  "Суд", "Тюрьма", "Казино", "Ночной клуб", "Метро"
];

// ----------------------------------------------------------------------------
// Разрешённые origin для CORS
// ----------------------------------------------------------------------------
const allowedOrigins = [
  "https://getscriptwave.online",
  "https://www.getscriptwave.online",
  "https://fa4891922-boop.github.io",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5500",
  "http://localhost:5500"
];

// ----------------------------------------------------------------------------
// In-Memory state
// ----------------------------------------------------------------------------
const rooms = new Map();

// ----------------------------------------------------------------------------
// Express + HTTP + Socket.IO
// ----------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: allowedOrigins, credentials: true }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.json({ name: "Spyfall backend", ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// ----------------------------------------------------------------------------
// Утилиты
// ----------------------------------------------------------------------------
function validatePlayerName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 15) return null;
  return trimmed;
}

function validateRoomCode(code) {
  if (typeof code !== "string") return null;
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(normalized)) return null;
  return normalized;
}

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  do {
    code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createPublicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    suspectId: player.suspectId
  };
}

// КРИТИЧНО: клиентам отправляется ТОЛЬКО публичная версия комнаты.
function getPublicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(createPublicPlayer),
    timeLeft: room.timeLeft,
    locationsList: room.locationsList
  };
}

function calculateSuspicionHeatmap(room) {
  const suspectCounts = {};
  for (const player of room.players) {
    if (player.suspectId) {
      suspectCounts[player.suspectId] = (suspectCounts[player.suspectId] || 0) + 1;
    }
  }
  return suspectCounts;
}

function touch(room) {
  room.lastActivityAt = Date.now();
}

function emitRoomUpdate(room) {
  io.to(room.code).emit("room_updated", getPublicRoom(room));
}

function emitHeatmap(room) {
  io.to(room.code).emit("suspicion_heatmap", { suspectCounts: calculateSuspicionHeatmap(room) });
}

function sendError(socket, code, message) {
  socket.emit("error_message", { code, message });
}

function findPlayerRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socketId)) return room;
  }
  return null;
}

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

// ----------------------------------------------------------------------------
// Игровая логика
// ----------------------------------------------------------------------------
function startRoomTimer(room) {
  stopTimer(room);
  room.timer = setInterval(() => {
    room.timeLeft -= 1;
    io.to(room.code).emit("timer_tick", { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      endGame(room, "time_up");
    }
  }, 1000);
}

function endGame(room, reason) {
  stopTimer(room);

  const spy = room.players.find(p => p.id === room.spyId);
  const spyName = spy ? spy.name : null;
  const location = room.location;

  io.to(room.code).emit("game_ended", { reason, location, spyName });

  // Сброс раунда -> комната снова в waiting
  room.status = "waiting";
  room.location = null;
  room.spyId = null;
  room.timeLeft = ROUND_DURATION_SECONDS;
  for (const p of room.players) {
    p.role = null;
    p.suspectId = null;
  }
  touch(room);
  emitRoomUpdate(room);
  emitHeatmap(room);
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room) stopTimer(room);
  rooms.delete(roomCode);
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.players.length === 0) {
      cleanupRoom(code);
      continue;
    }
    if (room.status === "waiting" && now - room.lastActivityAt > ROOM_TTL_MS) {
      cleanupRoom(code);
    }
  }
}
setInterval(cleanupRooms, CLEANUP_INTERVAL_MS);

// Обработка выхода игрока (общая для leave_room и disconnect)
function removePlayer(socket, room) {
  if (!room) return;

  const wasSpy = room.spyId === socket.id;
  const leavingPlayer = room.players.find(p => p.id === socket.id);
  const wasHost = leavingPlayer ? leavingPlayer.isHost : false;

  // Удаляем игрока
  room.players = room.players.filter(p => p.id !== socket.id);

  // Снимаем подозрения, указывающие на ушедшего
  for (const p of room.players) {
    if (p.suspectId === socket.id) p.suspectId = null;
  }

  socket.leave(room.code);

  // Пустая комната -> удалить
  if (room.players.length === 0) {
    cleanupRoom(room.code);
    return;
  }

  // Переназначить хоста
  if (wasHost && !room.players.some(p => p.isHost)) {
    room.players[0].isHost = true;
  }

  touch(room);

  // Завершение раунда по системным причинам
  if (room.status === "playing") {
    if (wasSpy) {
      endGame(room, "spy_left");
      return;
    }
    if (room.players.length < MIN_PLAYERS) {
      endGame(room, "not_enough_players");
      return;
    }
  }

  emitRoomUpdate(room);
  emitHeatmap(room);
}

// ----------------------------------------------------------------------------
// Socket.IO события
// ----------------------------------------------------------------------------
io.on("connection", (socket) => {

  socket.on("create_room", (payload = {}) => {
    const name = validatePlayerName(payload.playerName);
    if (!name) return sendError(socket, "INVALID_NAME", "Введите имя от 1 до 15 символов.");

    const code = generateRoomCode();
    const player = { id: socket.id, name, role: null, isHost: true, suspectId: null };
    const room = {
      code,
      status: "waiting",
      players: [player],
      location: null,
      spyId: null,
      timeLeft: ROUND_DURATION_SECONDS,
      timer: null,
      locationsList: LOCATIONS,
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };
    rooms.set(code, room);
    socket.join(code);

    socket.emit("room_created", { code, room: getPublicRoom(room) });
    emitRoomUpdate(room);
  });

  socket.on("join_room", (payload = {}) => {
    const code = validateRoomCode(payload.code);
    if (!code) return sendError(socket, "INVALID_ROOM_CODE", "Код комнаты должен состоять из 4 латинских букв.");

    const name = validatePlayerName(payload.playerName);
    if (!name) return sendError(socket, "INVALID_NAME", "Введите имя от 1 до 15 символов.");

    const room = rooms.get(code);
    if (!room) return sendError(socket, "ROOM_NOT_FOUND", "Комната не найдена.");
    if (room.status !== "waiting") return sendError(socket, "GAME_ALREADY_STARTED", "Игра уже началась. Дождитесь следующего раунда.");
    if (room.players.length >= MAX_PLAYERS) return sendError(socket, "ROOM_FULL", "Комната заполнена.");

    const player = { id: socket.id, name, role: null, isHost: false, suspectId: null };
    room.players.push(player);
    socket.join(code);
    touch(room);

    socket.emit("room_joined", { code, room: getPublicRoom(room) });
    emitRoomUpdate(room);
  });

  socket.on("start_game", (payload = {}) => {
    const code = validateRoomCode(payload.code);
    if (!code) return sendError(socket, "INVALID_ROOM_CODE", "Неверный код комнаты.");

    const room = rooms.get(code);
    if (!room) return sendError(socket, "ROOM_NOT_FOUND", "Комната не найдена.");

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return sendError(socket, "PLAYER_NOT_IN_ROOM", "Вы не в этой комнате.");
    if (!player.isHost) return sendError(socket, "ONLY_HOST_CAN_START", "Только хост может начать игру.");
    if (room.status !== "waiting") return sendError(socket, "GAME_ALREADY_STARTED", "Игра уже идёт.");
    if (room.players.length < MIN_PLAYERS) return sendError(socket, "NOT_ENOUGH_PLAYERS", "Для старта нужно минимум 3 игрока.");

    // Сброс перед новым раундом
    for (const p of room.players) {
      p.role = null;
      p.suspectId = null;
    }

    // Выбор локации и шпиона
    room.location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
    const spy = room.players[Math.floor(Math.random() * room.players.length)];
    room.spyId = spy.id;

    for (const p of room.players) {
      p.role = p.id === room.spyId ? "spy" : "local";
    }

    room.status = "playing";
    room.timeLeft = ROUND_DURATION_SECONDS;
    touch(room);

    // Публичное состояние всем
    io.to(code).emit("game_started", { room: getPublicRoom(room) });

    // Индивидуальные роли
    for (const p of room.players) {
      if (p.id === room.spyId) {
        io.to(p.id).emit("your_role", { role: "spy", roleLabel: "Шпион", isSpy: true, location: "???" });
      } else {
        io.to(p.id).emit("your_role", { role: "local", roleLabel: "Местный", isSpy: false, location: room.location });
      }
    }

    emitHeatmap(room);
    startRoomTimer(room);
  });

  socket.on("update_suspicion", (payload = {}) => {
    const code = validateRoomCode(payload.code);
    if (!code) return sendError(socket, "INVALID_ROOM_CODE", "Неверный код комнаты.");

    const room = rooms.get(code);
    if (!room) return sendError(socket, "ROOM_NOT_FOUND", "Комната не найдена.");

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return sendError(socket, "PLAYER_NOT_IN_ROOM", "Вы не в этой комнате.");
    if (room.status !== "playing") return sendError(socket, "ROOM_NOT_PLAYING", "Игра сейчас не идёт.");

    const suspectId = payload.suspectId;
    if (suspectId !== null) {
      if (suspectId === socket.id) return sendError(socket, "CANNOT_SUSPECT_SELF", "Нельзя подозревать самого себя.");
      if (!room.players.some(p => p.id === suspectId)) return sendError(socket, "INVALID_SUSPECT", "Такого игрока нет в комнате.");
    }

    player.suspectId = suspectId;
    touch(room);

    emitHeatmap(room);
    emitRoomUpdate(room);
  });

  socket.on("end_game", (payload = {}) => {
    const code = validateRoomCode(payload.code);
    if (!code) return sendError(socket, "INVALID_ROOM_CODE", "Неверный код комнаты.");

    const room = rooms.get(code);
    if (!room) return sendError(socket, "ROOM_NOT_FOUND", "Комната не найдена.");

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return sendError(socket, "PLAYER_NOT_IN_ROOM", "Вы не в этой комнате.");
    if (!player.isHost) return sendError(socket, "ONLY_HOST_CAN_START", "Только хост может завершить игру.");
    if (room.status !== "playing") return sendError(socket, "ROOM_NOT_PLAYING", "Игра сейчас не идёт.");

    endGame(room, payload.reason === "spy_found" ? "spy_found" : "host_ended");
  });

  socket.on("leave_room", (payload = {}) => {
    const code = validateRoomCode(payload.code);
    const room = code ? rooms.get(code) : findPlayerRoom(socket.id);
    removePlayer(socket, room);
  });

  socket.on("disconnect", () => {
    const room = findPlayerRoom(socket.id);
    removePlayer(socket, room);
  });
});

server.listen(PORT, () => {
  console.log(`Spyfall backend listening on port ${PORT}`);
});

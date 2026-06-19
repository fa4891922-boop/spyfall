// Игра «Шпион» (Spyfall) — сервер на Node.js + Express + Socket.IO
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const LOCATIONS = require("./locations");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Раздача статических файлов фронтенда
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));

// ===== Состояние игры =====
const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function publicPlayers(room) {
  return room.order
    .filter((id) => room.players[id])
    .map((id) => ({
      id,
      name: room.players[id].name,
      connected: room.players[id].connected,
      isHost: id === room.hostId,
    }));
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("roomUpdate", {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    state: room.state,
  });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startGame(room, durationMinutes) {
  const playerIds = room.order.filter((id) => room.players[id] && room.players[id].connected);
  if (playerIds.length < 3) {
    io.to(room.hostId).emit("errorMsg", "Нужно минимум 3 игрока, чтобы начать.");
    return;
  }

  const location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
  const spyId = playerIds[Math.floor(Math.random() * playerIds.length)];
  const shuffledRoles = shuffle(location.roles);

  room.state = "playing";
  room.round = {
    locationName: location.name,
    spyId,
    startedAt: Date.now(),
    durationMs: durationMinutes * 60 * 1000,
  };

  let roleIndex = 0;
  playerIds.forEach((id) => {
    if (id === spyId) {
      io.to(id).emit("roleAssigned", {
        isSpy: true,
        location: null,
        role: "Шпион",
        locations: LOCATIONS.map((l) => l.name),
        durationMs: room.round.durationMs,
      });
    } else {
      const role = shuffledRoles[roleIndex % shuffledRoles.length];
      roleIndex++;
      io.to(id).emit("roleAssigned", {
        isSpy: false,
        location: location.name,
        role,
        locations: LOCATIONS.map((l) => l.name),
        durationMs: room.round.durationMs,
      });
    }
  });

  clearRoomTimer(room);
  room.timerInterval = setInterval(() => {
    const elapsed = Date.now() - room.round.startedAt;
    const remaining = Math.max(0, room.round.durationMs - elapsed);
    io.to(room.code).emit("timerTick", { remaining });
    if (remaining <= 0) {
      clearRoomTimer(room);
      endGame(room, "Время вышло!");
    }
  }, 1000);

  broadcastRoom(room.code);
}

function endGame(room, reason) {
  if (!room.round) return;
  clearRoomTimer(room);
  const spy = room.players[room.round.spyId];
  io.to(room.code).emit("gameEnded", {
    reason: reason || "Игра окончена",
    locationName: room.round.locationName,
    spyName: spy ? spy.name : "(вышел)",
  });
  room.state = "lobby";
  room.round = null;
  broadcastRoom(room.code);
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("createRoom", ({ name }, cb) => {
    const code = genRoomCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      players: {},
      order: [],
      state: "lobby",
      round: null,
      timerInterval: null,
    };
    joinRoom(code, name);
    if (cb) cb({ ok: true, code });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) {
      if (cb) cb({ ok: false, error: "Комната не найдена." });
      return;
    }
    if (room.state === "playing") {
      if (cb) cb({ ok: false, error: "Игра уже идёт. Дождитесь окончания раунда." });
      return;
    }
    joinRoom(code, name);
    if (cb) cb({ ok: true, code });
  });

  function joinRoom(code, name) {
    const room = rooms[code];
    if (!room) return;
    currentRoom = code;
    socket.join(code);
    room.players[socket.id] = {
      id: socket.id,
      name: (name || "Игрок").slice(0, 20),
      connected: true,
    };
    if (!room.order.includes(socket.id)) room.order.push(socket.id);
    broadcastRoom(code);
  }

  socket.on("startGame", ({ duration }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit("errorMsg", "Только ведущий может начать игру.");
      return;
    }
    const mins = Math.min(15, Math.max(1, parseInt(duration, 10) || 8));
    startGame(room, mins);
  });

  socket.on("stopGame", () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (socket.id !== room.hostId) return;
    endGame(room, "Ведущий завершил раунд.");
  });

  socket.on("disconnect", () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.players[socket.id]) {
      room.players[socket.id].connected = false;
    }

    if (socket.id === room.hostId) {
      const nextHost = room.order.find(
        (id) => room.players[id] && room.players[id].connected && id !== socket.id
      );
      if (nextHost) room.hostId = nextHost;
    }

    const anyConnected = room.order.some((id) => room.players[id] && room.players[id].connected);
    if (!anyConnected) {
      clearRoomTimer(room);
      delete rooms[currentRoom];
      return;
    }
    broadcastRoom(currentRoom);
  });
});

server.listen(PORT, () => {
  console.log(`Шпион сервер запущен на порту ${PORT}`);
});

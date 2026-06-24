// Игра «Шпион» (Spyfall) — сервер (упрощённая версия 3.0).
// Без ролей, чата, ботов, спец-ролей и голосовых. Общение — в Discord.
// Игрок видит только локацию или «ТЫ ШПИОН». Есть таймер раунда,
// голосование, угадывание локации шпионом, счётчик раундов и статистика сессии.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

// ===== Загрузка наборов локаций из data/locations =====
const LOC_DIR = path.join(__dirname, "data", "locations");
let LOCATION_SETS = {};        // id -> { id, title, locations:[{name, hint}] }
let LOCATION_SETS_META = [];   // [{ id, title, count }]

function loadLocationSets() {
  LOCATION_SETS = {};
  LOCATION_SETS_META = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(LOC_DIR, "index.json"), "utf8"));
    manifest.sets.forEach((s) => {
      try {
        const locations = JSON.parse(fs.readFileSync(path.join(LOC_DIR, s.file), "utf8"));
        LOCATION_SETS[s.id] = { id: s.id, title: s.title, locations };
        LOCATION_SETS_META.push({ id: s.id, title: s.title, count: locations.length });
      } catch (e) { console.error("Не удалось загрузить набор", s.file, e.message); }
    });
  } catch (e) {
    console.error("Нет манифеста локаций:", e.message);
  }
}
loadLocationSets();
function getSet(setId) { return LOCATION_SETS[setId] || LOCATION_SETS.classic || Object.values(LOCATION_SETS)[0]; }

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_ROOMS = 50;
const ROOM_IDLE_MS = 10 * 60 * 1000;        // пустая комната живёт 10 мин
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // чистка раз в 30 мин
const startedAt = Date.now();

const analytics = { totalGames: 0, popularLocations: {} };

// ===== Rate limiting для сокетов (без внешних зависимостей) =====
const socketLimits = new Map();
function rateLimited(socketId, action, max, windowMs) {
  const now = Date.now();
  let s = socketLimits.get(socketId);
  if (!s) { s = {}; socketLimits.set(socketId, s); }
  if (!s[action]) s[action] = [];
  s[action] = s[action].filter((t) => now - t < windowMs);
  if (s[action].length >= max) return true;
  s[action].push(now);
  return false;
}

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.send("ok"));

function countPlayers() {
  let players = 0;
  Object.values(rooms).forEach((r) => { players += Object.values(r.players).filter((p) => p.connected).length; });
  return players;
}

app.get("/stats", (req, res) => {
  const popular = Object.entries(analytics.popularLocations).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  res.json({
    rooms: Object.keys(rooms).length,
    players: countPlayers(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalGames: analytics.totalGames,
    popularLocations: popular,
  });
});

app.get("/api/locations", (req, res) => res.json({ sets: LOCATION_SETS_META }));

const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = ""; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms[code]);
  return code;
}

function enforceRoomLimit() {
  const codes = Object.keys(rooms);
  if (codes.length < MAX_ROOMS) return;
  let oldest = null, oldestTime = Infinity;
  for (const code of codes) {
    const r = rooms[code];
    const anyConnected = Object.values(r.players).some((p) => p.connected);
    const t = r.lastActivity || 0;
    if (!anyConnected && t < oldestTime) { oldest = code; oldestTime = t; }
  }
  if (!oldest) for (const code of codes) { const t = rooms[code].lastActivity || 0; if (t < oldestTime) { oldest = code; oldestTime = t; } }
  if (oldest) { clearRoomTimer(rooms[oldest]); delete rooms[oldest]; }
}

setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    const anyConnected = Object.values(r.players).some((p) => p.connected);
    if (!anyConnected) {
      const idleSince = r.emptySince || r.lastActivity || 0;
      if (now - idleSince > ROOM_IDLE_MS) { clearRoomTimer(r); delete rooms[code]; }
    }
  }
}, CLEANUP_INTERVAL_MS);

function touch(room) { if (room) room.lastActivity = Date.now(); }

function publicPlayers(room) {
  return room.order.filter((id) => room.players[id]).map((id) => ({
    id, name: room.players[id].name, connected: room.players[id].connected,
    isHost: id === room.hostId, score: room.scores?.[id] || 0,
    spyCount: room.stats?.[id]?.spyCount || 0,
  }));
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("roomUpdate", {
    code: room.code, hostId: room.hostId, players: publicPlayers(room),
    state: room.state, roundNum: room.roundCount || 0, setId: room.setId,
  });
}

function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function clearRoomTimer(room) {
  if (room.timerTimeout) { clearTimeout(room.timerTimeout); room.timerTimeout = null; }
}

function ensureStat(room, id) {
  if (!room.stats) room.stats = {};
  if (!room.stats[id]) room.stats[id] = { games: 0, spyCount: 0, wins: 0 };
  return room.stats[id];
}

function startGame(room, opts = {}) {
  const durationMinutes = Math.min(15, Math.max(1, parseInt(opts.duration, 10) || 8));
  room.setId = LOCATION_SETS[opts.setId] ? opts.setId : (room.setId || "classic");

  const playerIds = room.order.filter((id) => room.players[id] && room.players[id].connected);
  if (playerIds.length < 3) { io.to(room.hostId).emit("errorMsg", "Нужно минимум 3 игрока."); return; }

  const LOCATIONS = getSet(room.setId).locations;

  // Колода локаций без повторов
  if (!room.locationBag || room.locationBag.length === 0 || room.bagSetId !== room.setId) {
    let bag = shuffle(LOCATIONS.map((l) => l.name));
    if (room.lastLocation && bag.length > 1 && bag[0] === room.lastLocation) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    room.locationBag = bag;
    room.bagSetId = room.setId;
  }
  const locationName = room.locationBag.shift();
  room.lastLocation = locationName;
  const location = LOCATIONS.find((l) => l.name === locationName) || LOCATIONS[0];

  analytics.totalGames++;
  analytics.popularLocations[location.name] = (analytics.popularLocations[location.name] || 0) + 1;

  const spyId = playerIds[Math.floor(Math.random() * playerIds.length)];
  const allLocNames = LOCATIONS.map((l) => l.name);
  room.roundCount = (room.roundCount || 0) + 1;

  room.state = "playing";
  room.round = {
    locationName: location.name, spyId,
    startedAt: Date.now(), durationMs: durationMinutes * 60 * 1000,
    endsAt: Date.now() + durationMinutes * 60 * 1000,
  };
  room.vote = null;

  const playersInfo = publicPlayers(room);
  playerIds.forEach((id) => {
    const isSpy = id === spyId;
    io.to(id).emit("roleAssigned", {
      isSpy,
      location: isSpy ? null : location.name,
      locationHint: isSpy ? null : (location.hint || ""),
      locations: allLocNames,
      players: playersInfo,
      durationMs: room.round.durationMs,
      endsAt: room.round.endsAt,
      roundNum: room.roundCount,
    });
    const st = ensureStat(room, id); st.games++; if (isSpy) st.spyCount++;
  });

  clearRoomTimer(room);
  room.timerTimeout = setTimeout(() => {
    io.to(room.code).emit("timeUp");
  }, room.round.durationMs);

  touch(room);
  broadcastRoom(room.code);
}

function endGame(room, reason, winner) {
  if (!room.round) return;
  clearRoomTimer(room);
  const spy = room.players[room.round.spyId];
  if (!room.scores) room.scores = {};

  if (winner === "spy") {
    if (spy) room.scores[room.round.spyId] = (room.scores[room.round.spyId] || 0) + 2;
    ensureStat(room, room.round.spyId).wins++;
  } else if (winner === "citizens") {
    room.order.forEach((id) => {
      if (room.players[id]?.connected && id !== room.round.spyId) {
        room.scores[id] = (room.scores[id] || 0) + 1;
        ensureStat(room, id).wins++;
      }
    });
  }

  const leaderboard = Object.entries(room.stats || {})
    .filter(([id]) => room.players[id])
    .map(([id, s]) => ({ id, name: room.players[id].name, ...s, score: room.scores[id] || 0 }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit("gameEnded", {
    reason: reason || "Раунд окончен",
    locationName: room.round.locationName,
    spyName: spy ? spy.name : "(вышел)",
    spyId: room.round.spyId,
    winner: winner || "none",
    scores: room.scores,
    leaderboard,
    roundNum: room.roundCount,
    lastVotes: room.round.lastVotes || null,
  });
  room.state = "lobby"; room.round = null; room.vote = null;
  touch(room);
  broadcastRoom(room.code);
}

function resolveVote(room) {
  const vote = room.vote;
  if (!vote || !room.round) return;
  const connectedPlayers = room.order.filter((id) => room.players[id]?.connected);
  const totalVoters = connectedPlayers.filter((id) => id !== vote.targetId).length;
  const allYes = vote.yes.length >= totalVoters && vote.no.length === 0 && totalVoters > 0;
  room.round.lastVotes = {
    targetName: room.players[vote.targetId]?.name || "???",
    yes: vote.yes.map((id) => room.players[id]?.name).filter(Boolean),
    no: vote.no.map((id) => room.players[id]?.name).filter(Boolean),
  };
  room.vote = null;

  if (allYes) {
    const targetIsSpy = room.round.spyId === vote.targetId;
    const targetName = room.players[vote.targetId]?.name || "???";
    io.to(room.code).emit("voteResult", { passed: true, targetName, targetId: vote.targetId, isSpy: targetIsSpy });
    if (targetIsSpy) endGame(room, `Шпион ${targetName} разоблачён!`, "citizens");
    else endGame(room, `Невиновный ${targetName} обвинён! Шпион победил.`, "spy");
  } else {
    const vt = room.players[vote.targetId]?.name || "???";
    io.to(room.code).emit("voteResult", { passed: false, targetName: vt, targetId: vote.targetId, yesCount: vote.yes.length, noCount: vote.no.length });
  }
}

function emitVoteUpdate(room) {
  if (!room.vote) return;
  io.to(room.code).emit("voteUpdate", {
    initiatorId: room.vote.initiatorId, initiatorName: room.players[room.vote.initiatorId]?.name,
    targetId: room.vote.targetId, targetName: room.players[room.vote.targetId]?.name,
    yesNames: room.vote.yes.map((id) => room.players[id]?.name),
    noNames: room.vote.no.map((id) => room.players[id]?.name),
  });
}

function checkAllVoted(room) {
  if (!room.vote) return;
  const connectedPlayers = room.order.filter((id) => room.players[id]?.connected);
  const voted = new Set([...room.vote.yes, ...room.vote.no]);
  const allVoted = connectedPlayers.every((id) => id === room.vote.targetId || voted.has(id));
  if (allVoted) resolveVote(room);
}

function rekeyPlayer(room, oldId, newId) {
  if (oldId === newId || !room.players[oldId]) return;
  room.players[newId] = room.players[oldId];
  room.players[newId].id = newId;
  delete room.players[oldId];
  room.order = room.order.map((id) => (id === oldId ? newId : id));
  if (room.hostId === oldId) room.hostId = newId;
  if (room.scores && room.scores[oldId] != null) { room.scores[newId] = room.scores[oldId]; delete room.scores[oldId]; }
  if (room.stats && room.stats[oldId]) { room.stats[newId] = room.stats[oldId]; delete room.stats[oldId]; }
  if (room.round && room.round.spyId === oldId) room.round.spyId = newId;
  if (room.vote) {
    const v = room.vote;
    if (v.targetId === oldId) v.targetId = newId;
    if (v.initiatorId === oldId) v.initiatorId = newId;
    v.yes = v.yes.map((id) => (id === oldId ? newId : id));
    v.no = v.no.map((id) => (id === oldId ? newId : id));
  }
}

io.on("connection", (socket) => {
  let currentRoom = null;

  function joinRoom(code, name, sessionId) {
    const room = rooms[code];
    if (!room) return;
    currentRoom = code;
    const safeName = (name || "Игрок").toString().trim().slice(0, 20) || "Игрок";
    room.players[socket.id] = { id: socket.id, name: safeName, connected: true, sessionId };
    if (!room.order.includes(socket.id)) room.order.push(socket.id);
    if (!room.hostId) room.hostId = socket.id;
    socket.join(code);
    room.emptySince = null;
    touch(room);
    broadcastRoom(code);
  }

  function doResume(room, oldId, name, sessionId) {
    currentRoom = room.code;
    rekeyPlayer(room, oldId, socket.id);
    const p = room.players[socket.id];
    p.connected = true;
    if (name && name.trim()) p.name = name.trim().slice(0, 20);
    p.sessionId = sessionId;
    socket.join(room.code);
    room.emptySince = null;
    touch(room);
    broadcastRoom(room.code);
    if (room.state === "playing" && room.round) {
      const isSpy = room.round.spyId === socket.id;
      const LOCATIONS = getSet(room.setId).locations;
      const location = LOCATIONS.find((l) => l.name === room.round.locationName);
      io.to(socket.id).emit("roleAssigned", {
        isSpy,
        location: isSpy ? null : room.round.locationName,
        locationHint: isSpy ? null : (location?.hint || ""),
        locations: LOCATIONS.map((l) => l.name),
        players: publicPlayers(room),
        durationMs: room.round.durationMs,
        endsAt: room.round.endsAt,
        roundNum: room.roundCount,
      });
    }
  }

  socket.on("createRoom", ({ name, sessionId } = {}, cb) => {
    if (rateLimited(socket.id, "create", 5, 60 * 1000)) { if (cb) cb({ ok: false, error: "Слишком часто. Подождите немного." }); return; }
    enforceRoomLimit();
    if (Object.keys(rooms).length >= MAX_ROOMS) { if (cb) cb({ ok: false, error: "Сервер занят, попробуйте позже." }); return; }
    const code = genRoomCode();
    rooms[code] = {
      code, hostId: socket.id, players: {}, order: [], state: "lobby", round: null, timerTimeout: null,
      vote: null, scores: {}, stats: {}, locationBag: [], lastLocation: null,
      setId: "classic", roundCount: 0, lastActivity: Date.now(), emptySince: null,
    };
    joinRoom(code, name, sessionId);
    if (cb) cb({ ok: true, code });
  });

  socket.on("joinRoom", ({ code, name, sessionId } = {}, cb) => {
    if (rateLimited(socket.id, "join", 10, 60 * 1000)) { if (cb) cb({ ok: false, error: "Слишком часто. Подождите немного." }); return; }
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) { if (cb) cb({ ok: false, error: "Комната не найдена." }); return; }
    if (room.state === "playing") {
      const existingId = sessionId && Object.keys(room.players).find((id) => room.players[id].sessionId === sessionId);
      if (existingId) { doResume(room, existingId, name, sessionId); if (cb) cb({ ok: true, code, resumed: true }); return; }
      if (cb) cb({ ok: false, error: "Игра уже идёт. Дождитесь конца раунда." }); return;
    }
    joinRoom(code, name, sessionId);
    if (cb) cb({ ok: true, code });
  });

  socket.on("resume", ({ code, sessionId, name } = {}, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room || !sessionId) { if (cb) cb({ ok: false }); return; }
    const existingId = Object.keys(room.players).find((id) => room.players[id].sessionId === sessionId);
    if (!existingId) { if (cb) cb({ ok: false }); return; }
    doResume(room, existingId, name, sessionId);
    if (cb) cb({ ok: true, code, state: room.state });
  });

  socket.on("startGame", (opts = {}) => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    if (room.state === "playing") return;
    startGame(room, opts);
  });

  // Шпион угадывает локацию
  socket.on("spyGuess", ({ locationName } = {}) => {
    const room = rooms[currentRoom];
    if (!room || !room.round || room.round.spyId !== socket.id) return;
    const correct = locationName === room.round.locationName;
    const spyName = room.players[socket.id]?.name || "Шпион";
    io.to(room.code).emit("spyGuessResult", { correct, guess: locationName, actual: room.round.locationName, spyName });
    if (correct) endGame(room, `Шпион ${spyName} угадал локацию: ${room.round.locationName}!`, "spy");
    else endGame(room, `Шпион ${spyName} не угадал. Граждане победили!`, "citizens");
  });

  // Начать голосование против игрока
  socket.on("requestVote", ({ targetId } = {}) => {
    const room = rooms[currentRoom];
    if (!room || !room.round || room.vote) return;
    if (!room.players[targetId] || targetId === socket.id) return;
    if (rateLimited(socket.id, "vote", 3, 30 * 1000)) return;
    room.vote = { initiatorId: socket.id, targetId, yes: [socket.id], no: [] };
    emitVoteUpdate(room);
    checkAllVoted(room);
  });

  socket.on("castVote", ({ vote } = {}) => {
    const room = rooms[currentRoom];
    if (!room || !room.vote) return;
    if (socket.id === room.vote.targetId) return;
    if (room.vote.yes.includes(socket.id) || room.vote.no.includes(socket.id)) return;
    if (vote === "yes") room.vote.yes.push(socket.id); else room.vote.no.push(socket.id);
    emitVoteUpdate(room);
    checkAllVoted(room);
  });

  // Хост завершает раунд вручную (например по таймеру)
  socket.on("endRound", () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || !room.round) return;
    endGame(room, "Время вышло. Раунд завершён хостом.", "none");
  });

  socket.on("setLocationSet", ({ setId } = {}) => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    if (LOCATION_SETS[setId]) { room.setId = setId; broadcastRoom(room.code); }
  });

  socket.on("leaveRoom", () => { handleLeave(); });

  function handleLeave() {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id]) return;
    const wasHost = room.hostId === socket.id;
    delete room.players[socket.id];
    room.order = room.order.filter((id) => id !== socket.id);
    socket.leave(room.code);
    if (wasHost) room.hostId = room.order[0] || null;
    if (room.order.length === 0) room.emptySince = Date.now();
    if (room.vote) { room.vote.yes = room.vote.yes.filter((id) => id !== socket.id); room.vote.no = room.vote.no.filter((id) => id !== socket.id); checkAllVoted(room); }
    touch(room);
    broadcastRoom(room.code);
    currentRoom = null;
  }

  socket.on("disconnect", () => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].connected = false;
    if (room.hostId === socket.id) {
      const next = room.order.find((id) => room.players[id]?.connected);
      if (next) room.hostId = next;
    }
    const anyConnected = Object.values(room.players).some((p) => p.connected);
    if (!anyConnected) room.emptySince = Date.now();
    if (room.vote) checkAllVoted(room);
    touch(room);
    broadcastRoom(room.code);
  });
});

server.listen(PORT, () => console.log(`Шпион сервер запущен на порту ${PORT}`));

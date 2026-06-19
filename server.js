// Игра «Шпион» (Spyfall) — пошаговые раунды говорения + авто-голосование
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const LOCATIONS = require("./locations");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 30;

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));

const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = ""; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms[code]);
  return code;
}

function publicPlayers(room) {
  return room.order.filter((id) => room.players[id]).map((id) => ({
    id, name: room.players[id].name, connected: room.players[id].connected,
    isHost: id === room.hostId, score: room.scores?.[id] || 0,
  }));
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("roomUpdate", { code: room.code, hostId: room.hostId, players: publicPlayers(room), state: room.state });
}

function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function clearRoomTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function startGame(room, durationMinutes) {
  const playerIds = room.order.filter((id) => room.players[id] && room.players[id].connected);
  if (playerIds.length < 3) { io.to(room.hostId).emit("errorMsg", "Нужно минимум 3 игрока."); return; }

  const location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
  const spyId = playerIds[Math.floor(Math.random() * playerIds.length)];
  const shuffledRoles = shuffle(location.roles);
  const speakingOrder = shuffle([...playerIds]);

  room.state = "playing";
  room.round = {
    locationName: location.name, spyId, startedAt: Date.now(),
    durationMs: durationMinutes * 60 * 1000,
    phase: "speaking1", roundNum: 1,
    speakingOrder, speakerIndex: 0, turnEndsAt: 0,
  };
  room.vote = null;

  const playersInfo = publicPlayers(room);

  let roleIndex = 0;
  playerIds.forEach((id) => {
    if (id === spyId) {
      io.to(id).emit("roleAssigned", { isSpy: true, location: null, role: "Шпион", locations: LOCATIONS.map((l) => l.name), players: playersInfo, durationMs: room.round.durationMs, speakingOrder });
    } else {
      const role = shuffledRoles[roleIndex % shuffledRoles.length]; roleIndex++;
      io.to(id).emit("roleAssigned", { isSpy: false, location: location.name, role, locations: LOCATIONS.map((l) => l.name), players: playersInfo, durationMs: room.round.durationMs, speakingOrder });
    }
  });

  clearRoomTimer(room);
  startTurn(room);
  broadcastRoom(room.code);
}

function startTurn(room) {
  if (!room.round) return;
  clearRoomTimer(room);

  const { speakingOrder, speakerIndex } = room.round;
  if (speakerIndex >= speakingOrder.length) {
    if (room.round.roundNum === 1) {
      room.round.roundNum = 2;
      room.round.speakerIndex = 0;
      room.round.phase = "speaking2";
      io.to(room.code).emit("phaseChange", { phase: "speaking2", roundNum: 2, message: "Раунд 2 — говорим по второму кругу!" });
      startTurn(room);
    } else {
      room.round.phase = "voting";
      io.to(room.code).emit("phaseChange", { phase: "voting", roundNum: 2, message: "Голосование! Выберите, кого обвинить." });
    }
    return;
  }

  const speakerId = speakingOrder[speakerIndex];
  const speakerName = room.players[speakerId]?.name || "???";
  const turnEndsAt = Date.now() + TURN_SECONDS * 1000;
  room.round.turnEndsAt = turnEndsAt;

  io.to(room.code).emit("turnStarted", {
    speakerId, speakerName, speakerIndex, totalSpeakers: speakingOrder.length,
    roundNum: room.round.roundNum, turnEndsAt,
  });

  room.timerInterval = setInterval(() => {
    const remaining = Math.max(0, turnEndsAt - Date.now());
    io.to(room.code).emit("turnTimerTick", { remaining, speakerId });
    if (remaining <= 0) {
      clearRoomTimer(room);
      io.to(room.code).emit("turnEnded", { speakerId, speakerName });
      room.round.speakerIndex++;
      setTimeout(() => startTurn(room), 1500);
    }
  }, 500);
}

function nextTurn(room) {
  if (!room.round || room.round.phase === "voting") return;
  clearRoomTimer(room);
  const speakerId = room.round.speakingOrder[room.round.speakerIndex];
  const speakerName = room.players[speakerId]?.name || "???";
  io.to(room.code).emit("turnEnded", { speakerId, speakerName });
  room.round.speakerIndex++;
  setTimeout(() => startTurn(room), 800);
}

function endGame(room, reason, winner) {
  if (!room.round) return;
  clearRoomTimer(room);
  const spy = room.players[room.round.spyId];
  if (!room.scores) room.scores = {};
  if (winner === "spy" && spy) {
    room.scores[room.round.spyId] = (room.scores[room.round.spyId] || 0) + 2;
  } else if (winner === "citizens") {
    room.order.forEach((id) => { if (room.players[id]?.connected && id !== room.round.spyId) room.scores[id] = (room.scores[id] || 0) + 1; });
  }
  io.to(room.code).emit("gameEnded", {
    reason: reason || "Игра окончена", locationName: room.round.locationName,
    spyName: spy ? spy.name : "(вышел)", spyId: room.round.spyId,
    winner: winner || "spy", scores: room.scores,
  });
  room.state = "lobby"; room.round = null; room.vote = null;
  broadcastRoom(room.code);
}

function resolveVote(room) {
  const vote = room.vote;
  if (!vote || !room.round) return;
  const connectedPlayers = room.order.filter((id) => room.players[id]?.connected);
  const totalVoters = connectedPlayers.filter((id) => id !== vote.targetId).length;
  const allYes = vote.yes.length >= totalVoters && vote.no.length === 0;
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

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("createRoom", ({ name }, cb) => {
    const code = genRoomCode();
    rooms[code] = { code, hostId: socket.id, players: {}, order: [], state: "lobby", round: null, timerInterval: null, vote: null, scores: {} };
    joinRoom(code, name);
    if (cb) cb({ ok: true, code });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) { if (cb) cb({ ok: false, error: "Комната не найдена." }); return; }
    if (room.state === "playing") { if (cb) cb({ ok: false, error: "Игра уже идёт." }); return; }
    joinRoom(code, name);
    if (cb) cb({ ok: true, code });
  });

  function joinRoom(code, name) {
    const room = rooms[code]; if (!room) return;
    currentRoom = code; socket.join(code);
    room.players[socket.id] = { id: socket.id, name: (name || "Игрок").slice(0, 20), connected: true };
    if (!room.order.includes(socket.id)) room.order.push(socket.id);
    broadcastRoom(code);
  }

  socket.on("startGame", ({ duration }) => {
    const room = rooms[currentRoom]; if (!room || socket.id !== room.hostId) return;
    startGame(room, Math.min(15, Math.max(1, parseInt(duration, 10) || 8)));
  });

  socket.on("stopGame", () => {
    const room = rooms[currentRoom]; if (!room || socket.id !== room.hostId) return;
    endGame(room, "Ведущий завершил раунд.", "spy");
  });

  socket.on("endMyTurn", () => {
    const room = rooms[currentRoom];
    if (!room || !room.round || room.round.phase === "voting") return;
    const speakerId = room.round.speakingOrder[room.round.speakerIndex];
    if (socket.id !== speakerId) return;
    nextTurn(room);
  });

  socket.on("initiateVote", ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== "playing" || room.vote) return;
    if (targetId === socket.id || !room.players[targetId]?.connected) return;
    room.vote = { initiatorId: socket.id, targetId, yes: [], no: [] };
    io.to(currentRoom).emit("voteStarted", { initiatorId: socket.id, initiatorName: room.players[socket.id].name, targetId, targetName: room.players[targetId].name, yes: [], no: [] });
  });

  socket.on("castVote", ({ vote: v }) => {
    const room = rooms[currentRoom]; if (!room || !room.vote) return;
    if (room.vote.yes.includes(socket.id) || room.vote.no.includes(socket.id)) return;
    if (socket.id === room.vote.targetId) return;
    if (v === "yes") room.vote.yes.push(socket.id); else room.vote.no.push(socket.id);
    const connectedPlayers = room.order.filter((id) => room.players[id]?.connected);
    const voted = new Set([...room.vote.yes, ...room.vote.no]);
    const allVoted = connectedPlayers.every((id) => id === room.vote.targetId || voted.has(id));
    io.to(currentRoom).emit("voteUpdate", {
      initiatorId: room.vote.initiatorId, initiatorName: room.players[room.vote.initiatorId]?.name,
      targetId: room.vote.targetId, targetName: room.players[room.vote.targetId]?.name,
      yesNames: room.vote.yes.map((id) => room.players[id]?.name), noNames: room.vote.no.map((id) => room.players[id]?.name),
      yes: room.vote.yes, no: room.vote.no,
    });
    if (allVoted) resolveVote(room);
  });

  socket.on("spyGuess", ({ locationName }) => {
    const room = rooms[currentRoom]; if (!room || room.state !== "playing" || !room.round) return;
    if (socket.id !== room.round.spyId) return;
    const spyName = room.players[socket.id]?.name || "Шпион";
    if (locationName === room.round.locationName) endGame(room, `${spyName} угадал: ${locationName}!`, "spy");
    else endGame(room, `${spyName} ошибся! Локация: ${room.round.locationName}.`, "citizens");
  });

  socket.on("disconnect", () => {
    const room = rooms[currentRoom]; if (!room) return;
    if (room.players[socket.id]) room.players[socket.id].connected = false;
    if (socket.id === room.hostId) {
      const nextHost = room.order.find((id) => room.players[id] && room.players[id].connected && id !== socket.id);
      if (nextHost) room.hostId = nextHost;
    }
    const anyConnected = room.order.some((id) => room.players[id] && room.players[id].connected);
    if (!anyConnected) { clearRoomTimer(room); delete rooms[currentRoom]; return; }
    broadcastRoom(currentRoom);
  });
});

server.listen(PORT, () => console.log(`Шпион сервер запущен на порту ${PORT}`));

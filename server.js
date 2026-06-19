// Игра «Шпион» (Spyfall) — сервер с пошаговыми раундами говорения и авто-голосованием
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const LOCATIONS = require("./locations");

// Большой список подсказок/тем для шпиона
const SPY_TOPICS = [
  "Задайте вопрос о том, во что одеты люди в этом месте.",
  "Спросите, много ли времени люди обычно здесь проводят.",
  "Спросите о цели посещения этого места (работа, отдых, вынужденный визит).",
  "Спросите, тепло здесь или холодно.",
  "Спросите, нужно ли платить за вход в это место.",
  "Спросите, есть ли здесь дети или это место только для взрослых.",
  "Спросите, пахнет ли здесь чем-то особенным.",
  "Задайте вопрос: 'Как часто ты бываешь в таких местах в реальной жизни?'",
  "Задайте вопрос: 'Если бы у тебя был выбор, ты бы остался здесь подольше?'",
  "Спросите, играет ли здесь музыка или тут обычно тихо.",
  "Спросите, опасно ли находиться в этом месте без специальной подготовки.",
  "Спросите, можно ли здесь встретить животных.",
  "Спросите, является ли это место государственным или частным.",
  "Спросите, нужно ли здесь соблюдать тишину.",
  "Спросите: 'Много ли здесь какой-то техники или электроники?'",
  "Задайте вопрос о еде или напитках, которые здесь можно встретить.",
  "Спросите: 'Тебе нравится работать/находиться здесь?'",
  "Спросите: 'Это место находится под открытым небом или в помещении?'",
  "Спросите: 'Требуется ли специальная форма или одежда, чтобы сюда попасть?'",
  "Спросите: 'Есть ли здесь риск испачкаться?'",
  "Спросите: 'Люди приходят сюда в одиночку или большими компаниями?'",
  "Спросите: 'Можно ли отсюда легко уйти в любой момент?'",
  "Спросите: 'Связано ли это место с какими-то поездками или путешествиями?'",
  "Спросите: 'Какое сейчас время суток в твоем понимании здесь?'",
  "Спросите: 'Нужно ли иметь при себе документы, чтобы войти сюда?'",
  "Спросите: 'Ты бы привёл сюда ребёнка или это не то место?'",
  "Спросите: 'Если закрыть глаза, какие звуки ты бы тут услышал?'",
  "Спросите: 'Это место связано с твоей профессией или ты тут как гость?'",
  "Спросите: 'Что бы ты первым делом сделал, оказавшись здесь?'",
  "Спросите: 'Здесь чаще бывает людно или почти пусто?'",
  "Спросите: 'Тебе пришлось бы переодеться, чтобы оказаться здесь?'",
  "Спросите: 'Это место скорее старое и историческое или современное?'",
  "Спросите: 'Здесь принято торопиться или можно никуда не спешить?'"
];


const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 5 MB для аудио

const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 30; // секунд на одного игрока

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
  if (room.timerInterval) { clearTimeout(room.timerInterval); room.timerInterval = null; }
}

function startGame(room, durationMinutes) {
  const playerIds = room.order.filter((id) => room.players[id] && room.players[id].connected);
  if (playerIds.length < 3) { io.to(room.hostId).emit("errorMsg", "Нужно минимум 3 игрока."); return; }

  // ===== Локации без повторов =====
  // Каждая локация выпадает ровно один раз за круг. Когда все пройдены — колода
  // перемешивается заново (так, чтобы последняя локация не повторилась сразу).
  if (!room.locationBag || room.locationBag.length === 0) {
    let bag = shuffle(LOCATIONS.map((l) => l.name));
    if (room.lastLocation && bag.length > 1 && bag[0] === room.lastLocation) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    room.locationBag = bag;
  }
  const locationName = room.locationBag.shift();
  room.lastLocation = locationName;
  const location = LOCATIONS.find((l) => l.name === locationName) || LOCATIONS[0];
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
  room.chatMessages = [];
  room.vote = null;
  room.audioMessages = [];

  const playersInfo = publicPlayers(room);

  // ОДНА тонкая подсказка для шпиона о характере места (не раскрывает локацию прямо)
  const locationHint = location.hint || "Внимательно слушайте других и задавайте хитрые вопросы.";

  // Дополнительно: случайная идея для вопроса (помогает шпиону влиться, но не указывает на место)
  const suggestedTopic = SPY_TOPICS[Math.floor(Math.random() * SPY_TOPICS.length)];

  let roleIndex = 0;
  playerIds.forEach((id) => {
    if (id === spyId) {
      io.to(id).emit("roleAssigned", { 
        isSpy: true, 
        location: null, 
        role: "Шпион", 
        locations: LOCATIONS.map((l) => l.name), 
        players: playersInfo, 
        durationMs: room.round.durationMs, 
        speakingOrder,
        locationHint,   // ОДНА тонкая подсказка о характере места
        suggestedTopic  // идея для вопроса (не раскрывает место)
      });
    } else {
      const role = shuffledRoles[roleIndex % shuffledRoles.length]; roleIndex++;
      io.to(id).emit("roleAssigned", { 
        isSpy: false, 
        location: location.name, 
        role, 
        locations: LOCATIONS.map((l) => l.name), 
        players: playersInfo, 
        durationMs: room.round.durationMs, 
        speakingOrder 
      });
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

  // Оптимизация: один таймер на ход вместо рассылки тиков каждые 500 мс.
  // Клиент сам отрисовывает обратный отсчёт по turnEndsAt.
  room.timerInterval = setTimeout(() => {
    room.timerInterval = null;
    io.to(room.code).emit("turnEnded", { speakerId, speakerName });
    room.round.speakerIndex++;
    setTimeout(() => startTurn(room), 1500);
  }, TURN_SECONDS * 1000);
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
  room.state = "lobby"; room.round = null; room.chatMessages = []; room.vote = null; room.audioMessages = [];
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
    rooms[code] = { code, hostId: socket.id, players: {}, order: [], state: "lobby", round: null, timerInterval: null, chatMessages: [], vote: null, scores: {}, audioMessages: [], locationBag: [], lastLocation: null };
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

  // ===== ГОЛОСОВАНИЕ =====
  // Можно начинать в любой момент игры, сколько угодно раз. Новое голосование заменяет текущее.
  socket.on("initiateVote", ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== "playing") return;
    if (targetId === socket.id || !room.players[targetId]?.connected) return;
    room.vote = { initiatorId: socket.id, targetId, yes: [], no: [] };
    io.to(currentRoom).emit("voteStarted", { initiatorId: socket.id, initiatorName: room.players[socket.id].name, targetId, targetName: room.players[targetId].name, yes: [], no: [] });
  });

  // Отмена голосования — доступна в любой момент, но ТОЛЬКО тому, кто его начал.
  socket.on("cancelVote", () => {
    const room = rooms[currentRoom];
    if (!room || !room.vote) return;
    if (room.vote.initiatorId !== socket.id) return; // отменить может только инициатор
    const byName = room.players[socket.id]?.name || "Игрок";
    room.vote = null;
    io.to(currentRoom).emit("voteCancelled", { byId: socket.id, byName });
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

  // ===== ШПИОН УГАДЫВАЕТ =====
  socket.on("spyGuess", ({ locationName }) => {
    const room = rooms[currentRoom]; if (!room || room.state !== "playing" || !room.round) return;
    if (socket.id !== room.round.spyId) return;
    const spyName = room.players[socket.id]?.name || "Шпион";
    if (locationName === room.round.locationName) endGame(room, `${spyName} угадал: ${locationName}!`, "spy");
    else endGame(room, `${spyName} ошибся! (Выбрал: "${locationName}"). Локация: ${room.round.locationName}.`, "citizens");
  });

  
  // ===== СМЕНА НИКНЕЙМА В ЛОББИ =====
  socket.on("changeName", ({ name }, cb) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id]) { if (cb) cb({ ok: false, error: "Вы не в комнате." }); return; }
    if (room.state !== "lobby") { if (cb) cb({ ok: false, error: "Сменить ник можно только в лобби." }); return; }
    const clean = (name || "").trim().slice(0, 20);
    if (!clean) { if (cb) cb({ ok: false, error: "Введите непустое имя." }); return; }
    room.players[socket.id].name = clean;
    broadcastRoom(currentRoom);
    if (cb) cb({ ok: true, name: clean });
  });

  // ===== СИСТЕМА КИКА ИГРОКОВ (Доступна Ведущему) =====
  socket.on("kickPlayer", ({ playerId }) => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostId) return; // только ведущий может кикать

    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) {
      targetSocket.emit("kicked");
      targetSocket.leave(currentRoom);
    }

    // Удаляем из списка игроков и очередности
    delete room.players[playerId];
    room.order = room.order.filter(id => id !== playerId);
    if (room.round && room.round.speakingOrder) {
      room.round.speakingOrder = room.round.speakingOrder.filter(id => id !== playerId);
    }

    broadcastRoom(currentRoom);
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

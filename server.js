// Игра «Шпион» (Spyfall) — сервер.
// Фазы 1–5: автоочистка, reconnect, лимит комнат, /stats, наборы локаций,
// спец-роли, чат, голосовые, статистика, rate-limit, аналитика, боты, опц. Redis.
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

// ===== Загрузка наборов локаций из data/locations =====
const LOC_DIR = path.join(__dirname, "data", "locations");
const ROLES_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "roles.json"), "utf8"));
let LOCATION_SETS = {};        // id -> { id, title, locations:[] }
let LOCATION_SETS_META = [];   // [{ id, title }]

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
    console.error("Нет манифеста локаций, fallback на locations.js:", e.message);
    const legacy = require("./locations");
    LOCATION_SETS.classic = { id: "classic", title: { ru: "Классический", en: "Classic" }, locations: legacy };
    LOCATION_SETS_META.push({ id: "classic", title: { ru: "Классический", en: "Classic" }, count: legacy.length });
  }
}
loadLocationSets();
function getSet(setId) { return LOCATION_SETS[setId] || LOCATION_SETS.classic || Object.values(LOCATION_SETS)[0]; }

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

// Шаблоны для ботов (чат) и быстрые фразы
const BOT_PHRASES = [
  "Хм, интересный вопрос...", "Я тут уже бывал, кажется.", "Не уверен, что отвечу честно 😏",
  "Зависит от ситуации.", "Очевидно же!", "Ты подозрительно много спрашиваешь.",
  "Давайте не торопиться.", "Я склоняюсь к одному варианту.", "Это точно не я!",
  "Странное у тебя поведение...", "Согласен с предыдущим.", "Надо подумать."
];
const BOT_NAMES = ["Бот-Алекс", "Бот-Маша", "Бот-Гриша", "Бот-Ника", "Бот-Дима", "Бот-Лена", "Бот-Костя", "Бот-Юля"];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 5 MB для аудио

// ===== Опциональный Redis-адаптер для горизонтального масштабирования =====
// Активируется только если задан REDIS_URL и установлены пакеты. Иначе — in-memory.
(async function maybeAttachRedis() {
  if (!process.env.REDIS_URL) return;
  try {
    const { createClient } = require("redis");
    const { createAdapter } = require("@socket.io/redis-adapter");
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    console.log("✅ Redis-адаптер подключён (масштабирование включено).");
  } catch (e) {
    console.warn("⚠️  REDIS_URL задан, но адаптер не подключён:", e.message, "— работаю in-memory.");
  }
})();

const PORT = process.env.PORT || 3000;
const DEFAULT_TURN_SECONDS = 30;
const MAX_ROOMS = 50;
const ROOM_IDLE_MS = 10 * 60 * 1000;   // пустая комната живёт 10 мин
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // чистка раз в 30 мин
const startedAt = Date.now();

// ===== Аналитика =====
const analytics = { totalGames: 0, totalPlayers: 0, popularLocations: {} };
const seenSessions = new Set(); // уникальные игроки по sessionId

// ===== Rate limiting (без внешних зависимостей для сокетов) =====
const socketLimits = new Map(); // socket.id -> { action: [timestamps] }
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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Простейший rate-limit для HTTP API (express-rate-limit, если установлен)
let apiLimiter = (req, res, next) => next();
try {
  const rateLimit = require("express-rate-limit");
  apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
} catch (e) { /* пакет не установлен — лимитер пропускается */ }

app.get("/healthz", (req, res) => res.send("ok"));

function countPlayers() {
  let players = 0;
  Object.values(rooms).forEach((r) => { players += Object.values(r.players).filter((p) => p.connected).length; });
  return players;
}

app.get("/stats", apiLimiter, (req, res) => {
  const popular = Object.entries(analytics.popularLocations).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  res.json({
    rooms: Object.keys(rooms).length,
    players: countPlayers(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totalGames: analytics.totalGames,
    totalPlayers: analytics.totalPlayers,
    popularLocations: popular,
  });
});

// Список наборов локаций
app.get("/api/locations", apiLimiter, (req, res) => {
  res.json({ sets: LOCATION_SETS_META });
});
// Локации конкретного набора (поддержка кастомных наборов через выбор id)
app.get("/api/locations/:set", apiLimiter, (req, res) => {
  const set = LOCATION_SETS[req.params.set];
  if (!set) return res.status(404).json({ error: "Набор не найден" });
  res.json({ id: set.id, title: set.title, locations: set.locations });
});

const rooms = {};

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = ""; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms[code]);
  return code;
}

// ===== Лимит комнат: при превышении удаляем самую старую неактивную =====
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
  if (!oldest) { // если все активны — удаляем самую старую по lastActivity
    for (const code of codes) { const t = rooms[code].lastActivity || 0; if (t < oldestTime) { oldest = code; oldestTime = t; } }
  }
  if (oldest) { clearRoomTimer(rooms[oldest]); delete rooms[oldest]; console.log("Лимит комнат: удалена", oldest); }
}

// ===== Автоочистка: раз в 30 мин удаляем пустые комнаты старше 10 мин =====
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    const anyConnected = Object.values(r.players).some((p) => p.connected);
    if (!anyConnected) {
      const idleSince = r.emptySince || r.lastActivity || 0;
      if (now - idleSince > ROOM_IDLE_MS) { clearRoomTimer(r); delete rooms[code]; removed++; }
    }
  }
  if (removed) console.log(`Автоочистка: удалено пустых комнат — ${removed}`);
}, CLEANUP_INTERVAL_MS);

function touch(room) { if (room) room.lastActivity = Date.now(); }

function publicPlayers(room) {
  return room.order.filter((id) => room.players[id]).map((id) => ({
    id, name: room.players[id].name, connected: room.players[id].connected,
    isHost: id === room.hostId, isBot: !!room.players[id].isBot,
    spectator: !!room.players[id].spectator, score: room.scores?.[id] || 0,
  }));
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("roomUpdate", {
    code: room.code, hostId: room.hostId, players: publicPlayers(room), state: room.state,
  });
}

function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function clearRoomTimer(room) {
  if (room.timerInterval) { clearTimeout(room.timerInterval); room.timerInterval = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

// ===== Статистика лидеров (за сессию комнаты) =====
function ensureStat(room, id) {
  if (!room.stats) room.stats = {};
  if (!room.stats[id]) room.stats[id] = { games: 0, spyCount: 0, wins: 0 };
  return room.stats[id];
}

function startGame(room, opts) {
  const durationMinutes = Math.min(15, Math.max(1, parseInt(opts.duration, 10) || 8));
  room.turnSeconds = Math.min(120, Math.max(10, parseInt(opts.turnSeconds, 10) || DEFAULT_TURN_SECONDS));
  room.setId = LOCATION_SETS[opts.setId] ? opts.setId : (room.setId || "classic");
  room.specialRolesEnabled = !!opts.specialRoles;

  // Активные участники (не зрители)
  const playerIds = room.order.filter((id) => room.players[id] && room.players[id].connected && !room.players[id].spectator);
  const spectatorIds = room.order.filter((id) => room.players[id] && room.players[id].connected && room.players[id].spectator);
  if (playerIds.length < 3) { io.to(room.hostId).emit("errorMsg", "Нужно минимум 3 игрока (не считая зрителей)."); return; }

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

  // Аналитика
  analytics.totalGames++;
  analytics.popularLocations[location.name] = (analytics.popularLocations[location.name] || 0) + 1;

  const spyId = playerIds[Math.floor(Math.random() * playerIds.length)];
  const shuffledRoles = shuffle(location.roles);
  const speakingOrder = shuffle([...playerIds]);
  const allLocNames = LOCATIONS.map((l) => l.name);

  // ===== Спец-роли (Фаза 4) =====
  let detectiveId = null, spyPartnerId = null, detectiveDecoys = [];
  if (room.specialRolesEnabled && playerIds.length >= 5) {
    const nonSpy = playerIds.filter((id) => id !== spyId);
    detectiveId = nonSpy[Math.floor(Math.random() * nonSpy.length)];
    const partnerCandidates = nonSpy.filter((id) => id !== detectiveId);
    if (partnerCandidates.length) spyPartnerId = partnerCandidates[Math.floor(Math.random() * partnerCandidates.length)];
    // Детектив видит локацию среди нескольких ложных
    const decoys = shuffle(allLocNames.filter((n) => n !== location.name)).slice(0, ROLES_CFG.detective.decoys || 2);
    detectiveDecoys = shuffle([location.name, ...decoys]);
  }

  room.state = "playing";
  room.round = {
    locationName: location.name, setId: room.setId, spyId, detectiveId, spyPartnerId,
    startedAt: Date.now(), durationMs: durationMinutes * 60 * 1000,
    phase: "speaking1", roundNum: 1,
    speakingOrder, speakerIndex: 0, turnEndsAt: 0,
    roleByPlayer: {}, // для экрана итогов
  };
  room.chatMessages = [];
  room.vote = null;
  room.audioMessages = [];

  const playersInfo = publicPlayers(room);
  const locationHint = location.hint || "Внимательно слушайте других и задавайте хитрые вопросы.";
  const suggestedTopic = SPY_TOPICS[Math.floor(Math.random() * SPY_TOPICS.length)];

  let roleIndex = 0;
  playerIds.forEach((id) => {
    const base = { locations: allLocNames, players: playersInfo, durationMs: room.round.durationMs, turnSeconds: room.turnSeconds, speakingOrder, spectator: false };
    if (id === spyId) {
      room.round.roleByPlayer[id] = { kind: "spy", label: "Шпион" };
      io.to(id).emit("roleAssigned", { ...base, isSpy: true, location: null, role: "Шпион", locationHint, suggestedTopic, special: null });
    } else if (id === detectiveId) {
      const role = shuffledRoles[roleIndex % shuffledRoles.length]; roleIndex++;
      room.round.roleByPlayer[id] = { kind: "detective", label: `Детектив / ${role}` };
      io.to(id).emit("roleAssigned", { ...base, isSpy: false, location: location.name, role, special: { id: "detective", name: ROLES_CFG.detective.name.ru, description: ROLES_CFG.detective.description.ru, candidates: detectiveDecoys } });
    } else if (id === spyPartnerId) {
      const role = shuffledRoles[roleIndex % shuffledRoles.length]; roleIndex++;
      room.round.roleByPlayer[id] = { kind: "spyPartner", label: `Напарник шпиона / ${role}` };
      io.to(id).emit("roleAssigned", { ...base, isSpy: false, location: location.name, role, special: { id: "spyPartner", name: ROLES_CFG.spyPartner.name.ru, description: ROLES_CFG.spyPartner.description.ru, spyName: room.players[spyId]?.name } });
    } else {
      const role = shuffledRoles[roleIndex % shuffledRoles.length]; roleIndex++;
      room.round.roleByPlayer[id] = { kind: "citizen", label: role };
      io.to(id).emit("roleAssigned", { ...base, isSpy: false, location: location.name, role, special: null });
    }
    const st = ensureStat(room, id); st.games++; if (id === spyId) st.spyCount++;
  });

  // Зрители: полное раскрытие (Фаза 2 — режим зрителя)
  spectatorIds.forEach((id) => {
    io.to(id).emit("roleAssigned", {
      isSpy: false, spectator: true, location: location.name, role: "Зритель",
      locations: allLocNames, players: playersInfo, durationMs: room.round.durationMs,
      turnSeconds: room.turnSeconds, speakingOrder,
      reveal: { locationName: location.name, spyName: room.players[spyId]?.name, spyId },
    });
  });

  clearRoomTimer(room);
  touch(room);
  startTurn(room);
  broadcastRoom(room.code);
}

function isBot(room, id) { return room.players[id] && room.players[id].isBot; }

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
  const turnSeconds = room.turnSeconds || DEFAULT_TURN_SECONDS;
  const turnEndsAt = Date.now() + turnSeconds * 1000;
  room.round.turnEndsAt = turnEndsAt;

  io.to(room.code).emit("turnStarted", {
    speakerId, speakerName, speakerIndex, totalSpeakers: speakingOrder.length,
    roundNum: room.round.roundNum, turnEndsAt, turnSeconds,
  });

  // Бот сам "говорит" и завершает ход
  if (isBot(room, speakerId)) {
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      const phrase = BOT_PHRASES[Math.floor(Math.random() * BOT_PHRASES.length)];
      io.to(room.code).emit("chatMessage", { senderName: speakerName, senderId: speakerId, text: phrase, isBot: true });
      room.timerInterval = null;
      io.to(room.code).emit("turnEnded", { speakerId, speakerName });
      room.round.speakerIndex++;
      setTimeout(() => startTurn(room), 1200);
    }, 3000 + Math.random() * 2500);
    return;
  }

  room.timerInterval = setTimeout(() => {
    room.timerInterval = null;
    io.to(room.code).emit("turnEnded", { speakerId, speakerName });
    room.round.speakerIndex++;
    setTimeout(() => startTurn(room), 1500);
  }, turnSeconds * 1000);
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
  if (winner === "spy") {
    if (spy) room.scores[room.round.spyId] = (room.scores[room.round.spyId] || 0) + 2;
    if (room.round.spyPartnerId) room.scores[room.round.spyPartnerId] = (room.scores[room.round.spyPartnerId] || 0) + 1;
    ensureStat(room, room.round.spyId).wins++;
    if (room.round.spyPartnerId) ensureStat(room, room.round.spyPartnerId).wins++;
  } else if (winner === "citizens") {
    room.order.forEach((id) => {
      if (room.players[id]?.connected && !room.players[id].spectator && id !== room.round.spyId && id !== room.round.spyPartnerId) {
        room.scores[id] = (room.scores[id] || 0) + 1;
        ensureStat(room, id).wins++;
      }
    });
  }

  // Итоги раунда: кто кем был (Фаза 3)
  const reveal = room.order
    .filter((id) => room.players[id] && !room.players[id].spectator && room.round.roleByPlayer[id])
    .map((id) => ({ id, name: room.players[id].name, ...room.round.roleByPlayer[id] }));

  // Лидерборд (Фаза 3)
  const leaderboard = Object.entries(room.stats || {})
    .filter(([id]) => room.players[id])
    .map(([id, s]) => ({ id, name: room.players[id].name, ...s, score: room.scores[id] || 0 }))
    .sort((a, b) => b.score - a.score);

  io.to(room.code).emit("gameEnded", {
    reason: reason || "Игра окончена", locationName: room.round.locationName,
    spyName: spy ? spy.name : "(вышел)", spyId: room.round.spyId,
    spyPartnerName: room.round.spyPartnerId ? room.players[room.round.spyPartnerId]?.name : null,
    detectiveName: room.round.detectiveId ? room.players[room.round.detectiveId]?.name : null,
    winner: winner || "spy", scores: room.scores, reveal, leaderboard,
    lastVotes: room.round.lastVotes || null,
  });
  room.state = "lobby"; room.round = null; room.chatMessages = []; room.vote = null; room.audioMessages = [];
  touch(room);
  broadcastRoom(room.code);
}

function resolveVote(room) {
  const vote = room.vote;
  if (!vote || !room.round) return;
  const connectedPlayers = room.order.filter((id) => room.players[id]?.connected && !room.players[id].spectator);
  const totalVoters = connectedPlayers.filter((id) => id !== vote.targetId).length;
  const allYes = vote.yes.length >= totalVoters && vote.no.length === 0;
  // Сохраняем голоса для экрана итогов
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

// Боты голосуют случайно
function botsVote(room) {
  if (!room.vote) return;
  const bots = room.order.filter((id) => isBot(room, id) && room.players[id].connected && id !== room.vote.targetId);
  bots.forEach((bid, i) => {
    setTimeout(() => {
      if (!room.vote) return;
      if (room.vote.yes.includes(bid) || room.vote.no.includes(bid)) return;
      const v = Math.random() < 0.6 ? "yes" : "no";
      if (v === "yes") room.vote.yes.push(bid); else room.vote.no.push(bid);
      emitVoteUpdate(room);
      checkAllVoted(room);
    }, 800 + i * 600 + Math.random() * 800);
  });
}

function emitVoteUpdate(room) {
  if (!room.vote) return;
  io.to(room.code).emit("voteUpdate", {
    initiatorId: room.vote.initiatorId, initiatorName: room.players[room.vote.initiatorId]?.name,
    targetId: room.vote.targetId, targetName: room.players[room.vote.targetId]?.name,
    yesNames: room.vote.yes.map((id) => room.players[id]?.name), noNames: room.vote.no.map((id) => room.players[id]?.name),
    yes: room.vote.yes, no: room.vote.no,
  });
}

function checkAllVoted(room) {
  if (!room.vote) return;
  const connectedPlayers = room.order.filter((id) => room.players[id]?.connected && !room.players[id].spectator);
  const voted = new Set([...room.vote.yes, ...room.vote.no]);
  const allVoted = connectedPlayers.every((id) => id === room.vote.targetId || voted.has(id));
  if (allVoted) resolveVote(room);
}

// ===== Reconnect: перенос игрока со старого socket.id на новый =====
function rekeyPlayer(room, oldId, newId) {
  if (oldId === newId || !room.players[oldId]) return;
  room.players[newId] = room.players[oldId];
  room.players[newId].id = newId;
  delete room.players[oldId];
  room.order = room.order.map((id) => (id === oldId ? newId : id));
  if (room.hostId === oldId) room.hostId = newId;
  if (room.scores && room.scores[oldId] != null) { room.scores[newId] = room.scores[oldId]; delete room.scores[oldId]; }
  if (room.stats && room.stats[oldId]) { room.stats[newId] = room.stats[oldId]; delete room.stats[oldId]; }
  if (room.round) {
    const r = room.round;
    if (r.spyId === oldId) r.spyId = newId;
    if (r.detectiveId === oldId) r.detectiveId = newId;
    if (r.spyPartnerId === oldId) r.spyPartnerId = newId;
    if (Array.isArray(r.speakingOrder)) r.speakingOrder = r.speakingOrder.map((id) => (id === oldId ? newId : id));
    if (r.roleByPlayer && r.roleByPlayer[oldId]) { r.roleByPlayer[newId] = r.roleByPlayer[oldId]; delete r.roleByPlayer[oldId]; }
  }
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

  function trackSession(sessionId) {
    if (sessionId && !seenSessions.has(sessionId)) { seenSessions.add(sessionId); analytics.totalPlayers++; }
  }

  socket.on("createRoom", ({ name, sessionId, spectator } = {}, cb) => {
    if (rateLimited(socket.id, "create", 5, 60 * 1000)) { if (cb) cb({ ok: false, error: "Слишком часто. Подождите немного." }); return; }
    enforceRoomLimit();
    if (Object.keys(rooms).length >= MAX_ROOMS) { if (cb) cb({ ok: false, error: "Сервер занят, попробуйте позже." }); return; }
    trackSession(sessionId);
    const code = genRoomCode();
    rooms[code] = {
      code, hostId: socket.id, players: {}, order: [], state: "lobby", round: null, timerInterval: null,
      chatMessages: [], vote: null, scores: {}, stats: {}, audioMessages: [], locationBag: [], lastLocation: null,
      setId: "classic", turnSeconds: DEFAULT_TURN_SECONDS, specialRolesEnabled: false,
      lastActivity: Date.now(), emptySince: null, botCount: 0,
    };
    joinRoom(code, name, sessionId, spectator);
    if (cb) cb({ ok: true, code });
  });

  socket.on("joinRoom", ({ code, name, sessionId, spectator } = {}, cb) => {
    if (rateLimited(socket.id, "join", 10, 60 * 1000)) { if (cb) cb({ ok: false, error: "Слишком часто. Подождите немного." }); return; }
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) { if (cb) cb({ ok: false, error: "Комната не найдена." }); return; }
    trackSession(sessionId);
    // Если игра идёт — пробуем reconnect по sessionId, иначе только зрителем
    if (room.state === "playing") {
      const existingId = sessionId && Object.keys(room.players).find((id) => room.players[id].sessionId === sessionId);
      if (existingId) { doResume(room, existingId, name, sessionId); if (cb) cb({ ok: true, code, resumed: true }); return; }
      if (!spectator) { if (cb) cb({ ok: false, error: "Игра уже идёт. Можно зайти зрителем." }); return; }
    }
    joinRoom(code, name, sessionId, spectator);
    if (cb) cb({ ok: true, code });
  });

  // Явный resume (по перезагрузке страницы)
  socket.on("resume", ({ code, sessionId, name } = {}, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room || !sessionId) { if (cb) cb({ ok: false }); return; }
    const existingId = Object.keys(room.players).find((id) => room.players[id].sessionId === sessionId);
    if (!existingId) { if (cb) cb({ ok: false }); return; }
    doResume(room, existingId, name, sessionId);
    if (cb) cb({ ok: true, code, state: room.state });
  });

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
    // Если идёт игра — восстановим роль игроку
    if (room.state === "playing" && room.round) resendRole(room, socket.id);
  }

  function resendRole(room, id) {
    const r = room.round; if (!r) return;
    const LOCATIONS = getSet(r.setId).locations;
    const location = LOCATIONS.find((l) => l.name === r.locationName) || LOCATIONS[0];
    const allLocNames = LOCATIONS.map((l) => l.name);
    const base = { locations: allLocNames, players: publicPlayers(room), durationMs: r.durationMs, turnSeconds: room.turnSeconds, speakingOrder: r.speakingOrder, resumed: true };
    const role = r.roleByPlayer[id];
    if (room.players[id].spectator) {
      io.to(id).emit("roleAssigned", { ...base, isSpy: false, spectator: true, location: location.name, role: "Зритель", reveal: { locationName: location.name, spyName: room.players[r.spyId]?.name, spyId: r.spyId } });
    } else if (id === r.spyId) {
      io.to(id).emit("roleAssigned", { ...base, isSpy: true, location: null, role: "Шпион", locationHint: location.hint, special: null });
    } else if (role) {
      const roleName = role.label.split(" / ").pop();
      io.to(id).emit("roleAssigned", { ...base, isSpy: false, location: location.name, role: roleName, special: null });
    }
    // Текущий ход
    if (r.turnEndsAt > Date.now()) {
      const speakerId = r.speakingOrder[r.speakerIndex];
      io.to(id).emit("turnStarted", { speakerId, speakerName: room.players[speakerId]?.name || "???", speakerIndex: r.speakerIndex, totalSpeakers: r.speakingOrder.length, roundNum: r.roundNum, turnEndsAt: r.turnEndsAt, turnSeconds: room.turnSeconds });
    }
  }

  function joinRoom(code, name, sessionId, spectator) {
    const room = rooms[code]; if (!room) return;
    // Reconnect в лобби по sessionId
    if (sessionId) {
      const existingId = Object.keys(room.players).find((id) => room.players[id].sessionId === sessionId);
      if (existingId && existingId !== socket.id) { doResume(room, existingId, name, sessionId); return; }
    }
    currentRoom = code; socket.join(code);
    room.players[socket.id] = {
      id: socket.id, name: (name || "Игрок").slice(0, 20), connected: true,
      sessionId: sessionId || null, spectator: !!spectator, isBot: false,
    };
    if (!room.order.includes(socket.id)) room.order.push(socket.id);
    room.emptySince = null;
    touch(room);
    broadcastRoom(code);
  }

  socket.on("startGame", (opts = {}) => {
    const room = rooms[currentRoom]; if (!room || socket.id !== room.hostId) return;
    startGame(room, opts);
  });

  // ===== Боты (Быстрые победы / Фаза 5) =====
  socket.on("addBot", () => {
    const room = rooms[currentRoom]; if (!room || socket.id !== room.hostId || room.state !== "lobby") return;
    const botId = "bot_" + Math.random().toString(36).slice(2, 9);
    const used = new Set(Object.values(room.players).map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Бот-${(room.botCount = (room.botCount || 0) + 1)}`;
    room.players[botId] = { id: botId, name, connected: true, isBot: true, spectator: false, sessionId: null };
    room.order.push(botId);
    touch(room);
    broadcastRoom(currentRoom);
  });

  socket.on("removeBot", ({ botId } = {}) => {
    const room = rooms[currentRoom]; if (!room || socket.id !== room.hostId || room.state !== "lobby") return;
    if (room.players[botId] && room.players[botId].isBot) { delete room.players[botId]; room.order = room.order.filter((id) => id !== botId); broadcastRoom(currentRoom); }
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

  // ===== ЧАТ (Фаза 3) =====
  socket.on("chatMessage", ({ text } = {}) => {
    const room = rooms[currentRoom]; if (!room || !room.players[socket.id]) return;
    if (rateLimited(socket.id, "chat", 10, 10 * 1000)) return;
    const clean = (text || "").toString().trim().slice(0, 200);
    if (!clean) return;
    const msg = { senderId: socket.id, senderName: room.players[socket.id].name, text: clean, ts: Date.now() };
    if (!room.chatMessages) room.chatMessages = [];
    room.chatMessages.push(msg);
    if (room.chatMessages.length > 100) room.chatMessages.shift();
    touch(room);
    io.to(currentRoom).emit("chatMessage", msg);
  });

  // ===== Голосовые сообщения (Фаза 3) =====
  socket.on("audioMessage", ({ data } = {}) => {
    const room = rooms[currentRoom]; if (!room || !room.players[socket.id]) return;
    if (rateLimited(socket.id, "audio", 5, 20 * 1000)) return;
    if (typeof data !== "string" || data.length > 7e6) return; // ~5MB base64
    touch(room);
    io.to(currentRoom).emit("audioMessage", { senderId: socket.id, senderName: room.players[socket.id].name, data, ts: Date.now() });
  });

  // ===== ГОЛОСОВАНИЕ =====
  socket.on("initiateVote", ({ targetId } = {}) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== "playing") return;
    if (room.players[socket.id]?.spectator) return;
    if (targetId === socket.id || !room.players[targetId]?.connected) return;
    room.vote = { initiatorId: socket.id, targetId, yes: [], no: [] };
    io.to(currentRoom).emit("voteStarted", { initiatorId: socket.id, initiatorName: room.players[socket.id].name, targetId, targetName: room.players[targetId].name, yes: [], no: [] });
    botsVote(room);
  });

  socket.on("cancelVote", () => {
    const room = rooms[currentRoom];
    if (!room || !room.vote) return;
    if (room.vote.initiatorId !== socket.id) return;
    const byName = room.players[socket.id]?.name || "Игрок";
    room.vote = null;
    io.to(currentRoom).emit("voteCancelled", { byId: socket.id, byName });
  });

  socket.on("castVote", ({ vote: v } = {}) => {
    const room = rooms[currentRoom]; if (!room || !room.vote) return;
    if (room.players[socket.id]?.spectator) return;
    if (room.vote.yes.includes(socket.id) || room.vote.no.includes(socket.id)) return;
    if (socket.id === room.vote.targetId) return;
    if (v === "yes") room.vote.yes.push(socket.id); else room.vote.no.push(socket.id);
    emitVoteUpdate(room);
    checkAllVoted(room);
  });

  // ===== ШПИОН УГАДЫВАЕТ =====
  socket.on("spyGuess", ({ locationName } = {}) => {
    const room = rooms[currentRoom]; if (!room || room.state !== "playing" || !room.round) return;
    if (socket.id !== room.round.spyId) return;
    const spyName = room.players[socket.id]?.name || "Шпион";
    if (locationName === room.round.locationName) endGame(room, `${spyName} угадал: ${locationName}!`, "spy");
    else endGame(room, `${spyName} ошибся! (Выбрал: "${locationName}"). Локация: ${room.round.locationName}.`, "citizens");
  });

  // ===== СМЕНА НИКНЕЙМА В ЛОББИ =====
  socket.on("changeName", ({ name } = {}, cb) => {
    const room = rooms[currentRoom];
    if (rateLimited(socket.id, "rename", 5, 30 * 1000)) { if (cb) cb({ ok: false, error: "Слишком часто." }); return; }
    if (!room || !room.players[socket.id]) { if (cb) cb({ ok: false, error: "Вы не в комнате." }); return; }
    if (room.state !== "lobby") { if (cb) cb({ ok: false, error: "Сменить ник можно только в лобби." }); return; }
    const clean = (name || "").trim().slice(0, 20);
    if (!clean) { if (cb) cb({ ok: false, error: "Введите непустое имя." }); return; }
    room.players[socket.id].name = clean;
    broadcastRoom(currentRoom);
    if (cb) cb({ ok: true, name: clean });
  });

  // ===== КИК ИГРОКОВ (Ведущий) =====
  socket.on("kickPlayer", ({ playerId } = {}) => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostId) return;
    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) { targetSocket.emit("kicked"); targetSocket.leave(currentRoom); }
    delete room.players[playerId];
    room.order = room.order.filter((id) => id !== playerId);
    if (room.round && room.round.speakingOrder) room.round.speakingOrder = room.round.speakingOrder.filter((id) => id !== playerId);
    broadcastRoom(currentRoom);
  });

  socket.on("disconnect", () => {
    socketLimits.delete(socket.id);
    const room = rooms[currentRoom]; if (!room) return;
    if (room.players[socket.id]) room.players[socket.id].connected = false;
    if (socket.id === room.hostId) {
      const nextHost = room.order.find((id) => room.players[id] && room.players[id].connected && !room.players[id].isBot && id !== socket.id);
      if (nextHost) room.hostId = nextHost;
    }
    const anyConnected = room.order.some((id) => room.players[id] && room.players[id].connected && !room.players[id].isBot);
    if (!anyConnected) {
      // Не удаляем сразу — даём шанс на reconnect; автоочистка уберёт позже
      clearRoomTimer(room);
      room.emptySince = Date.now();
      return;
    }
    touch(room);
    broadcastRoom(currentRoom);
  });
});

server.listen(PORT, () => console.log(`Шпион сервер запущен на порту ${PORT}`));

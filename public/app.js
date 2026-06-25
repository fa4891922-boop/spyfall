/* Шпион — клиент 3.0. Без ролей/чата/ботов/голосовых. Reconnect, таймер, голосование, угадывание. */

// ===== Система логирования (клиент) =====
const LOG = {
  _ts() { return new Date().toISOString(); },
  info(tag, msg, data) {
    if (data !== undefined) {
      console.log(`[${this._ts()}] [${tag}] ${msg}`, JSON.stringify(data).slice(0, 500));
    } else {
      console.log(`[${this._ts()}] [${tag}] ${msg}`);
    }
  },
  error(tag, msg, err) {
    if (err !== undefined) {
      console.error(`[${this._ts()}] [${tag}] ${msg}`, err);
    } else {
      console.error(`[${this._ts()}] [${tag}] ${msg}`);
    }
  },
  warn(tag, msg, data) {
    if (data !== undefined) {
      console.warn(`[${this._ts()}] [${tag}] ${msg}`, data);
    } else {
      console.warn(`[${this._ts()}] [${tag}] ${msg}`);
    }
  },
  assert(val, tag, msg) {
    if (val === undefined || val === null) {
      console.error(`[${this._ts()}] [${tag}] ASSERT FAIL: ${msg} is ${val}`);
      return false;
    }
    return true;
  },
};
LOG.info("INIT", "Клиент загружен", { sessionId: localStorage.getItem("spy_session")?.slice(0, 8) + "…", savedName: localStorage.getItem("spy_name"), savedRoom: localStorage.getItem("spy_room") });

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5000,
  timeout: 12000,
});
const $ = (id) => document.getElementById(id);
const screens = {
  home: $("screen-home"), lobby: $("screen-lobby"),
  game: $("screen-game"), result: $("screen-result"),
};

// ===== Сессия (для reconnect) =====
let sessionId = localStorage.getItem("spy_session");
if (!sessionId) { sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("spy_session", sessionId); }
let savedName = localStorage.getItem("spy_name") || "";

// ===== Состояние =====
let state = {
  code: null, hostId: null, myId: null, isHost: false,
  isSpy: false, locations: [], crossed: new Set(),
  endsAt: 0, durationMs: 0, timerRAF: null, roundNum: 0,
  isConnected: socket.connected,
};
let resumeInFlight = false;
let lastResumeAttemptAt = 0;
const NETWORK_ACTION_IDS = [
  "btn-create", "btn-join", "select-set", "btn-start", "btn-end-round",
  "btn-vote-yes", "btn-vote-no", "btn-next-round", "btn-confirm-yes",
];

function bindSocketEvent(event, handler) {
  socket.off(event);
  socket.on(event, handler);
}

function bindManagerEvent(event, handler) {
  socket.io.off(event);
  socket.io.on(event, handler);
}

function socketStatusEl() {
  let el = $("socket-status");
  if (!el) {
    el = document.createElement("div");
    el.id = "socket-status";
    el.className = "socket-status";
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function syncNetworkControls() {
  NETWORK_ACTION_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (id === "btn-confirm-yes") {
      el.disabled = !state.isConnected || $("confirm-overlay")?.hidden || !_confirmCb;
      return;
    }
    el.disabled = !state.isConnected;
  });
}

function setNetworkState(connected, message = "") {
  state.isConnected = connected;
  document.body.classList.toggle("socket-offline", !connected);
  const status = socketStatusEl();
  status.hidden = connected;
  status.textContent = message || "Связь с сервером потеряна. Восстанавливаем подключение…";
  syncNetworkControls();
}

function emitAction(event, payload, ack) {
  if (!state.isConnected) {
    LOG.warn("SOCKET", `Действие ${event} заблокировано: нет соединения`);
    toast("Связь восстанавливается. Попробуйте через пару секунд.");
    return false;
  }
  socket.emit(event, payload, ack);
  return true;
}

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ===== Модальное подтверждение (вместо confirm) =====
let _confirmCb = null;
function showConfirm(text, title, onYes) {
  // Поддержка старой сигнатуры showConfirm(text, onYes) — без title
  if (typeof title === "function") { onYes = title; title = "Подтверждение"; }
  if (!title) title = "Подтверждение";

  LOG.info("CONFIRM", "Открытие модального окна", { title, text: text?.slice(0, 80) });

  if (!LOG.assert(text, "CONFIRM", "confirm text")) {
    LOG.error("CONFIRM", "showConfirm вызван с пустым текстом — показываю резервный заголовок");
    text = "Вы уверены?";
  }

  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("btn-confirm-yes").disabled = !text || !onYes || !state.isConnected;
  $("confirm-overlay").hidden = false;
  _confirmCb = onYes;
}
$("btn-confirm-yes").addEventListener("click", () => {
  if ($("confirm-overlay").hidden || $("btn-confirm-yes").disabled) return;
  LOG.info("CONFIRM", "Пользователь нажал Подтвердить");
  $("confirm-overlay").hidden = true;
  if (_confirmCb) {
    const cb = _confirmCb;
    _confirmCb = null;
    cb();
  }
});
$("btn-confirm-no").addEventListener("click", () => {
  if ($("confirm-overlay").hidden) return;
  LOG.info("CONFIRM", "Пользователь нажал Отмена");
  $("confirm-overlay").hidden = true;
  _confirmCb = null;
});

// ===== Главный экран =====
$("input-name").value = savedName;
$("input-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });

function getName() {
  const n = $("input-name").value.trim().slice(0, 20) || "Игрок";
  localStorage.setItem("spy_name", n); savedName = n;
  return n;
}

$("btn-create").addEventListener("click", () => {
  const name = getName();
  LOG.info("ROOM", "Запрос создания комнаты", { name, sessionId: sessionId.slice(0, 8) + "…" });
  emitAction("createRoom", { name, sessionId }, (res) => {
    LOG.info("ROOM", "Ответ на createRoom", { ok: res?.ok, error: res?.error, code: res?.code });
    if (!res || !res.ok) { $("home-error").textContent = res?.error || "Не удалось создать комнату."; return; }
    enterRoom(res.code);
  });
});

$("btn-join").addEventListener("click", () => doJoin());
$("input-code").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
function doJoin() {
  const code = $("input-code").value.trim().toUpperCase();
  if (code.length < 4) { $("home-error").textContent = "Введите код из 4 символов."; return; }
  const name = getName();
  LOG.info("ROOM", "Запрос входа в комнату", { code, name, sessionId: sessionId.slice(0, 8) + "…" });
  emitAction("joinRoom", { code, name, sessionId }, (res) => {
    LOG.info("ROOM", "Ответ на joinRoom", { ok: res?.ok, error: res?.error, code: res?.code, resumed: res?.resumed });
    if (!res || !res.ok) { $("home-error").textContent = res?.error || "Не удалось войти."; return; }
    enterRoom(res.code);
  });
}

function enterRoom(code) {
  state.code = code;
  $("home-error").textContent = "";
  localStorage.setItem("spy_room", code);
  $("lobby-code").textContent = code;
  show("lobby");
}

// ===== Лобби =====
$("btn-copy").addEventListener("click", () => {
  navigator.clipboard?.writeText(state.code).then(() => toast("Код скопирован: " + state.code)).catch(() => toast(state.code));
});
$("input-duration").addEventListener("input", (e) => { $("dur-label").textContent = e.target.value; });
$("select-set").addEventListener("change", (e) => { emitAction("setLocationSet", { setId: e.target.value }); });

$("btn-start").addEventListener("click", () => {
  emitAction("startGame", {
    duration: parseInt($("input-duration").value, 10),
    setId: $("select-set").value,
  });
});

$("btn-leave-lobby").addEventListener("click", leaveRoom);
$("btn-back-lobby").addEventListener("click", () => show("lobby"));
function leaveRoom() {
  if (state.isConnected) emitAction("leaveRoom");
  else LOG.warn("SOCKET", "Выход из комнаты выполнен локально: нет соединения");
  localStorage.removeItem("spy_room");
  state.code = null;
  show("home");
}

// Загрузка наборов локаций
fetch("/api/locations").then((r) => r.json()).then((data) => {
  const sel = $("select-set");
  sel.innerHTML = "";
  (data.sets || []).forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.title?.ru || s.id} (${s.count})`;
    sel.appendChild(opt);
  });
}).catch(() => {});

// ===== Рендер игроков в лобби =====
function renderLobbyPlayers(players) {
  $("lobby-count").textContent = players.length;
  const ul = $("lobby-players"); ul.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("offline");
    li.innerHTML = `
      <span class="pl-name">${esc(p.name)}</span>
      ${p.isHost ? '<span class="pl-tag host">Хост</span>' : ""}
      <span class="pl-score">${p.score || 0}</span>`;
    ul.appendChild(li);
  });
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ===== roomUpdate =====
bindSocketEvent("roomUpdate", (data) => {
  LOG.info("SOCKET", "roomUpdate получен", { state: data.state, players: data.players?.length, roundNum: data.roundNum });
  state.code = data.code;
  state.hostId = data.hostId;
  state.myId = socket.id;
  state.isHost = data.hostId === socket.id;
  state.roundNum = data.roundNum || 0;

  if (data.setId) $("select-set").value = data.setId;

  $("host-panel").hidden = !state.isHost;
  $("guest-panel").hidden = state.isHost;

  if (screens.lobby.classList.contains("active") || (!screens.game.classList.contains("active") && !screens.result.classList.contains("active"))) {
    renderLobbyPlayers(data.players);
  }
  // Игроки для голосования на игровом экране
  if (screens.game.classList.contains("active")) renderVotePlayers(data.players);
});

// ===== Начало раунда =====
bindSocketEvent("roleAssigned", (data) => {
  LOG.info("SOCKET", "roleAssigned получен", { isSpy: data.isSpy, location: data.isSpy ? "(скрыто)" : data.location, roundNum: data.roundNum, players: data.players?.length });
  state.isSpy = data.isSpy;
  state.locations = data.locations || [];
  state.crossed = new Set();
  state.endsAt = data.endsAt;
  state.durationMs = data.durationMs;
  state.roundNum = data.roundNum;

  $("game-round").textContent = data.roundNum;
  $("btn-end-round").hidden = !state.isHost;

  const card = $("role-location");
  if (data.isSpy) {
    card.classList.add("is-spy");
    $("location-name").textContent = "ТЫ ШПИОН";
    $("location-hint").textContent = "Угадай локацию по вопросам — или не дай себя вычислить.";
    $("spy-guess").hidden = false;
    $("guess-search").value = "";
    renderGuessGrid();
  } else {
    card.classList.remove("is-spy");
    $("location-name").textContent = data.location;
    $("location-hint").textContent = data.locationHint || "";
    $("spy-guess").hidden = true;
  }

  renderLocList();
  renderVotePlayers(data.players);
  startTimer();
  show("game");
});

// Список локаций (для всех — можно вычёркивать)
function renderLocList() {
  const grid = $("loc-grid"); grid.innerHTML = "";
  state.locations.forEach((name) => {
    const div = document.createElement("div");
    div.className = "loc-item" + (state.crossed.has(name) ? " crossed" : "");
    div.textContent = name;
    div.addEventListener("click", () => {
      if (state.crossed.has(name)) state.crossed.delete(name); else state.crossed.add(name);
      renderLocList();
    });
    grid.appendChild(div);
  });
}

// Сетка для угадывания шпионом
function renderGuessGrid(filter = "") {
  const grid = $("guess-grid"); grid.innerHTML = "";
  const q = filter.trim().toLowerCase();
  state.locations.filter((n) => !q || n.toLowerCase().includes(q)).forEach((name) => {
    const div = document.createElement("div");
    div.className = "loc-item";
    div.textContent = name;
    div.addEventListener("click", () => {
      showConfirm(`Угадать локацию: «${name}»? Если неверно — граждане победят.`, "Догадка шпиона", () => {
        emitAction("spyGuess", { locationName: name });
      });
    });
    grid.appendChild(div);
  });
}

$("guess-search").addEventListener("input", (e) => renderGuessGrid(e.target.value));

// Игроки для голосования
function renderVotePlayers(players) {
  const ul = $("game-players"); ul.innerHTML = "";
  (players || []).forEach((p) => {
    if (p.id === socket.id) return; // себя не обвиняем
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("offline");
    li.innerHTML = `<span class="pl-name">${esc(p.name)}</span><span class="pl-action">Обвинить →</span>`;
    li.addEventListener("click", () => {
      if (!p.connected) return;
      showConfirm(`Начать голосование против «${p.name}»?`, "Обвинение", () => emitAction("requestVote", { targetId: p.id }));
    });
    ul.appendChild(li);
  });
}

$("btn-end-round").addEventListener("click", () => {
  showConfirm("Завершить раунд без результата?", "Завершение раунда", () => emitAction("endRound"));
});

// ===== Таймер =====
function startTimer() {
  cancelAnimationFrame(state.timerRAF);
  const ring = $("timer-ring-fg");
  const CIRC = 339.292;
  const timerEl = $("timer");

  function tick() {
    const now = Date.now();
    const remaining = Math.max(0, state.endsAt - now);
    const total = state.durationMs || 1;
    const frac = remaining / total;

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    $("timer-text").textContent = `${mins}:${String(secs).padStart(2, "0")}`;
    ring.style.strokeDashoffset = String(CIRC * (1 - frac));

    timerEl.classList.toggle("warning", frac <= 0.3 && frac > 0.12);
    timerEl.classList.toggle("danger", frac <= 0.12);

    if (remaining > 0) state.timerRAF = requestAnimationFrame(tick);
  }
  tick();
}

bindSocketEvent("timeUp", () => { toast("⏰ Время вышло! Пора голосовать."); });

// ===== Голосование =====
bindSocketEvent("voteUpdate", (v) => {
  $("vote-overlay").hidden = false;
  $("vote-initiator").textContent = v.initiatorName || "?";
  $("vote-target").textContent = v.targetName || "?";
  $("vote-yes").textContent = "За: " + (v.yesNames?.length || 0);
  $("vote-no").textContent = "Против: " + (v.noNames?.length || 0);

  const iAmTarget = v.targetId === socket.id;
  const iVoted = (v.yesIds || []).includes(socket.id) || (v.noIds || []).includes(socket.id);
  $("vote-actions").hidden = iAmTarget || iVoted;
  $("vote-waiting").hidden = !(iVoted && !iAmTarget) && !iAmTarget;
  if (iAmTarget) { $("vote-waiting").hidden = false; $("vote-waiting").textContent = "Вас обвиняют! Ждём решения остальных…"; }
  else if (iVoted) { $("vote-waiting").hidden = false; $("vote-waiting").textContent = "Голос учтён. Ждём остальных…"; }
});

$("btn-vote-yes").addEventListener("click", () => { emitAction("castVote", { vote: "yes" }); });
$("btn-vote-no").addEventListener("click", () => { emitAction("castVote", { vote: "no" }); });

bindSocketEvent("voteResult", (r) => {
  $("vote-overlay").hidden = true;
  if (r.passed) toast(r.isSpy ? `✅ ${r.targetName} — шпион!` : `❌ ${r.targetName} невиновен!`);
  else toast(`Голосование не прошло (${r.yesCount}/${r.yesCount + r.noCount}).`);
});

bindSocketEvent("spyGuessResult", (r) => {
  toast(r.correct ? `🕵️ ${r.spyName} угадал: ${r.actual}!` : `${r.spyName} не угадал. Это был не «${r.guess}».`);
});

// ===== Конец игры =====
bindSocketEvent("gameEnded", (data) => {
  LOG.info("SOCKET", "gameEnded получен", { winner: data.winner, location: data.locationName, spy: data.spyName, reason: data.reason });
  cancelAnimationFrame(state.timerRAF);
  $("vote-overlay").hidden = true;

  const citizensWin = data.winner === "citizens";
  $("result-emoji").textContent = data.winner === "spy" ? "🕵️" : citizensWin ? "🎉" : "🤝";
  $("result-title").textContent = data.winner === "spy" ? "Шпион победил" : citizensWin ? "Граждане победили" : "Ничья";
  $("result-reason").textContent = data.reason || "";
  $("reveal-location").textContent = data.locationName || "—";
  $("reveal-spy").textContent = data.spyName || "—";

  const lb = $("leaderboard"); lb.innerHTML = "";
  (data.leaderboard || []).forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${esc(p.name)}</span>
      <span class="lb-meta">шпион ${p.spyCount}× · побед ${p.wins}</span>
      <span class="lb-score">${p.score}</span>`;
    lb.appendChild(li);
  });

  $("btn-next-round").hidden = !state.isHost;
  show("result");
});

$("btn-next-round").addEventListener("click", () => {
  emitAction("startGame", {
    duration: parseInt($("input-duration").value, 10),
    setId: $("select-set").value,
  });
});

// ===== Ошибки =====
bindSocketEvent("errorMsg", (msg) => {
  LOG.warn("SOCKET", "errorMsg от сервера", msg);
  toast(msg);
});

function tryResumeSession(force = false) {
  const savedRoom = localStorage.getItem("spy_room");
  if (!savedRoom || resumeInFlight) return;

  const now = Date.now();
  if (!force && state.code === savedRoom && now - lastResumeAttemptAt < 2500) return;

  resumeInFlight = true;
  lastResumeAttemptAt = now;
  LOG.info("RECONNECT", "Попытка восстановления сессии", { room: savedRoom, sessionId: sessionId.slice(0, 8) + "…" });
  emitAction("resume", { code: savedRoom, sessionId, name: savedName || localStorage.getItem("spy_name") || "Игрок" }, (res) => {
    resumeInFlight = false;
    LOG.info("RECONNECT", "Ответ на resume", { ok: res?.ok, state: res?.state });
    if (res && res.ok) {
      state.code = res.code;
      $("lobby-code").textContent = res.code;
      if (res.state === "lobby") show("lobby");
      // если playing — сервер повторно пришлёт roleAssigned и переключит на game
    } else {
      LOG.warn("RECONNECT", "Не удалось восстановить сессию — сброс savedRoom");
      localStorage.removeItem("spy_room");
      state.code = null;
      show("home");
    }
  });
}

// ===== Reconnect при загрузке =====
bindSocketEvent("connect", () => {
  state.myId = socket.id;
  setNetworkState(true);
  LOG.info("SOCKET", "Socket подключён", { socketId: socket.id });
  tryResumeSession(true);
});

bindSocketEvent("disconnect", (reason) => {
  resumeInFlight = false;
  setNetworkState(false, `Связь с сервером потеряна (${reason}). Восстанавливаем подключение…`);
  LOG.warn("SOCKET", "Socket отключён", { reason });
});

bindSocketEvent("connect_error", (err) => {
  resumeInFlight = false;
  setNetworkState(false, "Не удаётся подключиться к серверу. Повторяем попытку…");
  LOG.error("SOCKET", "Ошибка подключения", err.message);
});

bindManagerEvent("reconnect_attempt", (attempt) => {
  setNetworkState(false, `Переподключение к серверу… попытка ${attempt}`);
  LOG.info("RECONNECT", "Попытка переподключения", { attempt });
});

bindManagerEvent("reconnect", (attempt) => {
  setNetworkState(true);
  LOG.info("RECONNECT", "Переподключение выполнено", { attempt });
  tryResumeSession(true);
});

syncNetworkControls();

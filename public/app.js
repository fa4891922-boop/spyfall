/* Шпион — клиент: пошаговые раунды, голосовые сообщения, авто-голосование */
const socket = io();

const TURN_SECONDS = 30; // длительность хода одного игрока (синхронно с сервером)

const $ = (id) => document.getElementById(id);
const screens = {
  home: $("screen-home"), lobby: $("screen-lobby"), game: $("screen-game"), result: $("screen-result"),
};

let myId = null, isHost = false, isSpy = false, currentCode = null;
let gamePlayers = [], currentVote = null, speakingOrder = [];
let allLocations = [];
let currentSpeakerId = null, turnEndTimestamp = 0, turnInterval = null;
let mediaRecorder = null, audioChunks = [];

socket.on("connect", () => { myId = socket.id; });

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function getName() { return ($("nameInput").value.trim() || "Игрок"); }

// ===== Главная =====
$("btnCreate").addEventListener("click", () => {
  $("homeError").textContent = "";
  socket.emit("createRoom", { name: getName() }, (res) => {
    if (res?.ok) { currentCode = res.code; show("lobby"); }
    else $("homeError").textContent = res?.error || "Ошибка.";
  });
});

$("btnJoin").addEventListener("click", () => {
  $("homeError").textContent = "";
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length < 4) { $("homeError").textContent = "Введите код из 4 символов."; return; }
  socket.emit("joinRoom", { code, name: getName() }, (res) => {
    if (res?.ok) { currentCode = res.code; show("lobby"); }
    else $("homeError").textContent = res?.error || "Не удалось войти.";
  });
});
$("codeInput").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });

// ===== Лобби =====
$("btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentCode); $("btnCopy").textContent = "Скопировано!"; setTimeout(() => $("btnCopy").textContent = "Копировать", 1500); }
  catch (e) { prompt("Код:", currentCode); }
});
// Смена никнейма прямо в лобби
function submitChangeName() {
  const newName = $("newNameInput").value.trim();
  $("nameChangeMsg").textContent = "";
  if (!newName) { $("nameChangeMsg").textContent = "Введите новый ник."; return; }
  socket.emit("changeName", { name: newName }, (res) => {
    if (res?.ok) {
      $("nameInput").value = res.name;
      $("newNameInput").value = "";
      $("nameChangeMsg").textContent = "Ник изменён ✅";
      setTimeout(() => { $("nameChangeMsg").textContent = ""; }, 1500);
    } else {
      $("nameChangeMsg").textContent = res?.error || "Не удалось сменить ник.";
    }
  });
}
$("btnChangeName").addEventListener("click", submitChangeName);
$("newNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitChangeName(); });

$("durationInput").addEventListener("input", (e) => { $("durationLabel").textContent = e.target.value; });
$("btnStart").addEventListener("click", () => socket.emit("startGame", { duration: parseInt($("durationInput").value, 10) }));
$("btnStop").addEventListener("click", () => socket.emit("stopGame"));
$("btnBackToLobby").addEventListener("click", () => show("lobby"));

$("btnEndTurn").addEventListener("click", () => socket.emit("endMyTurn"));

// ===== Чат и голосовые сообщения отключены (общение в Discord) =====

// ===== Комната =====
socket.on("roomUpdate", (room) => {
  currentCode = room.code; isHost = room.hostId === myId;
  $("roomCode").textContent = room.code; $("playerCount").textContent = room.players.length;
  const list = $("playerList"); list.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    const dot = document.createElement("span"); dot.className = "dot" + (p.connected ? "" : " off");
    const name = document.createElement("span"); name.textContent = p.name + (p.id === myId ? " (вы)" : "");
    li.appendChild(dot); li.appendChild(name);
    if (p.isHost) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "ВЕДУЩИЙ"; li.appendChild(tag); }
    if (p.score) { const sc = document.createElement("span"); sc.className = "score"; sc.textContent = p.score + " очк."; li.appendChild(sc); }

    // Система кика игроков для Ведущего
    if (isHost && p.id !== myId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn-kick";
      kickBtn.innerHTML = "❌";
      kickBtn.title = "Кикнуть игрока";
      kickBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Вы уверены, что хотите кикнуть игрока ${p.name}?`)) {
          socket.emit("kickPlayer", { playerId: p.id });
        }
      };
      li.appendChild(kickBtn);
    }

    list.appendChild(li);
  });
  $("hostControls").classList.toggle("hidden", !isHost);
  $("waitMsg").classList.toggle("hidden", isHost);
  $("gameHostControls").classList.toggle("hidden", !isHost);
});

// ===== Роль =====
socket.on("roleAssigned", (data) => {
  show("game");
  isSpy = data.isSpy; gamePlayers = data.players || []; speakingOrder = data.speakingOrder || [];
  $("roleSpy").classList.toggle("hidden", !data.isSpy);
  $("roleNormal").classList.toggle("hidden", data.isSpy);

  // Отображение подсказки для шпиона
  if (data.isSpy) {
    // ОДНА тонкая подсказка о характере места (не раскрывает локацию)
    if (data.locationHint) {
      $("spyLocationHint").innerHTML = `<strong style="color: #fca5a5;">${data.locationHint}</strong>`;
    } else {
      $("spyLocationHint").textContent = "Внимательно слушайте других и задавайте хитрые вопросы.";
    }
    if (data.suggestedTopic) {
      $("spyTopicHint").textContent = `💡 Идея для вопроса: "${data.suggestedTopic}"`;
    } else {
      $("spyTopicHint").textContent = "";
    }
    $("spyHintBox").style.display = "block";
  } else {
    $("spyHintBox").style.display = "none";
  }
  $("btnSpyGuess").classList.toggle("hidden", !data.isSpy);
  if (!data.isSpy) { $("locationName").textContent = data.location; $("roleName").textContent = data.role; }
  allLocations = data.locations || [];
  $("locSearch").value = "";
  renderLocationsList("");
  
  
  
  hideVotePanel(); hideSpyGuessPanel();
  $("gameHostControls").classList.toggle("hidden", !isHost);
  renderOrderList();
  $("phaseLabel").textContent = "Раунд 1";
  clearTurnTimer();
  $("turnBanner").classList.add("hidden");
  $("btnEndTurn").classList.add("hidden");
  $("timer").textContent = "--:--";
});

function renderOrderList() {
  const div = $("orderList"); div.innerHTML = "";
  speakingOrder.forEach((id, i) => {
    const name = gamePlayers.find((p) => p.id === id)?.name || "???";
    const span = document.createElement("span");
    span.className = "order-chip";
    span.textContent = `${i + 1}. ${name}`;
    span.dataset.pid = id;
    div.appendChild(span);
  });
}

// ===== Смена фазы =====
socket.on("phaseChange", (data) => {
  $("phaseLabel").textContent = data.phase === "speaking1" ? "Раунд 1" : data.phase === "speaking2" ? "Раунд 2" : "ГОЛОСОВАНИЕ";
  if (data.phase === "voting") {
    clearTurnTimer();
    $("turnBanner").classList.add("hidden");
    $("btnEndTurn").classList.add("hidden");
    $("turnSpeaker").textContent = "";
    openVotePanel();
  }
});

// ===== Ход игрока =====
socket.on("turnStarted", (data) => {
  currentSpeakerId = data.speakerId;
  turnEndTimestamp = data.turnEndsAt;
  $("turnBanner").classList.remove("hidden");
  $("turnSpeaker").textContent = `🎤 Говорит: ${data.speakerName} (${data.speakerIndex + 1}/${data.totalSpeakers})`;
  $("turnHint").textContent = data.speakerId === myId ? "Ваш ход! Опишите локацию." : "Слушайте внимательно.";
  $("btnEndTurn").classList.toggle("hidden", data.speakerId !== myId);
  document.querySelectorAll(".order-chip").forEach((el) => { el.classList.toggle("active", el.dataset.pid === data.speakerId); });
  startTurnTimer();
});

function startTurnTimer() {
  clearTurnTimer();
  turnInterval = setInterval(() => {
    if (!turnEndTimestamp) return;
    const remaining = Math.max(0, turnEndTimestamp - Date.now());
    const total = TURN_SECONDS * 1000;
    const pct = Math.min(100, total > 0 ? ((total - remaining) / total) * 100 : 100);
    $("turnProgress").style.width = `${pct}%`;
    if (remaining <= 0) clearTurnTimer();
  }, 200);
}

function clearTurnTimer() {
  if (turnInterval) { clearInterval(turnInterval); turnInterval = null; }
  $("turnProgress").style.width = "0%";
}

socket.on("turnEnded", (data) => {
  clearTurnTimer();
  currentSpeakerId = null;
  $("turnBanner").classList.add("hidden");
  $("btnEndTurn").classList.add("hidden");
  document.querySelectorAll(".order-chip").forEach((el) => el.classList.remove("active"));
});

// ===== Голосование =====
$("btnVotePanel").addEventListener("click", () => {
  $("votePanel").classList.contains("hidden") ? openVotePanel() : hideVotePanel();
});

function openVotePanel() {
  const targetsDiv = $("voteTargets"); targetsDiv.innerHTML = "";
  gamePlayers.forEach((p) => {
    if (p.id === myId) return;
    const btn = document.createElement("button");
    btn.className = "btn btn-small vote-target-btn"; btn.textContent = p.name;
    btn.addEventListener("click", () => socket.emit("initiateVote", { targetId: p.id }));
    targetsDiv.appendChild(btn);
  });
  $("voteStatus").classList.add("hidden");
  $("voteButtons").classList.add("hidden");
  $("btnVoteCancel").classList.add("hidden");
  $("votePrompt").textContent = "Выберите, кого обвинить:";
  $("votePanel").classList.remove("hidden");
}

function hideVotePanel() { $("votePanel").classList.add("hidden"); }

socket.on("voteStarted", (data) => {
  currentVote = data;
  $("voteTargets").innerHTML = "";
  $("voteStatus").classList.remove("hidden");
  $("voteStatus").textContent = `${data.initiatorName} обвиняет ${data.targetName}!`;
  $("votePrompt").textContent = data.targetId === myId ? "Вы под обвинением." : "Голосуйте:";
  $("voteButtons").classList.toggle("hidden", data.targetId === myId);
  $("btnVoteCancel").classList.remove("hidden"); // отменить можно в любой момент
  $("votePanel").classList.remove("hidden");
});
socket.on("voteUpdate", (data) => {
  currentVote = data;
  $("voteStatus").textContent = `За: ${data.yesNames?.length || 0}, Против: ${data.noNames?.length || 0}`;
  if (data.targetId === myId) $("voteButtons").classList.add("hidden");
});
socket.on("voteResult", (data) => {
  hideVotePanel();
  $("btnVoteCancel").classList.add("hidden");
  if (data.passed) {
    $("resultVoteDetail").classList.remove("hidden");
    $("resultVoteText").textContent = data.isSpy ? `Шпион найден: ${data.targetName}!` : `Невиновный: ${data.targetName}.`;
  }
  currentVote = null;
});
$("btnVoteYes").addEventListener("click", () => socket.emit("castVote", { vote: "yes" }));
$("btnVoteNo").addEventListener("click", () => socket.emit("castVote", { vote: "no" }));

// Отмена голосования — в любой момент
$("btnVoteCancel").addEventListener("click", () => socket.emit("cancelVote"));
socket.on("voteCancelled", (data) => {
  currentVote = null;
  $("btnVoteCancel").classList.add("hidden");
  $("voteButtons").classList.add("hidden");
  // Возвращаем панель к выбору цели, чтобы можно было сразу начать заново
  if (!$("votePanel").classList.contains("hidden")) {
    openVotePanel();
  }
  $("voteStatus").classList.remove("hidden");
  $("voteStatus").textContent = `Голосование отменено (${data?.byName || "игрок"}).`;
  setTimeout(() => { if ($("voteStatus")) $("voteStatus").classList.add("hidden"); }, 2500);
});

// ===== Шпион угадывает =====
$("btnSpyGuess").addEventListener("click", () => {
  $("spyGuessPanel").classList.contains("hidden") ? openSpyGuessPanel() : hideSpyGuessPanel();
});
function openSpyGuessPanel() {
  $("spyGuessSearch").value = "";
  renderSpyGuessOptions("");
  $("spyGuessPanel").classList.remove("hidden");
  setTimeout(() => $("spyGuessSearch").focus(), 50);
}
function renderSpyGuessOptions(filter) {
  const div = $("spyGuessOptions"); div.innerHTML = "";
  const q = (filter || "").trim().toLowerCase();
  const matches = allLocations.filter((loc) => loc.toLowerCase().includes(q));
  matches.forEach((loc) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-small guess-btn"; btn.textContent = loc;
    btn.addEventListener("click", () => socket.emit("spyGuess", { locationName: loc }));
    div.appendChild(btn);
  });
  $("spyGuessEmpty").classList.toggle("hidden", matches.length > 0);
}
$("spyGuessSearch").addEventListener("input", (e) => renderSpyGuessOptions(e.target.value));

// Поиск по общему списку локаций
function renderLocationsList(filter) {
  const ul = $("locationsList"); ul.innerHTML = "";
  const q = (filter || "").trim().toLowerCase();
  const matches = allLocations.filter((loc) => loc.toLowerCase().includes(q));
  matches.forEach((loc) => { const li = document.createElement("li"); li.textContent = loc; ul.appendChild(li); });
  $("locListEmpty").classList.toggle("hidden", matches.length > 0);
}
$("locSearch").addEventListener("input", (e) => renderLocationsList(e.target.value));
function hideSpyGuessPanel() { $("spyGuessPanel").classList.add("hidden"); }
$("btnSpyCancelGuess").addEventListener("click", hideSpyGuessPanel);

// ===== Конец игры =====
socket.on("gameEnded", (data) => {
  clearTurnTimer();
  $("resultReason").textContent = data.reason || "Игра окончена";
  $("resultLocation").textContent = data.locationName || "—";
  $("resultSpy").textContent = data.spyName || "—";
  const scores = data.scores || {};
  const scoresList = $("resultScores"); scoresList.innerHTML = "";
  if (Object.keys(scores).length > 0) {
    const entries = Object.entries(scores).map(([id, score]) => ({ id, name: gamePlayers.find((p) => p.id === id)?.name || "Игрок", score })).sort((a, b) => b.score - a.score);
    entries.forEach((e) => {
      const li = document.createElement("li");
      li.textContent = `${e.score === entries[0].score && e.score > 0 ? "🥇 " : ""}${e.name}: ${e.score} очк.`;
      scoresList.appendChild(li);
    });
  } else {
    const li = document.createElement("li"); li.textContent = "Очков пока нет"; scoresList.appendChild(li);
  }
  show("result"); hideVotePanel(); hideSpyGuessPanel();
});

// ===== Ошибки =====
socket.on("errorMsg", (msg) => { $("lobbyError").textContent = msg; setTimeout(() => $("lobbyError").textContent = "", 4000); });
socket.on("disconnect", () => { $("homeError").textContent = ""; });

socket.on("kicked", () => {
  currentCode = null;
  show("home");
  $("homeError").textContent = "Вы были кикнуты из комнаты.";
});

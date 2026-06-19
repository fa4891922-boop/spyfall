/* Игра «Шпион» — клиентская логика: чат, голосование, угадывание, очки */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = {
  home: $("screen-home"),
  lobby: $("screen-lobby"),
  game: $("screen-game"),
  result: $("screen-result"),
};

let myId = null;
let isHost = false;
let isSpy = false;
let currentCode = null;
let gamePlayers = [];
let currentVote = null;
let voteJustPassed = false;

socket.on("connect", () => { myId = socket.id; });

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function getName() {
  const n = $("nameInput").value.trim();
  return n || "Игрок";
}

// ===== Главный экран =====
$("btnCreate").addEventListener("click", () => {
  $("homeError").textContent = "";
  socket.emit("createRoom", { name: getName() }, (res) => {
    if (res && res.ok) {
      currentCode = res.code;
      show("lobby");
    } else {
      $("homeError").textContent = (res && res.error) || "Ошибка создания комнаты.";
    }
  });
});

$("btnJoin").addEventListener("click", () => {
  $("homeError").textContent = "";
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length < 4) {
    $("homeError").textContent = "Введите код из 4 символов.";
    return;
  }
  socket.emit("joinRoom", { code, name: getName() }, (res) => {
    if (res && res.ok) {
      currentCode = res.code;
      show("lobby");
    } else {
      $("homeError").textContent = (res && res.error) || "Не удалось войти.";
    }
  });
});

$("codeInput").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// ===== Лобби =====
$("btnCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentCode);
    $("btnCopy").textContent = "Скопировано!";
    setTimeout(() => ($("btnCopy").textContent = "Копировать"), 1500);
  } catch (e) {
    const url = window.location.origin + " — код: " + currentCode;
    prompt("Скопируйте код комнаты:", url);
  }
});

$("durationInput").addEventListener("input", (e) => {
  $("durationLabel").textContent = e.target.value;
});

$("btnStart").addEventListener("click", () => {
  socket.emit("startGame", { duration: parseInt($("durationInput").value, 10) });
});

$("btnStop").addEventListener("click", () => {
  socket.emit("stopGame");
});

$("btnBackToLobby").addEventListener("click", () => {
  show("lobby");
});

// ===== Чат =====
$("btnChatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chatMessage", { text });
  $("chatInput").value = "";
}

socket.on("newChatMessage", (msg) => {
  const div = document.getElementById("chatMessages");
  if (!div) return;
  const empty = div.querySelector(".chat-empty");
  if (empty) empty.remove();

  const p = document.createElement("div");
  p.className = "chat-msg" + (msg.senderId === myId ? " mine" : "");
  const nameSpan = document.createElement("span");
  nameSpan.className = "chat-author";
  nameSpan.textContent = msg.senderId === myId ? "Вы" : msg.senderName;
  const textSpan = document.createElement("span");
  textSpan.className = "chat-text";
  textSpan.textContent = msg.text;
  p.appendChild(nameSpan);
  p.appendChild(textSpan);
  div.appendChild(p);
  div.scrollTop = div.scrollHeight;
});

// ===== Обновление комнаты =====
socket.on("roomUpdate", (room) => {
  currentCode = room.code;
  isHost = room.hostId === myId;

  $("roomCode").textContent = room.code;
  $("playerCount").textContent = room.players.length;

  const list = $("playerList");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot" + (p.connected ? "" : " off");
    const name = document.createElement("span");
    name.textContent = p.name + (p.id === myId ? " (вы)" : "");
    li.appendChild(dot);
    li.appendChild(name);
    if (p.isHost) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "ВЕДУЩИЙ";
      li.appendChild(tag);
    }
    if (p.score) {
      const sc = document.createElement("span");
      sc.className = "score";
      sc.textContent = p.score + " очк.";
      li.appendChild(sc);
    }
    list.appendChild(li);
  });

  $("hostControls").classList.toggle("hidden", !isHost);
  $("waitMsg").classList.toggle("hidden", isHost);
  $("gameHostControls").classList.toggle("hidden", !isHost);
});

// ===== Назначение роли =====
socket.on("roleAssigned", (data) => {
  show("game");
  voteJustPassed = false;
  isSpy = data.isSpy;
  gamePlayers = data.players || [];

  $("roleSpy").classList.toggle("hidden", !data.isSpy);
  $("roleNormal").classList.toggle("hidden", data.isSpy);
  $("btnSpyGuess").classList.toggle("hidden", !data.isSpy);

  if (!data.isSpy) {
    $("locationName").textContent = data.location;
    $("roleName").textContent = data.role;
  }

  const ul = $("locationsList");
  ul.innerHTML = "";
  (data.locations || []).forEach((loc) => {
    const li = document.createElement("li");
    li.textContent = loc;
    ul.appendChild(li);
  });

  // Сброс чата
  $("chatMessages").innerHTML = '<p class="chat-empty">Сообщений пока нет...</p>';
  $("chatInput").value = "";

  // Сброс голосования
  hideVotePanel();
  hideSpyGuessPanel();

  $("gameHostControls").classList.toggle("hidden", !isHost);
  renderTimer(data.durationMs);
});

// ===== Таймер =====
function renderTimer(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  $("timer").textContent = `${m}:${s}`;
  $("timer").classList.toggle("low", total <= 30);
}

socket.on("timerTick", ({ remaining }) => {
  renderTimer(remaining);
});

// ===== Голосование =====
$("btnVotePanel").addEventListener("click", () => {
  const panel = $("votePanel");
  if (panel.classList.contains("hidden")) {
    openVotePanel();
  } else {
    hideVotePanel();
  }
});

function openVotePanel() {
  const panel = $("votePanel");
  const targetsDiv = $("voteTargets");
  const statusP = $("voteStatus");
  const buttonsDiv = $("voteButtons");
  const promptP = $("votePrompt");

  targetsDiv.innerHTML = "";
  gamePlayers.forEach((p) => {
    if (p.id === myId) return;
    const btn = document.createElement("button");
    btn.className = "btn btn-small vote-target-btn";
    btn.textContent = p.name;
    btn.addEventListener("click", () => {
      socket.emit("initiateVote", { targetId: p.id });
    });
    targetsDiv.appendChild(btn);
  });

  statusP.classList.add("hidden");
  buttonsDiv.classList.add("hidden");
  promptP.textContent = "Выберите, кого обвинить:";

  panel.classList.remove("hidden");
}

function hideVotePanel() {
  $("votePanel").classList.add("hidden");
}

socket.on("voteStarted", (data) => {
  currentVote = data;
  $("voteTargets").innerHTML = "";
  $("voteStatus").classList.remove("hidden");
  $("voteStatus").textContent = `${data.initiatorName} обвиняет ${data.targetName}! Голосуем.`;
  $("votePrompt").textContent = data.targetId === myId
    ? "Вы под обвинением — голосовать не можете."
    : "Голосуйте:";
  $("voteButtons").classList.toggle("hidden", data.targetId === myId);
  $("votePanel").classList.remove("hidden");
  voteJustPassed = false;
});

socket.on("voteUpdate", (data) => {
  currentVote = data;
  $("voteStatus").textContent = `За: ${data.yesNames?.length || 0}, Против: ${data.noNames?.length || 0}`;
  if (data.targetId === myId) {
    $("voteButtons").classList.add("hidden");
  }
});

socket.on("voteResult", (data) => {
  voteJustPassed = true;
  hideVotePanel();
  if (data.passed) {
    $("resultVoteDetail").classList.remove("hidden");
    $("resultVoteText").textContent = data.isSpy
      ? `Голосование: ${data.targetName} оказался шпионом!`
      : `Голосование: ${data.targetName} невиновен.`;
  } else {
    $("resultVoteText").textContent = "Голосование провалилось — игра продолжается.";
  }
  currentVote = null;
});

$("btnVoteYes").addEventListener("click", () => socket.emit("castVote", { vote: "yes" }));
$("btnVoteNo").addEventListener("click", () => socket.emit("castVote", { vote: "no" }));

// ===== Шпион угадывает локацию =====
$("btnSpyGuess").addEventListener("click", () => {
  const panel = $("spyGuessPanel");
  if (panel.classList.contains("hidden")) openSpyGuessPanel();
  else hideSpyGuessPanel();
});

function openSpyGuessPanel() {
  const div = $("spyGuessOptions");
  div.innerHTML = "";
  const allLocations = [];
  $("locationsList").querySelectorAll("li").forEach((li) => allLocations.push(li.textContent));

  allLocations.forEach((loc) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-small guess-btn";
    btn.textContent = loc;
    btn.addEventListener("click", () => {
      socket.emit("spyGuess", { locationName: loc });
    });
    div.appendChild(btn);
  });
  $("spyGuessPanel").classList.remove("hidden");
}

function hideSpyGuessPanel() {
  $("spyGuessPanel").classList.add("hidden");
}

$("btnSpyCancelGuess").addEventListener("click", () => {
  hideSpyGuessPanel();
});

// ===== Конец игры =====
socket.on("gameEnded", (data) => {
  $("resultReason").textContent = data.reason || "Игра окончена";
  $("resultLocation").textContent = data.locationName || "—";
  $("resultSpy").textContent = data.spyName || "—";

  // Показываем счёт
  const scores = data.scores || {};
  const scoresList = $("resultScores");
  scoresList.innerHTML = "";
  if (Object.keys(scores).length > 0) {
    const entries = Object.entries(scores)
      .map(([id, score]) => ({ id, name: gamePlayers.find((p) => p.id === id)?.name || "Игрок", score }))
      .sort((a, b) => b.score - a.score);
    entries.forEach((e) => {
      const li = document.createElement("li");
      const medal = e.score === entries[0].score && entries[0].score > 0 ? "🥇 " : "";
      li.textContent = `${medal}${e.name}: ${e.score} очк.`;
      scoresList.appendChild(li);
    });
  } else {
    const li = document.createElement("li");
    li.textContent = "Очков пока нет";
    scoresList.appendChild(li);
  }

  show("result");
  hideVotePanel();
  hideSpyGuessPanel();
});

// ===== Ошибки =====
socket.on("errorMsg", (msg) => {
  $("lobbyError").textContent = msg;
  setTimeout(() => ($("lobbyError").textContent = ""), 4000);
});

socket.on("disconnect", () => {
  $("homeError").textContent = "";
});

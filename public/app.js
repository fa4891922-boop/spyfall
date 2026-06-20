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

// Авто-подключение по ссылке (?room=XXXX)
(function () {
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl && roomFromUrl.length >= 4) {
    $("codeInput").value = roomFromUrl.toUpperCase();
    $("homeError").textContent = "";
    socket.emit("joinRoom", { code: roomFromUrl.toUpperCase(), name: getName() }, (res) => {
      if (res?.ok) { currentCode = res.code; show("lobby"); }
      else { $("homeError").textContent = "Комната не найдена. Создайте новую или проверьте ссылку."; }
    });
  }
})();

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

// Поделиться ссылкой
$("btnShare").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${currentCode}`;
  try {
    if (navigator.share) { await navigator.share({ title: "Шпион — присоединяйся!", text: `Код комнаты: ${currentCode}`, url: link }); }
    else { await navigator.clipboard.writeText(link); $("btnShare").textContent = "Ссылка скопирована!"; setTimeout(() => $("btnShare").textContent = "Поделиться", 1500); }
  } catch (e) { prompt("Ссылка:", link); }
});
// Смена никнейма прямо в лобби
function submitChangeName() {
  const newName = $("newNameInput").value.trim();
  $("nameChangeMsg").textContent = "";
  if (!newName) { $("nameChangeMsg").textContent = "Введите новый ник."; return; }
  socket.emit("changeName", { name: newName }, (res) => {
    if (res?.ok) {
      $("newNameInput").value = "";
      $("nameChangeMsg").textContent = "Ник обновлён!";
      setTimeout(() => $("nameChangeMsg").textContent = "", 2000);
    } else {
      $("nameChangeMsg").textContent = res?.error || "Ошибка смены имени.";
    }
  });
}
$("btnChangeName").addEventListener("click", submitChangeName);
$("newNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitChangeName(); });

$("btnStart").addEventListener("click", () => {
  const dur = parseInt($("durationSelect").value, 10) || 8;
  socket.emit("startGame", { duration: Math.min(15, Math.max(1, dur)) });
});

$("btnBackToLobby").addEventListener("click", () => show("lobby"));

// Аудио
$("btnRecord").addEventListener("pointerdown", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size > 5e6) { $("lobbyError").textContent = "Слишком большое аудио (макс. 5 MB)."; return; }
      const reader = new FileReader();
      reader.onload = () => socket.emit("audioMessage", { data: reader.result });
      reader.readAsDataURL(blob);
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();
  } catch (e) { $("lobbyError").textContent = "Нет доступа к микрофону."; }
});
$("btnRecord").addEventListener("pointerup", () => { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); });
$("btnRecord").addEventListener("pointerleave", () => { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); });

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
    // Кнопка кика
    if (isHost && p.id !== myId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn btn-small btn-danger";
      kickBtn.textContent = "Кик";
      kickBtn.onclick = () => socket.emit("kickPlayer", { playerId: p.id });
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  });
  $("btnStart").style.display = isHost ? "" : "none";
  $("btnStart").disabled = room.players.length < 3;
});

// ===== Игра =====
socket.on("roleAssigned", (data) => {
  isSpy = data.isSpy;
  gamePlayers = data.players || [];
  speakingOrder = data.speakingOrder || [];
  $("spyCard").classList.toggle("hidden", !isSpy);
  $("citizenCard").classList.toggle("hidden", isSpy);
  $("btnSpyGuess").classList.toggle("hidden", !isSpy);
  if (data.locationHint) {
    $("spyLocationHint").innerHTML = `<strong style="color: #fca5a5;">${data.locationHint}</strong>`;
  } else {
    $("spyLocationHint").textContent = "Внимательно слушайте других и задавайте хитрые вопросы.";
  }
  if (data.suggestedTopic) {
    $("spyTopic").textContent = data.suggestedTopic;
  }
  if (!data.isSpy) { $("locationName").textContent = data.location; $("roleName").textContent = data.role; }
  allLocations = data.locations || [];
  $("locSearch").value = "";
  renderLocationsList("");
  show("game");
});

// Таймер хода
function updateTimer() {
  if (!turnEndTimestamp) return;
  const left = Math.max(0, Math.ceil((turnEndTimestamp - Date.now()) / 1000));
  $("timerDisplay").textContent = String(left);
  $("timerDisplay").style.color = left <= 5 ? "var(--danger)" : left <= 10 ? "var(--warn)" : "";
  if (left <= 0) { clearInterval(turnInterval); turnInterval = null; }
}

socket.on("turnStarted", (data) => {
  currentSpeakerId = data.speakerId;
  turnEndTimestamp = data.turnEndsAt;
  $("speakerName").textContent = data.speakerName;
  $("speakerIndex").textContent = `${data.speakerIndex + 1}/${data.totalSpeakers}`;
  $("roundNum").textContent = data.roundNum;
  $("btnEndTurn").classList.toggle("hidden", data.speakerId !== myId);
  if (turnInterval) clearInterval(turnInterval);
  updateTimer();
  turnInterval = setInterval(updateTimer, 200);
});

socket.on("turnEnded", () => {
  currentSpeakerId = null;
  turnEndTimestamp = 0;
  $("btnEndTurn").classList.add("hidden");
  if (turnInterval) { clearInterval(turnInterval); turnInterval = null; }
  $("timerDisplay").textContent = "—";
  $("timerDisplay").style.color = "";
});

socket.on("phaseChange", (data) => {
  $("phaseBanner").textContent = data.message;
  $("phaseBanner").classList.remove("hidden");
  setTimeout(() => $("phaseBanner").classList.add("hidden"), 4000);
});

$("btnEndTurn").addEventListener("click", () => socket.emit("endMyTurn"));

// Чат
$("btnSendChat").addEventListener("click", () => {
  const text = $("chatInput").value.trim();
  if (text) { socket.emit("chatMessage", { text }); $("chatInput").value = ""; }
});
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSendChat").click(); });
socket.on("chatMessage", (data) => {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${data.senderName}:</strong> ${data.text}`;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});

// Аудио в игре
socket.on("audioMessage", (data) => {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<strong>${data.senderName}:</strong> `;
  const audio = document.createElement("audio");
  audio.controls = true; audio.src = data.data;
  div.appendChild(audio);
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});

// ===== Голосование =====
$("btnVotePanel").addEventListener("click", () => {
  $("votePanel").classList.toggle("hidden");
  if (!$("votePanel").classList.contains("hidden")) {
    const select = $("voteTarget");
    select.innerHTML = "";
    gamePlayers.forEach((p) => {
      if (p.id !== myId && p.connected) {
        const opt = document.createElement("option");
        opt.value = p.id; opt.textContent = p.name;
        select.appendChild(opt);
      }
    });
  }
});

$("btnVoteYes").addEventListener("click", () => {
  const targetId = $("voteTarget").value;
  if (targetId) { socket.emit("initiateVote", { targetId }); $("votePanel").classList.add("hidden"); }
});

$("btnVoteCancel").addEventListener("click", () => socket.emit("cancelVote"));

socket.on("voteStarted", (data) => {
  currentVote = data;
  $("voteStatus").classList.remove("hidden");
  $("voteStatusText").textContent = `${data.initiatorName} обвиняет ${data.targetName}!`;
  $("btnVoteCancel").classList.toggle("hidden", data.initiatorId !== myId);
  $("voteYesCount").textContent = "0";
  $("voteNoCount").textContent = "0";
});

socket.on("voteUpdate", (data) => {
  currentVote = data;
  $("voteYesCount").textContent = data.yes.length;
  $("voteNoCount").textContent = data.no.length;
  $("btnVoteCancel").classList.toggle("hidden", data.initiatorId !== myId);
});

socket.on("voteCancelled", (data) => {
  currentVote = null;
  $("voteStatus").classList.add("hidden");
  $("btnVoteCancel").classList.add("hidden");
});

socket.on("voteResult", (data) => {
  currentVote = null;
  $("voteStatus").classList.add("hidden");
  $("btnVoteCancel").classList.add("hidden");
});

function hideVotePanel() {
  $("votePanel").classList.add("hidden");
  $("voteStatus").classList.add("hidden");
}

// ===== Шпион угадывает =====
$("btnSpyGuess").addEventListener("click", () => {
  $("spyGuessPanel").classList.toggle("hidden");
  if (!$("spyGuessPanel").classList.contains("hidden")) {
    $("spyGuessSearch").value = "";
    renderSpyGuessOptions("");
    setTimeout(() => $("spyGuessSearch").focus(), 50);
  }
});

function renderSpyGuessOptions(filter) {
  const q = (filter || "").toLowerCase();
  const ul = $("spyGuessList"); ul.innerHTML = "";
  const matches = allLocations.filter((loc) => loc.toLowerCase().includes(q));
  matches.forEach((loc) => {
    const li = document.createElement("li");
    li.textContent = loc;
    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-primary";
    btn.textContent = "Выбрать";
    btn.addEventListener("click", () => socket.emit("spyGuess", { locationName: loc }));
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
$("spyGuessSearch").addEventListener("input", (e) => renderSpyGuessOptions(e.target.value));
$("btnSpyCancelGuess").addEventListener("click", () => { $("spyGuessPanel").classList.add("hidden"); });

function hideSpyGuessPanel() { $("spyGuessPanel").classList.add("hidden"); }

function renderLocationsList(filter) {
  const ul = $("locationsList"); ul.innerHTML = "";
  const q = (filter || "").toLowerCase();
  const matches = allLocations.filter((loc) => loc.toLowerCase().includes(q));
  matches.forEach((loc) => { const li = document.createElement("li"); li.textContent = loc; ul.appendChild(li); });
}
$("locSearch").addEventListener("input", (e) => renderLocationsList(e.target.value));

// ===== Завершение игры =====
$("btnStop").addEventListener("click", () => socket.emit("stopGame"));

socket.on("gameEnded", (data) => {
  $("resultReason").textContent = data.reason || "Игра окончена";
  $("resultLocation").textContent = data.locationName || "—";
  $("resultSpy").textContent = data.spyName || "—";
  if (data.winner === "spy") {
    $("resultVoteDetail").classList.remove("hidden");
    $("resultVoteText").textContent = "Шпион победил!";
  } else if (data.winner === "citizens") {
    $("resultVoteDetail").classList.remove("hidden");
    $("resultVoteText").textContent = "Местные победили!";
  } else {
    $("resultVoteDetail").classList.add("hidden");
  }
  const scoresList = $("resultScores"); scoresList.innerHTML = "";
  if (data.scores && Object.keys(data.scores).length > 0) {
    Object.entries(data.scores).forEach(([id, s]) => {
      const p = gamePlayers.find((pl) => pl.id === id);
      const li = document.createElement("li");
      li.textContent = `${p?.name || "Игрок"}: ${s} очк.`;
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
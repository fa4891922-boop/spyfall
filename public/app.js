/* Шпион — клиент: i18n, звуки, аватары, reconnect, зритель, наборы, спец-роли, чат, голосовые */
const socket = io();
const $ = (id) => document.getElementById(id);
const screens = { home: $("screen-home"), lobby: $("screen-lobby"), game: $("screen-game"), result: $("screen-result") };

// ===== Хранилище настроек (Фаза 2) =====
const LS = {
  name: "spy_name", lang: "spy_lang", sound: "spy_sound", duration: "spy_duration",
  turn: "spy_turn", set: "spy_set", session: "spy_session", room: "spy_room",
};
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// sessionId для reconnect
let sessionId = lsGet(LS.session, null);
if (!sessionId) { sessionId = (crypto.randomUUID ? crypto.randomUUID() : "s_" + Math.random().toString(36).slice(2) + Date.now()); lsSet(LS.session, sessionId); }

// ===== i18n (Фаза 4) =====
let DICT = {}, LANG = lsGet(LS.lang, (navigator.language || "ru").slice(0, 2) === "en" ? "en" : "ru");
function t(key) { return (DICT && DICT[key]) || key; }
async function loadLang(lang) {
  try {
    const res = await fetch(`lang/${lang}.json`);
    DICT = await res.json();
    LANG = lang; lsSet(LS.lang, lang);
    document.documentElement.lang = lang;
    applyI18n();
    document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  } catch (e) { console.warn("Не удалось загрузить язык", lang, e); }
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.getAttribute("data-i18n-attr").split(",").forEach((pair) => {
      const [attr, key] = pair.split(":"); if (attr && key) el.setAttribute(attr, t(key.trim()));
    });
  });
  renderQuickPhrases();
}
document.querySelectorAll(".lang-btn").forEach((b) => b.addEventListener("click", () => loadLang(b.dataset.lang)));

// ===== Звуки (Web Audio API, без файлов) (Фаза 2) =====
let audioCtx = null;
function soundEnabled() { return $("soundCheck").checked; }
function beep(freq, durMs, type = "sine", gain = 0.08) {
  if (!soundEnabled()) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + durMs / 1000);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + durMs / 1000);
  } catch (e) {}
}
const SFX = {
  turnStart: () => beep(660, 140, "sine"),
  turnEnd: () => beep(330, 180, "triangle"),
  vote: () => { beep(520, 120, "square", 0.06); setTimeout(() => beep(700, 120, "square", 0.06), 130); },
  reveal: () => { beep(440, 150, "sawtooth", 0.07); setTimeout(() => beep(587, 250, "sawtooth", 0.07), 160); },
  tick: () => beep(880, 60, "sine", 0.05),
};

// ===== Аватары (Фаза 3) =====
function avatarColor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 45%)`;
}
function makeAvatar(name, isBot) {
  const a = document.createElement("span");
  a.className = "avatar"; a.style.background = avatarColor(name || "?");
  a.textContent = isBot ? "🤖" : (name || "?").trim().charAt(0).toUpperCase();
  return a;
}

let myId = null, isHost = false, isSpy = false, isSpectator = false, currentCode = null;
let gamePlayers = [], speakingOrder = [], allLocations = [];
let currentSpeakerId = null, turnEndTimestamp = 0, turnInterval = null, lastTickSec = 99;
let mediaRecorder = null, audioChunks = [];

socket.on("connect", () => {
  myId = socket.id;
  // Попытка reconnect, если был в комнате
  const storedRoom = lsGet(LS.room, null);
  if (storedRoom) {
    socket.emit("resume", { code: storedRoom, sessionId, name: getName() }, (res) => {
      if (res?.ok) { currentCode = res.code; show(res.state === "playing" ? "game" : "lobby"); }
      else { lsSet(LS.room, ""); }
    });
  }
});

function show(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}
function getName() { return ($("nameInput").value.trim() || lsGet(LS.name, "") || "Игрок"); }

// ===== Инициализация настроек/языка =====
(async function init() {
  await loadLang(LANG);
  $("nameInput").value = lsGet(LS.name, "");
  $("soundCheck").checked = lsGet(LS.sound, "1") === "1";
  $("durationSelect").value = lsGet(LS.duration, "8");
  $("turnSelect").value = lsGet(LS.turn, "30");
  // Загрузка наборов локаций
  try {
    const res = await fetch("/api/locations");
    const data = await res.json();
    const sel = $("setSelect"); sel.innerHTML = "";
    (data.sets || []).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id; opt.textContent = (s.title && (s.title[LANG] || s.title.ru || s.title.en)) || s.id;
      sel.appendChild(opt);
    });
    sel.value = lsGet(LS.set, "classic");
  } catch (e) {}
  // Авто-подключение по ссылке (?room=XXXX)
  const roomFromUrl = new URLSearchParams(location.search).get("room");
  if (roomFromUrl && roomFromUrl.length >= 4) {
    $("codeInput").value = roomFromUrl.toUpperCase();
    socket.emit("joinRoom", { code: roomFromUrl.toUpperCase(), name: getName(), sessionId, spectator: $("joinAsSpectator").checked }, (res) => {
      if (res?.ok) { currentCode = res.code; lsSet(LS.room, res.code); show("lobby"); }
      else { $("homeError").textContent = t("home.roomNotFound"); }
    });
  }
})();

$("nameInput").addEventListener("input", (e) => lsSet(LS.name, e.target.value.trim()));
$("soundCheck").addEventListener("change", (e) => lsSet(LS.sound, e.target.checked ? "1" : "0"));
$("durationSelect").addEventListener("change", (e) => lsSet(LS.duration, e.target.value));
$("turnSelect").addEventListener("change", (e) => lsSet(LS.turn, e.target.value));
$("setSelect").addEventListener("change", (e) => lsSet(LS.set, e.target.value));

// ===== Главная =====
$("btnCreate").addEventListener("click", () => {
  $("homeError").textContent = "";
  socket.emit("createRoom", { name: getName(), sessionId }, (res) => {
    if (res?.ok) { currentCode = res.code; lsSet(LS.room, res.code); show("lobby"); }
    else $("homeError").textContent = res?.error || "Ошибка.";
  });
});
$("btnJoin").addEventListener("click", () => {
  $("homeError").textContent = "";
  const code = $("codeInput").value.trim().toUpperCase();
  if (code.length < 4) { $("homeError").textContent = t("home.codeTooShort"); return; }
  socket.emit("joinRoom", { code, name: getName(), sessionId, spectator: $("joinAsSpectator").checked }, (res) => {
    if (res?.ok) { currentCode = res.code; lsSet(LS.room, res.code); show(res.resumed ? "game" : "lobby"); }
    else $("homeError").textContent = res?.error || "Не удалось войти.";
  });
});
$("codeInput").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });

// ===== Лобби =====
$("btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentCode); $("btnCopy").textContent = t("lobby.copied"); setTimeout(() => $("btnCopy").textContent = t("lobby.copy"), 1500); }
  catch (e) { prompt("Код:", currentCode); }
});
$("btnShare").addEventListener("click", async () => {
  const link = `${location.origin}/?room=${currentCode}`;
  try {
    if (navigator.share) { await navigator.share({ title: "Шпион — присоединяйся!", text: `Код комнаты: ${currentCode}`, url: link }); }
    else { await navigator.clipboard.writeText(link); $("btnShare").textContent = t("lobby.linkCopied"); setTimeout(() => $("btnShare").textContent = t("lobby.share"), 1500); }
  } catch (e) { prompt("Ссылка:", link); }
});
function submitChangeName() {
  const newName = $("newNameInput").value.trim();
  $("nameChangeMsg").textContent = "";
  if (!newName) { $("nameChangeMsg").textContent = "Введите новый ник."; return; }
  socket.emit("changeName", { name: newName }, (res) => {
    if (res?.ok) { $("newNameInput").value = ""; lsSet(LS.name, res.name); $("nameChangeMsg").textContent = t("lobby.nickUpdated"); setTimeout(() => $("nameChangeMsg").textContent = "", 2000); }
    else $("nameChangeMsg").textContent = res?.error || "Ошибка смены имени.";
  });
}
$("btnChangeName").addEventListener("click", submitChangeName);
$("newNameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitChangeName(); });

$("btnAddBot").addEventListener("click", () => socket.emit("addBot"));

$("btnStart").addEventListener("click", () => {
  socket.emit("startGame", {
    duration: parseInt($("durationSelect").value, 10) || 8,
    turnSeconds: parseInt($("turnSelect").value, 10) || 30,
    setId: $("setSelect").value || "classic",
    specialRoles: $("specialRolesCheck").checked,
  });
});
$("btnBackToLobby").addEventListener("click", () => show("lobby"));

// ===== Аудио (голосовые) =====
function startRec() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      if (blob.size > 5e6) { $("lobbyError").textContent = "Слишком большое аудио (макс. 5 MB)."; return; }
      const reader = new FileReader();
      reader.onload = () => socket.emit("audioMessage", { data: reader.result });
      reader.readAsDataURL(blob);
      stream.getTracks().forEach((tk) => tk.stop());
    };
    mediaRecorder.start();
    $("recStatus").classList.remove("hidden");
    $("btnRecord").classList.add("recording");
  }).catch(() => { $("lobbyError").textContent = "Нет доступа к микрофону."; });
}
function stopRec() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  $("recStatus").classList.add("hidden");
  $("btnRecord").classList.remove("recording");
}
$("btnRecord").addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
$("btnRecord").addEventListener("pointerup", stopRec);
$("btnRecord").addEventListener("pointerleave", stopRec);
$("btnRecord").addEventListener("pointercancel", stopRec);

// ===== Обновление комнаты =====
socket.on("roomUpdate", (room) => {
  currentCode = room.code; isHost = room.hostId === myId;
  lsSet(LS.room, room.code);
  $("roomCode").textContent = room.code; $("playerCount").textContent = room.players.length;
  const list = $("playerList"); list.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    li.appendChild(makeAvatar(p.name, p.isBot));
    const dot = document.createElement("span"); dot.className = "dot" + (p.connected ? "" : " off");
    const name = document.createElement("span");
    name.textContent = p.name + (p.id === myId ? " " + t("lobby.you") : "") + (p.spectator ? " 👁️" : "");
    li.appendChild(dot); li.appendChild(name);
    if (p.isHost) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = t("lobby.host"); li.appendChild(tag); }
    if (p.score) { const sc = document.createElement("span"); sc.className = "score"; sc.textContent = p.score + " " + t("lobby.points"); li.appendChild(sc); }
    if (isHost && p.id !== myId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "btn btn-small btn-danger btn-inline";
      kickBtn.textContent = t("lobby.kick");
      kickBtn.onclick = () => socket.emit(p.isBot ? "removeBot" : "kickPlayer", p.isBot ? { botId: p.id } : { playerId: p.id });
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  });
  document.querySelectorAll(".host-only").forEach((el) => el.style.display = isHost ? "" : "none");
  $("btnStart").style.display = isHost ? "" : "none";
  const activeCount = room.players.filter((p) => !p.spectator).length;
  $("btnStart").disabled = activeCount < 3;
});

// ===== Игра: выдача роли =====
socket.on("roleAssigned", (data) => {
  isSpy = data.isSpy; isSpectator = !!data.spectator;
  gamePlayers = data.players || gamePlayers;
  speakingOrder = data.speakingOrder || [];
  allLocations = data.locations || allLocations;

  $("spectatorBanner").classList.toggle("hidden", !isSpectator);
  $("spyCard").classList.toggle("hidden", !isSpy);
  $("citizenCard").classList.toggle("hidden", isSpy);
  $("btnSpyGuess").classList.toggle("hidden", !isSpy);
  $("specialRoleBox").classList.add("hidden");
  // Зритель и шпион не голосуют действиями обычным образом; зритель — только смотрит
  $("btnVotePanel").classList.toggle("hidden", isSpectator);
  $("btnStop").style.display = isHost ? "" : "none";

  if (isSpy) {
    $("spyLocationHint").innerHTML = data.locationHint ? `<strong style="color:#fca5a5">${data.locationHint}</strong>` : "Внимательно слушайте других.";
    $("spyTopic").textContent = data.suggestedTopic || "";
  } else {
    $("locationName").textContent = data.location || "—";
    $("roleName").textContent = data.role || "—";
    if (data.special) {
      const box = $("specialRoleBox");
      box.classList.remove("hidden");
      let html = `<strong>⭐ ${data.special.name}</strong><br><span class="muted">${data.special.description}</span>`;
      if (data.special.candidates) html += `<br><span class="hint">Возможные локации: ${data.special.candidates.join(", ")}</span>`;
      if (data.special.spyName) html += `<br><span class="hint" style="color:#fca5a5">Шпион: ${data.special.spyName}</span>`;
      box.innerHTML = html;
    }
  }
  if (isSpectator && data.reveal) {
    $("locationName").textContent = data.reveal.locationName;
    $("roleName").textContent = "👁️ Шпион: " + data.reveal.spyName;
    $("citizenCard").classList.remove("hidden");
  }
  $("locSearch").value = ""; renderLocationsList("");
  if (!data.resumed) SFX.reveal();
  show("game");
});

// ===== Таймер хода =====
function updateTimer() {
  if (!turnEndTimestamp) return;
  const left = Math.max(0, Math.ceil((turnEndTimestamp - Date.now()) / 1000));
  $("timerDisplay").textContent = String(left);
  $("timerDisplay").classList.toggle("low", left <= 10);
  if (left <= 10 && left > 0 && left !== lastTickSec) { lastTickSec = left; SFX.tick(); }
  if (left <= 0) { clearInterval(turnInterval); turnInterval = null; }
}
socket.on("turnStarted", (data) => {
  currentSpeakerId = data.speakerId; turnEndTimestamp = data.turnEndsAt; lastTickSec = 99;
  $("speakerName").textContent = data.speakerName;
  $("speakerIndex").textContent = `${data.speakerIndex + 1}/${data.totalSpeakers}`;
  $("roundNum").textContent = data.roundNum;
  $("btnEndTurn").classList.toggle("hidden", data.speakerId !== myId);
  if (turnInterval) clearInterval(turnInterval);
  updateTimer(); turnInterval = setInterval(updateTimer, 200);
  if (data.speakerId === myId) SFX.turnStart();
});
socket.on("turnEnded", () => {
  currentSpeakerId = null; turnEndTimestamp = 0;
  $("btnEndTurn").classList.add("hidden");
  if (turnInterval) { clearInterval(turnInterval); turnInterval = null; }
  $("timerDisplay").textContent = "—"; $("timerDisplay").classList.remove("low");
  SFX.turnEnd();
});
socket.on("phaseChange", (data) => {
  const span = $("phaseBanner").querySelector("span") || $("phaseBanner");
  span.textContent = data.message;
  $("phaseBanner").classList.remove("hidden");
  if (data.phase === "voting") SFX.vote();
  setTimeout(() => $("phaseBanner").classList.add("hidden"), 4000);
});
$("btnEndTurn").addEventListener("click", () => socket.emit("endMyTurn"));

// ===== Чат =====
function renderQuickPhrases() {
  const box = $("quickPhrases"); if (!box) return;
  const phrases = ["👍", "👎", "🤔", "😂", "Точно не я!", "Подозрительно...", "Согласен"];
  box.innerHTML = "";
  phrases.forEach((p) => {
    const b = document.createElement("button");
    b.className = "quick-phrase"; b.textContent = p;
    b.onclick = () => socket.emit("chatMessage", { text: p });
    box.appendChild(b);
  });
}
$("btnSendChat").addEventListener("click", () => {
  const text = $("chatInput").value.trim();
  if (text) { socket.emit("chatMessage", { text }); $("chatInput").value = ""; }
});
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnSendChat").click(); });
socket.on("chatMessage", (data) => {
  const div = document.createElement("div");
  div.className = "chat-msg" + (data.senderId === myId ? " mine" : "");
  div.appendChild(makeAvatar(data.senderName, data.isBot));
  const body = document.createElement("span");
  body.innerHTML = `<span class="chat-author">${data.senderName}</span><span class="chat-text">${escapeHtml(data.text)}</span>`;
  div.appendChild(body);
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});
socket.on("audioMessage", (data) => {
  const div = document.createElement("div");
  div.className = "chat-msg" + (data.senderId === myId ? " mine" : "");
  div.appendChild(makeAvatar(data.senderName, false));
  const body = document.createElement("span");
  body.innerHTML = `<span class="chat-author">${data.senderName}</span>`;
  const audio = document.createElement("audio"); audio.controls = true; audio.src = data.data;
  body.appendChild(audio); div.appendChild(body);
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ===== Голосование =====
$("btnVotePanel").addEventListener("click", () => {
  $("votePanel").classList.toggle("hidden");
  if (!$("votePanel").classList.contains("hidden")) {
    const select = $("voteTarget"); select.innerHTML = "";
    gamePlayers.forEach((p) => {
      if (p.id !== myId && p.connected && !p.spectator) {
        const opt = document.createElement("option"); opt.value = p.id; opt.textContent = p.name; select.appendChild(opt);
      }
    });
  }
});
$("btnVoteYes").addEventListener("click", () => {
  const targetId = $("voteTarget").value;
  if (targetId) { socket.emit("initiateVote", { targetId }); $("votePanel").classList.add("hidden"); }
});
$("btnVoteCastYes").addEventListener("click", () => socket.emit("castVote", { vote: "yes" }));
$("btnVoteCastNo").addEventListener("click", () => socket.emit("castVote", { vote: "no" }));
$("btnVoteCancel").addEventListener("click", () => socket.emit("cancelVote"));

socket.on("voteStarted", (data) => {
  $("voteStatus").classList.remove("hidden");
  $("voteStatusText").textContent = `${data.initiatorName} → ${data.targetName}?`;
  $("btnVoteCancel").classList.toggle("hidden", data.initiatorId !== myId);
  const amTarget = data.targetId === myId;
  $("btnVoteCastYes").classList.toggle("hidden", amTarget || isSpectator);
  $("btnVoteCastNo").classList.toggle("hidden", amTarget || isSpectator);
  $("voteYesCount").textContent = "0"; $("voteNoCount").textContent = "0";
  SFX.vote();
});
socket.on("voteUpdate", (data) => {
  $("voteYesCount").textContent = data.yes.length;
  $("voteNoCount").textContent = data.no.length;
  $("btnVoteCancel").classList.toggle("hidden", data.initiatorId !== myId);
});
socket.on("voteCancelled", () => { $("voteStatus").classList.add("hidden"); $("btnVoteCancel").classList.add("hidden"); });
socket.on("voteResult", () => { $("voteStatus").classList.add("hidden"); $("btnVoteCancel").classList.add("hidden"); });
function hideVotePanel() { $("votePanel").classList.add("hidden"); $("voteStatus").classList.add("hidden"); }

// ===== Шпион угадывает =====
$("btnSpyGuess").addEventListener("click", () => {
  $("spyGuessPanel").classList.toggle("hidden");
  if (!$("spyGuessPanel").classList.contains("hidden")) {
    $("spyGuessSearch").value = ""; renderSpyGuessOptions("");
    setTimeout(() => $("spyGuessSearch").focus(), 50);
  }
});
function renderSpyGuessOptions(filter) {
  const q = (filter || "").toLowerCase();
  const ul = $("spyGuessList"); ul.innerHTML = "";
  allLocations.filter((loc) => loc.toLowerCase().includes(q)).forEach((loc) => {
    const li = document.createElement("li"); li.textContent = loc;
    const btn = document.createElement("button");
    btn.className = "btn btn-small btn-primary btn-inline"; btn.textContent = "✓";
    btn.addEventListener("click", () => socket.emit("spyGuess", { locationName: loc }));
    li.appendChild(btn); ul.appendChild(li);
  });
}
$("spyGuessSearch").addEventListener("input", (e) => renderSpyGuessOptions(e.target.value));
$("btnSpyCancelGuess").addEventListener("click", () => $("spyGuessPanel").classList.add("hidden"));
function hideSpyGuessPanel() { $("spyGuessPanel").classList.add("hidden"); }

function renderLocationsList(filter) {
  const ul = $("locationsList"); ul.innerHTML = "";
  const q = (filter || "").toLowerCase();
  allLocations.filter((loc) => loc.toLowerCase().includes(q)).forEach((loc) => { const li = document.createElement("li"); li.textContent = loc; ul.appendChild(li); });
}
$("locSearch").addEventListener("input", (e) => renderLocationsList(e.target.value));

// ===== Завершение игры / итоги (Фаза 3) =====
$("btnStop").addEventListener("click", () => socket.emit("stopGame"));

socket.on("gameEnded", (data) => {
  $("resultReason").textContent = data.reason || "Игра окончена";
  $("resultLocation").textContent = data.locationName || "—";
  $("resultSpy").textContent = data.spyName || "—";
  if (data.winner === "spy") { $("resultVoteDetail").classList.remove("hidden"); $("resultVoteText").textContent = t("result.spyWon"); }
  else if (data.winner === "citizens") { $("resultVoteDetail").classList.remove("hidden"); $("resultVoteText").textContent = t("result.citizensWon"); }
  else $("resultVoteDetail").classList.add("hidden");

  // Раскрытие ролей
  const rev = $("resultReveal"); rev.innerHTML = "";
  (data.reveal || []).forEach((r) => {
    const li = document.createElement("li");
    li.appendChild(makeAvatar(r.name, false));
    const span = document.createElement("span");
    const tagClass = r.kind === "spy" ? "role-tag spy" : r.kind === "detective" ? "role-tag det" : r.kind === "spyPartner" ? "role-tag partner" : "role-tag";
    span.innerHTML = `<strong>${r.name}</strong> — <span class="${tagClass}">${r.label}</span>`;
    li.appendChild(span); rev.appendChild(li);
  });

  // Голоса
  if (data.lastVotes) {
    $("resultVotesBox").classList.remove("hidden");
    const y = (data.lastVotes.yes || []).join(", ") || "—";
    const n = (data.lastVotes.no || []).join(", ") || "—";
    $("resultVotes").innerHTML = `Обвиняли: <strong>${data.lastVotes.targetName}</strong><br>За: ${y}<br>Против: ${n}`;
  } else $("resultVotesBox").classList.add("hidden");

  // Лидерборд
  const scoresList = $("resultScores"); scoresList.innerHTML = "";
  const board = data.leaderboard && data.leaderboard.length ? data.leaderboard
    : Object.entries(data.scores || {}).map(([id, s]) => ({ id, name: (gamePlayers.find((p) => p.id === id) || {}).name || t("common.player"), score: s, spyCount: 0, wins: 0 }));
  if (board.length) {
    board.forEach((p, i) => {
      const li = document.createElement("li");
      li.appendChild(makeAvatar(p.name, false));
      const span = document.createElement("span");
      span.innerHTML = `<strong>${i + 1}. ${p.name}</strong> — ${p.score} ${t("lobby.points")} <span class="muted">(${p.wins || 0} ${t("result.wins")}, ${p.spyCount || 0} ${t("result.timesSpy")})</span>`;
      li.appendChild(span); scoresList.appendChild(li);
    });
  } else { const li = document.createElement("li"); li.textContent = t("common.noPoints"); scoresList.appendChild(li); }

  SFX.reveal();
  show("result"); hideVotePanel(); hideSpyGuessPanel();
});

// ===== Ошибки / служебное =====
socket.on("errorMsg", (msg) => { $("lobbyError").textContent = msg; setTimeout(() => $("lobbyError").textContent = "", 4000); });
socket.on("kicked", () => { currentCode = null; lsSet(LS.room, ""); show("home"); $("homeError").textContent = t("home.kicked"); });

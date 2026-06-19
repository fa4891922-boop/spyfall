/* Игра «Шпион» — клиентская логика */
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
let currentCode = null;

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
    list.appendChild(li);
  });

  $("hostControls").classList.toggle("hidden", !isHost);
  $("waitMsg").classList.toggle("hidden", isHost);
  $("gameHostControls").classList.toggle("hidden", !isHost);
});

// ===== Назначение роли =====
socket.on("roleAssigned", (data) => {
  show("game");
  $("roleSpy").classList.toggle("hidden", !data.isSpy);
  $("roleNormal").classList.toggle("hidden", data.isSpy);

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

// ===== Конец игры =====
socket.on("gameEnded", (data) => {
  $("resultReason").textContent = data.reason || "Игра окончена";
  $("resultLocation").textContent = data.locationName || "—";
  $("resultSpy").textContent = data.spyName || "—";
  show("result");
});

// ===== Ошибки =====
socket.on("errorMsg", (msg) => {
  $("lobbyError").textContent = msg;
  setTimeout(() => ($("lobbyError").textContent = ""), 4000);
});

socket.on("disconnect", () => {
  $("homeError").textContent = "";
});

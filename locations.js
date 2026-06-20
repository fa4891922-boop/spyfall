// Обратная совместимость: классический набор локаций теперь хранится в
// data/locations/classic.json. Этот модуль просто реэкспортирует его,
// чтобы старый код, который делал require("./locations"), продолжал работать.
const fs = require("fs");
const path = require("path");

let classic = [];
try {
  classic = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "locations", "classic.json"), "utf8"));
} catch (e) {
  console.error("Не удалось прочитать classic.json:", e.message);
}

module.exports = classic;

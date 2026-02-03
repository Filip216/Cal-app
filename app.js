const STORAGE = "mealApp";
const SESSION = "mealSession";
let user = null;

function load() {
  return JSON.parse(localStorage.getItem(STORAGE)) || {};
}

function save(d) {
  localStorage.setItem(STORAGE, JSON.stringify(d));
}

function autoLogin() {
  const u = localStorage.getItem(SESSION);
  const d = load();
  if (u && d[u]) {
    user = u;
    auth.classList.add("hidden");
    app.classList.remove("hidden");
    renderAll();
  }
}

autoLogin();

function login() {
  const u = username.value.trim();
  const p = password.value.trim();
  if (!u || !p) return;

  const d = load();

  if (!d[u]) {
    d[u] = {
      password: p,
      meals: [],
      today: { totals: empty(), entries: [] },
      days: []
    };
  } else if (d[u].password !== p) {
    alert("Wrong password");
    return;
  }

  user = u;
  localStorage.setItem(SESSION, u);
  save(d);

  auth.classList.add("hidden");
  app.classList.remove("hidden");
  renderAll();
}

function logout() {
  localStorage.removeItem(SESSION);
  location.reload();
}

function empty() {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

/* ---------- MEALS ---------- */

function addMeal() {
  const d = load();
  d[user].meals.push({
    name: mealName.value,
    desc: mealDesc.value,
    kcal: +kcal.value,
    protein: +protein.value,
    carbs: +carbs.value,
    fat: +fat.value
  });
  save(d);
  renderMeals();
}

function renderMeals() {
  mealList.innerHTML = "";
  load()[user].meals.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "meal-card";
    el.innerHTML = `
      <div>
        <strong>${m.name}</strong>
        <span>(${m.desc})</span>
      </div>
      <button onclick="eat(${i})">+</button>
    `;
    mealList.appendChild(el);
  });
}

function eat(i) {
  const g = +prompt("Grams?");
  if (!g) return;

  const d = load();
  const m = d[user].meals[i];
  const f = g / 100;

  const entry = {
    id: Date.now(),
    name: m.name,
    grams: g,
    active: true,
    values: {
      kcal: m.kcal * f,
      protein: m.protein * f,
      carbs: m.carbs * f,
      fat: m.fat * f
    }
  };

  d[user].today.entries.push(entry);
  apply(d[user].today.totals, entry.values, 1);
  save(d);
  showPage("today");
  renderToday();
}

/* ---------- TODAY ---------- */

function apply(t, v, s) {
  Object.keys(v).forEach(k => t[k] += v[k] * s);
}

function toggleEntry(id) {
  const d = load();
  const e = d[user].today.entries.find(x => x.id === id);
  if (!e) return;
  e.active = !e.active;
  apply(d[user].today.totals, e.values, e.active ? 1 : -1);
  save(d);
  renderToday();
}

function deleteEntry(id) {
  const d = load();
  const arr = d[user].today.entries;
  const i = arr.findIndex(e => e.id === id);
  if (i === -1) return;
  if (arr[i].active) apply(d[user].today.totals, arr[i].values, -1);
  arr.splice(i, 1);
  save(d);
  renderToday();
}

function renderToday() {
  const t = load()[user].today;
  todayTotals.innerHTML = `
    <strong>${t.totals.kcal.toFixed(0)}</strong> kcal<br>
    P ${t.totals.protein.toFixed(1)} ·
    C ${t.totals.carbs.toFixed(1)} ·
    F ${t.totals.fat.toFixed(1)}
  `;

  todayEntries.innerHTML = "";
  t.entries.forEach(e => {
    const el = document.createElement("div");
    el.className = `today-card ${e.active ? "" : "paused"}`;
    el.innerHTML = `
      <div>
        <strong>${e.name}</strong>
        <small>${e.grams}g · ${e.values.kcal.toFixed(0)} kcal</small>
        <small>P ${e.values.protein.toFixed(1)} · C ${e.values.carbs.toFixed(1)} · F ${e.values.fat.toFixed(1)}</small>
      </div>
      <div class="actions">
        <button onclick="toggleEntry(${e.id})">${e.active ? "–" : "+"}</button>
        <button class="danger" onclick="deleteEntry(${e.id})">✕</button>
      </div>
    `;
    todayEntries.appendChild(el);
  });
}

function finishDay() {
  const d = load();
  d[user].days.push({ date: new Date(), totals: d[user].today.totals });
  d[user].today = { totals: empty(), entries: [] };
  save(d);
  renderToday();
}

/* ---------- STATS ---------- */

function renderStats() {
  const days = load()[user].days.slice(-7);
  if (days.length < 1) {
    statsContent.innerText = "No data yet.";
    return;
  }

  const from = new Date(days[0].date).toLocaleDateString();
  const to = new Date(days.at(-1).date).toLocaleDateString();

  statsContent.innerHTML = `
    <div class="week-label">${from} – ${to}</div>
    <div class="graph">
      ${["kcal","protein","carbs","fat"].map(n => `
        <div class="graph-column">
          <strong>${n}</strong>
          <div class="bar">
            ${days.map(d =>
              `<div class="${n}" style="height:${d.totals[n] / 10}px"></div>`
            ).join("")}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

/* ---------- NAV ---------- */

function showPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
  if (id === "stats") renderStats();
}

function renderAll() {
  renderMeals();
  renderToday();
}

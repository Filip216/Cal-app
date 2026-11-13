'use strict';
/* Meal Tracker v3
   All data lives in this browser (localStorage). The only network calls are the
   optional "Look up values" searches (USDA FoodData Central, Open Food Facts). */

const KEY = 'mealTrackerV2';
const OLD_KEY = 'mealApp';
const OLD_SESSION = 'mealSession';
const THEME_KEY = 'mealTheme';
const MACROS = ['kcal', 'protein', 'carbs', 'fat'];
const LABEL = { kcal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };
const DEFAULT_ROLLOVER = 3; // eating before 03:00 still counts for the previous day

let db = { version: 2, session: null, users: {}, migratedOld: false };
const ui = {
  tab: 'today',
  viewDate: null,        // null = follow "today"
  profilePage: 'home',   // home | stats | goals | backup | settings
  foodsTab: 'foods',     // foods | meals
  weekOffset: 0,
  metric: 'kcal',
  selDay: null,
  authMode: 'login',
  search: '',
  expanded: null,        // id of the Today entry whose details are open
  expandedGroup: null,   // id of the Today meal that is open
  enter: false,          // play the "page just opened" animation on the next render
  fresh: null,           // { since } -> rows added after this moment get a pop-in animation
  opened: null           // id of the entry / meal / day that was just opened (animate its details)
};
let enterNow = false;
let ctx = null;            // state of the open sheet
let pendingConfirm = null; // resolver of an open confirm sheet

/* ====================================================================
   Small helpers
   ==================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const r1 = x => Math.round(x * 10) / 10;

// Accepts "12.5" and "12,5" (Croatian keyboards use a comma)
function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function fmt(n, d = 0) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

// P / C / F with colours (colours come from CSS)
const mline = v => '<span class="mp">P ' + fmt(v.protein, 1) + '</span> · <span class="mc">C ' + fmt(v.carbs, 1) + '</span> · <span class="mf">F ' + fmt(v.fat, 1) + '</span>';
// same, with the unit written out (used where readability matters most)
const mlineG = v => '<span class="mp">P ' + fmt(v.protein, 1) + ' g</span> · <span class="mc">C ' + fmt(v.carbs, 1) + ' g</span> · <span class="mf">F ' + fmt(v.fat, 1) + ' g</span>';

/* ---------- dates (a day is a "YYYY-MM-DD" key) ---------- */

function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return ymd(d); }
function dayKeyAt(date, hour) { return ymd(new Date(date.getTime() - hour * 3600000)); }
function weekStart(k) { const d = parseKey(k); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); } // Monday
function fmtDay(k, opts) { return parseKey(k).toLocaleDateString(undefined, opts); }

function rollover() { const u = me(); return u && Number.isInteger(u.settings.rolloverHour) ? u.settings.rolloverHour : DEFAULT_ROLLOVER; }
function todayKey() { return dayKeyAt(new Date(), rollover()); }
function viewKey() { return ui.viewDate || todayKey(); }

/* ---------- theme (per device, not per profile) ---------- */

function themePref() { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; } }
function applyTheme() {
  const p = themePref();
  const dark = p === 'dark' || (p === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', dark ? '#060b1d' : '#eceff7');
}

/* ====================================================================
   Data layer
   ==================================================================== */

function me() { return db.session ? db.users[db.session] || null : null; }

function newUser(name, hash, salt) {
  return {
    name, hash, salt,
    foods: [],
    meals: [],
    days: {},
    goals: { kcal: null, protein: null, carbs: null, fat: null, maint: null },
    settings: { rolloverHour: DEFAULT_ROLLOVER, lastExport: null, usdaKey: '' }
  };
}

function normalizeUsers() {
  Object.values(db.users).forEach(u => {
    if (!Array.isArray(u.foods)) u.foods = [];
    if (!Array.isArray(u.meals)) u.meals = [];
    if (!u.days || typeof u.days !== 'object') u.days = {};
    u.goals = Object.assign({ kcal: null, protein: null, carbs: null, fat: null, maint: null }, u.goals);
    u.settings = Object.assign({ rolloverHour: DEFAULT_ROLLOVER, lastExport: null, usdaKey: '' }, u.settings);
  });
}

function loadDb() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (!raw) return;
  try {
    const p = JSON.parse(raw);
    if (p && p.version === 2 && p.users) { db = Object.assign(db, p); normalizeUsers(); }
  } catch (e) {
    // Never overwrite something we could not read: keep a copy of it.
    try { localStorage.setItem(KEY + '_corrupt', raw); } catch (_) { /* ignore */ }
  }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
  catch (e) { toast('Could not save — browser storage is full or blocked.'); return false; }
}

const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });

function getDay(key) {
  return me().days[key] || { entries: [], finished: false, legacy: null };
}
function ensureDay(key) {
  const u = me();
  if (!u.days[key]) u.days[key] = { entries: [], finished: false, legacy: null };
  return u.days[key];
}
function foodById(id) { const u = me(); return (u && u.foods.find(f => f.id === id)) || null; }

// Entries store the food's per-100g values *as they were when logged*,
// so editing or deleting a food later never rewrites history.
function entryVals(e) {
  const f = e.grams / 100, o = {};
  MACROS.forEach(k => { o[k] = (e.per100[k] || 0) * f; });
  return o;
}
function sumEntries(list) {
  const t = zero();
  list.forEach(e => { const v = entryVals(e); MACROS.forEach(k => { t[k] += v[k]; }); });
  return t;
}
// Totals are always recomputed from the active entries (no running +/- that can drift).
function dayTotals(day) {
  if (!day) return zero();
  if (day.legacy && !day.entries.length) return Object.assign(zero(), day.legacy);
  return sumEntries(day.entries.filter(e => e.active));
}
const hasTotals = t => MACROS.some(k => t[k] > 0);

function goalOf(k) { const g = me().goals[k]; return g > 0 ? g : null; }

// A day imported from the old app only has totals. If the user adds food to it,
// keep those totals as one entry instead of silently dropping them.
function convertLegacy(day) {
  if (day.legacy && !day.entries.length) {
    day.entries.push({ id: uid(), foodId: null, name: 'Imported total (old app)', grams: 100, active: true, per100: Object.assign(zero(), day.legacy), at: 0 });
  }
  day.legacy = null;
}

function addEntry(key, food, grams, active = true) {
  const day = ensureDay(key);
  convertLegacy(day);
  day.entries.push({
    id: uid(), foodId: food.id, name: food.name, grams, active,
    per100: { kcal: food.kcal, protein: food.protein, carbs: food.carbs, fat: food.fat },
    at: Date.now()
  });
  food.lastUsed = Date.now();
  food.lastGrams = grams;
  persist();
}

/* ---------- meals (a saved combination of foods) ---------- */

// grams: optional array aligned with meal.items (otherwise the meal's default amounts)
function mealTotals(meal, grams) {
  const t = zero();
  meal.items.forEach((it, i) => {
    const f = foodById(it.foodId);
    if (!f) return;
    const g = grams ? grams[i] : it.grams;
    const k = (g > 0 ? g : 0) / 100;
    MACROS.forEach(m => { t[m] += f[m] * k; });
  });
  return t;
}

function mealSummary(m) {
  return m.items.map(it => { const f = foodById(it.foodId); return f ? f.name + ' ' + fmt(it.grams, 1) + ' g' : null; }).filter(Boolean).join(' · ');
}

// Logging a meal creates one normal entry per ingredient, tied together by a groupId.
// Every existing feature (pause, edit grams, delete, totals) keeps working per ingredient.
function logMeal(key, meal, grams, active = true) {
  const day = ensureDay(key);
  convertLegacy(day);
  const gid = uid(), now = Date.now();
  let n = 0;
  meal.items.forEach((it, i) => {
    const f = foodById(it.foodId), g = grams[i];
    if (!f || !(g > 0)) return;
    day.entries.push({
      id: uid(), foodId: f.id, name: f.name, grams: g, active,
      per100: { kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat },
      at: now + i, groupId: gid, groupName: meal.name
    });
    n++;
  });
  meal.lastUsed = now;
  persist();
  return n;
}

function groupEntries(entries) {
  const out = [], idx = {};
  entries.forEach(e => {
    if (e.groupId) {
      if (idx[e.groupId] === undefined) { idx[e.groupId] = out.length; out.push({ group: e.groupId, name: e.groupName || 'Meal', items: [e] }); }
      else out[idx[e.groupId]].items.push(e);
    } else out.push({ single: e });
  });
  return out;
}

function removeEntry(key, id) {
  const day = me().days[key];
  if (!day) return;
  const i = day.entries.findIndex(e => e.id === id);
  if (i < 0) return;
  const [removed] = day.entries.splice(i, 1);
  persist();
  render();
  toast('Removed ' + removed.name, {
    label: 'Undo',
    fn: () => { const d = ensureDay(key); d.entries.splice(Math.min(i, d.entries.length), 0, removed); persist(); render(); }
  });
}

function removeGroup(key, gid) {
  const day = me().days[key];
  if (!day) return;
  const removed = [];
  day.entries = day.entries.filter((e, i) => { if (e.groupId === gid) { removed.push({ e, i }); return false; } return true; });
  if (!removed.length) return;
  persist();
  render();
  toast('Removed ' + (removed[0].e.groupName || 'meal'), {
    label: 'Undo',
    fn: () => { const d = ensureDay(key); removed.forEach(({ e, i }) => d.entries.splice(Math.min(i, d.entries.length), 0, e)); persist(); render(); }
  });
}

/* ---------- stats helpers ---------- */

const KCAL_PER_KG = 7700; // common rule of thumb for body weight change

// consecutive days with something logged, ending today (or yesterday while today is still empty)
function streaks(u, tk) {
  const has = k => hasTotals(dayTotals(u.days[k]));
  let k = has(tk) ? tk : addDays(tk, -1), cur = 0;
  while (has(k)) { cur++; k = addDays(k, -1); }
  const keys = Object.keys(u.days).filter(has).sort();
  let best = 0, run = 0, prev = null;
  keys.forEach(x => { run = prev && addDays(prev, 1) === x ? run + 1 : 1; if (run > best) best = run; prev = x; });
  return { cur, best };
}

// rows: [{ has, live, t: { kcal } }] -> surplus (+) / deficit (-) against maintenance, finished days only
function weekBalance(rows, maint) {
  const used = rows.filter(r => r.has && !r.live);
  const total = used.reduce((sum, r) => sum + (r.t.kcal - maint), 0);
  return { n: used.length, total, kg: total / KCAL_PER_KG, avg: used.length ? total / used.length : 0 };
}

// slide a row out before it is removed (skipped when the phone asks for reduced motion)
function animateOut(el, fn) {
  const row = el.closest('.sub, .row, .group');
  if (!row || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { fn(); return; }
  row.classList.add('leaving');
  setTimeout(fn, 170);
}

// small number count-up used on key figures
function countUp(el) {
  const to = +el.dataset.to, dec = +el.dataset.dec || 0;
  if (!Number.isFinite(to) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const t0 = performance.now(), D = 650;
  el.textContent = fmt(0, dec);
  (function step(t) {
    const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(to * e, dec);
    if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(to, dec);
  })(t0);
}

/* ---------- passwords ----------
   This only separates profiles on one device; it is not real security
   (the data sits in localStorage anyway). */

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

async function hashPw(pw, salt, forceFallback = false) {
  const data = salt + ':' + pw;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && !forceFallback) {
    try {
      const buf = await subtle.digest('SHA-256', new TextEncoder().encode(data));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* fall through */ }
  }
  return 'x' + cyrb53(data);
}
async function verifyPw(pw, user) {
  return (await hashPw(pw, user.salt, user.hash.startsWith('x'))) === user.hash;
}

/* ---------- migration from the first version of the app ---------- */

async function migrateOld() {
  if (db.migratedOld) return;
  let old = null;
  try { old = JSON.parse(localStorage.getItem(OLD_KEY)); } catch (e) { old = null; }
  if (old && typeof old === 'object') {
    for (const [name, u] of Object.entries(old)) {
      if (!u || typeof u !== 'object') continue;
      let key = name.trim().toLowerCase() || 'user', i = 2;
      while (db.users[key]) key = name.trim().toLowerCase() + '_' + (i++);
      const salt = uid();
      const user = newUser(name.trim() || 'User', await hashPw(String(u.password ?? ''), salt), salt);

      user.foods = (Array.isArray(u.meals) ? u.meals : []).map(m => ({
        id: uid(), name: String(m.name || 'Unnamed food').slice(0, 60), desc: String(m.desc || '').slice(0, 100),
        kcal: Math.max(0, +m.kcal || 0), protein: Math.max(0, +m.protein || 0), carbs: Math.max(0, +m.carbs || 0), fat: Math.max(0, +m.fat || 0),
        portion: null, source: '', createdAt: Date.now(), lastUsed: 0, lastGrams: null
      }));

      // finished days of the old app (totals only)
      (Array.isArray(u.days) ? u.days : []).forEach(d => {
        if (!d || !d.totals) return;
        const k = ymd(new Date(d.date));
        if (k.includes('NaN')) return;
        const t = Object.assign(zero(), { kcal: +d.totals.kcal || 0, protein: +d.totals.protein || 0, carbs: +d.totals.carbs || 0, fat: +d.totals.fat || 0 });
        const ex = user.days[k];
        if (ex && ex.legacy) MACROS.forEach(m => { ex.legacy[m] += t[m]; });
        else user.days[k] = { entries: [], finished: true, legacy: t };
      });

      // the unfinished "today" of the old app
      const te = u.today && Array.isArray(u.today.entries) ? u.today.entries : [];
      if (te.length) {
        const tk = dayKeyAt(new Date(), DEFAULT_ROLLOVER);
        const day = user.days[tk] || (user.days[tk] = { entries: [], finished: false, legacy: null });
        te.forEach(e => {
          const g = +e.grams;
          if (!(g > 0) || !e.values) return;
          day.entries.push({
            id: uid(), foodId: null, name: String(e.name || 'Food').slice(0, 60), grams: g, active: e.active !== false,
            per100: { kcal: (+e.values.kcal || 0) / g * 100, protein: (+e.values.protein || 0) / g * 100, carbs: (+e.values.carbs || 0) / g * 100, fat: (+e.values.fat || 0) / g * 100 },
            at: +e.id || 0
          });
        });
      }
      db.users[key] = user;
    }
    const os = localStorage.getItem(OLD_SESSION);
    if (!db.session && os && db.users[os.trim().toLowerCase()]) db.session = os.trim().toLowerCase();
  }
  db.migratedOld = true; // the old data is left untouched as a safety net
  persist();
}

/* ====================================================================
   Public food databases (optional "Look up values")
   ==================================================================== */

function sentenceCase(s) {
  s = String(s || '').trim();
  return s && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

// USDA FoodData Central search result -> [{source,name,desc,kcal,protein,carbs,fat,url}]
function parseUSDA(j) {
  return ((j && j.foods) || []).map(f => {
    const n = {};
    (f.foodNutrients || []).forEach(x => {
      const id = x.nutrientId, no = String(x.nutrientNumber || ''), unit = String(x.unitName || '').toUpperCase(), val = +x.value;
      if (!Number.isFinite(val)) return;
      if ((id === 1008 || no === '208') && unit === 'KCAL') n.kcal = val;
      else if ((id === 2047 || id === 2048 || no === '957' || no === '958') && unit === 'KCAL' && n.kcal === undefined) n.kcal = val;
      else if (id === 1003 || no === '203') n.protein = val;
      else if (id === 1005 || no === '205') n.carbs = val;
      else if (id === 1004 || no === '204') n.fat = val;
    });
    if (!Number.isFinite(n.kcal) || !f.description) return null;
    return {
      source: 'USDA' + (f.dataType ? ' · ' + f.dataType : ''),
      name: sentenceCase(f.description).slice(0, 60),
      desc: '',
      kcal: r1(n.kcal), protein: r1(n.protein || 0), carbs: r1(n.carbs || 0), fat: r1(n.fat || 0),
      url: /^\d+$/.test(String(f.fdcId)) ? 'https://fdc.nal.usda.gov/food-details/' + f.fdcId + '/nutrients' : ''
    };
  }).filter(Boolean);
}

// Open Food Facts search result
function parseOFF(j) {
  return ((j && j.products) || []).map(p => {
    const nu = p.nutriments || {};
    const kcal = +nu['energy-kcal_100g'];
    if (!p.product_name || !Number.isFinite(kcal)) return null;
    const code = String(p.code || '');
    return {
      source: 'Open Food Facts',
      name: String(p.product_name).trim().slice(0, 60),
      desc: String(p.brands || '').split(',')[0].trim().slice(0, 40),
      kcal: r1(kcal), protein: r1(+nu.proteins_100g || 0), carbs: r1(+nu.carbohydrates_100g || 0), fat: r1(+nu.fat_100g || 0),
      url: /^\d+$/.test(code) ? 'https://world.openfoodfacts.org/product/' + code : ''
    };
  }).filter(Boolean);
}

async function fetchJson(url, ms = 9000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function searchUSDA(q) {
  const key = (me().settings.usdaKey || '').trim() || 'DEMO_KEY';
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?query=' + encodeURIComponent(q) +
    '&pageSize=8&dataType=Foundation,SR%20Legacy&api_key=' + encodeURIComponent(key);
  return parseUSDA(await fetchJson(url));
}

async function searchOFF(q) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) +
    '&search_simple=1&action=process&json=1&page_size=8&fields=code,product_name,brands,nutriments';
  return parseOFF(await fetchJson(url));
}

function whyFailed(e) {
  const m = String((e && e.message) || '');
  if (e && e.name === 'AbortError') return 'timed out';
  if (m.includes('429')) return 'daily limit reached';
  return 'unavailable (offline?)';
}

/* ====================================================================
   UI plumbing: sheets, toast, confirm
   ==================================================================== */

function openSheet(html) {
  const root = $('#sheetRoot');
  root.innerHTML = '<div class="overlay" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
  document.body.classList.add('lock');
  requestAnimationFrame(() => root.classList.add('open'));
  syncKeyboard();
}

// Swap the content of the sheet that is already open (no re-animation); otherwise open one.
function setSheet(html) {
  const root = $('#sheetRoot'), s = $('#sheetRoot .sheet');
  if (s && root.classList.contains('open')) { s.innerHTML = html; s.scrollTop = 0; syncKeyboard(); }
  else openSheet(html);
}

function closeSheet() {
  const root = $('#sheetRoot');
  root.classList.remove('open');
  document.body.classList.remove('lock');
  ctx = null;
  if (pendingConfirm) { const r = pendingConfirm; pendingConfirm = null; r(false); }
  setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 280);
}

// Keeps the sheet above the iOS keyboard.
function syncKeyboard() {
  const vv = window.visualViewport, s = $('#sheetRoot .sheet');
  if (!vv || !s) return;
  s.style.bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px';
  s.style.maxHeight = Math.round(vv.height * 0.92) + 'px';
}

function askConfirm({ title, text = '', ok = 'Confirm', danger = false, requireText = null }) {
  return new Promise(resolve => {
    setSheet(
      '<h2>' + esc(title) + '</h2>' +
      (text ? '<p class="muted" style="margin-top:8px">' + esc(text) + '</p>' : '') +
      (requireText ? '<input class="input" id="confirmText" placeholder="Type &quot;' + esc(requireText) + '&quot; to confirm" autocomplete="off" autocapitalize="off" style="margin-top:12px">' : '') +
      '<div class="sheet-actions"><button class="btn ghost" id="cNo">Cancel</button>' +
      '<button class="btn ' + (danger ? 'danger' : '') + '" id="cYes"' + (requireText ? ' disabled' : '') + '>' + esc(ok) + '</button></div>'
    );
    const yes = $('#cYes'), no = $('#cNo'), inp = $('#confirmText');
    if (inp) inp.addEventListener('input', () => { yes.disabled = inp.value.trim().toLowerCase() !== requireText.toLowerCase(); });
    ctx = { type: 'confirm' };
    pendingConfirm = resolve;
    yes.onclick = () => { pendingConfirm = null; closeSheet(); resolve(true); };
    no.onclick = () => closeSheet();
  });
}

let toastTimer = null;
function toast(msg, action) {
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button class="toast-btn" id="toastAct">' + esc(action.label) + '</button>' : '');
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (action) $('#toastAct').onclick = () => { t.classList.remove('show'); action.fn(); };
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

/* ====================================================================
   Rendering
   ==================================================================== */

function render() {
  const y = window.scrollY;
  const u = me();
  if (!u) { showAuth(); return; }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));

  enterNow = ui.enter; ui.enter = false;
  let html;
  if (ui.tab === 'today') html = renderToday();
  else if (ui.tab === 'foods') html = '<div class="page-mid">' + renderFoods() + '</div>';
  else html = '<div class="page-narrow">' + renderProfile() + '</div>';
  const view = $('#view');
  view.innerHTML = html;
  view.classList.remove('enter');
  if (enterNow) { void view.offsetWidth; view.classList.add('enter'); $$('.count', view).forEach(countUp); }
  ui.fresh = null; ui.opened = null;

  const k = viewKey();
  const finished = k === todayKey() && getDay(k).finished;
  $('#fab').classList.toggle('hidden', !(ui.tab === 'today' && !finished));
  window.scrollTo(0, y);
}

/* ---------- Today ---------- */

function barHtml(v, goal, cls) {
  const pct = Math.max(0, Math.min(100, v / goal * 100));
  return '<div class="track"><div class="fill ' + cls + '" style="width:' + pct + '%"></div></div>';
}

function macroRow(k, val) {
  const g = goalOf(k);
  return '<div class="mrow ' + k + '"><div class="top"><span><span class="dot ' + k + '"></span> ' + LABEL[k] + '</span>' +
    '<span class="val">' + fmt(val, 1) + ' g' + (g ? ' <small>/ ' + fmt(g) + '</small>' : '') + '</span></div>' +
    (g ? barHtml(val, g, k) : '') + '</div>';
}

// Progress ring when a calorie goal exists, otherwise the split of calories between P / C / F.
function ringHtml(t, gk) {
  const C = 2 * Math.PI * 52;
  let arcs = '<circle class="ring-bg" cx="60" cy="60" r="52"/>';
  if (gk) {
    const p = Math.min(1, t.kcal / gk);
    if (p > 0) arcs += '<circle class="ring-fg' + (t.kcal > gk ? ' over' : '') + '" cx="60" cy="60" r="52" stroke-dasharray="' + (p * C).toFixed(2) + ' ' + C.toFixed(2) + '" transform="rotate(-90 60 60)"/>';
  } else {
    const e = { protein: 4 * t.protein, carbs: 4 * t.carbs, fat: 9 * t.fat }, sum = e.protein + e.carbs + e.fat;
    if (sum > 0) {
      let off = 0;
      ['protein', 'carbs', 'fat'].forEach(k => {
        const len = e[k] / sum * C;
        if (len > 0.5) arcs += '<circle class="ring-seg ' + k + '" cx="60" cy="60" r="52" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 60 60)"/>';
        off += len;
      });
    }
  }
  return '<div class="ring"><svg viewBox="0 0 120 120" aria-hidden="true">' + arcs + '</svg>' +
    '<div class="ring-center"><strong class="count" data-to="' + t.kcal.toFixed(1) + '" data-dec="0">' + fmt(t.kcal) + '</strong><small>' + (gk ? 'of ' + fmt(gk) + ' kcal' : 'kcal') + '</small></div></div>';
}

function weekStrip(key, tk, gk) {
  const ws = weekStart(key);
  return '<div class="week">' + [0, 1, 2, 3, 4, 5, 6].map(i => {
    const k = addDays(ws, i), t = dayTotals(getDay(k)), has = hasTotals(t);
    const p = gk ? Math.min(100, t.kcal / gk * 100) : (has ? 100 : 0);
    const over = gk && t.kcal > gk;
    return '<button class="wd ' + (k === key ? 'sel ' : '') + (k === tk ? 'tod ' : '') + (over ? 'over' : '') + '" data-act="pick-day" data-key="' + k + '"' + (k > tk ? ' disabled' : '') +
      ' aria-label="' + esc(fmtDay(k, { weekday: 'long', day: 'numeric', month: 'short' })) + '"><small>' + esc(fmtDay(k, { weekday: 'short' })) + '</small><b>' + parseKey(k).getDate() + '</b><i style="--p:' + p.toFixed(0) + '%"></i></button>';
  }).join('') + '</div>';
}

function quickHtml() {
  const u = me();
  const items = u.foods.filter(f => f.lastUsed > 0).map(f => ({ t: 'food', id: f.id, name: f.name, at: f.lastUsed }))
    .concat(u.meals.filter(m => m.lastUsed > 0).map(m => ({ t: 'meal', id: m.id, name: m.name, at: m.lastUsed })))
    .sort((a, b) => b.at - a.at).slice(0, 8);
  if (!items.length) return '';
  return '<div class="quick"><div class="lbl">Quick add</div><div class="qscroll">' +
    items.map(i => '<button class="chip ' + (i.t === 'meal' ? 'meal' : '') + '" data-act="quick-' + i.t + '" data-id="' + i.id + '">' + (i.t === 'meal' ? '🍽 ' : '') + esc(i.name) + '</button>').join('') +
    '</div></div>';
}

/* ---------- is this a good pick for me? ----------
   Compares the share of a food's energy that comes from protein / carbs / fat with the
   share your goals ask for (4 kcal per g protein and carbs, 9 per g fat). Where a macro
   has no goal, a typical 25 / 45 / 30 split is used. It is a rough guide, not advice. */

const DEFAULT_SHARES = { protein: 0.25, carbs: 0.45, fat: 0.30 };
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };
const NAME_OF = { protein: 'protein', carbs: 'carbs', fat: 'fat' };

function targetShares() {
  const g = me().goals, out = Object.assign({}, DEFAULT_SHARES);
  if (g.kcal > 0) ['protein', 'carbs', 'fat'].forEach(k => { if (g[k] > 0) out[k] = Math.min(1, g[k] * KCAL_PER_G[k] / g.kcal); });
  return out;
}

function rateEntry(v, shares) {
  const e = {}, sum = ['protein', 'carbs', 'fat'].reduce((s, k) => { e[k] = KCAL_PER_G[k] * v[k]; return s + e[k]; }, 0);
  if (!(sum > 0)) return null;
  shares = shares || targetShares();
  const out = {};
  ['protein', 'carbs', 'fat'].forEach(k => {
    const share = e[k] / sum, ratio = share / shares[k];
    out[k] = { share, ratio, dir: ratio >= 1.15 ? 'up' : ratio <= 0.75 ? 'down' : 'ok' };
  });
  return out;
}

// Protein: up = green, down = red. Carbs / fat: up = amber, down = blue (more or less than your target, neither is "bad").
function arrowHtml(k, dir) {
  if (dir === 'ok') return '<span class="ar ok" title="About your target mix">≈</span>';
  const cls = k === 'protein' ? (dir === 'up' ? 'good' : 'bad') : (dir === 'up' ? 'high' : 'low');
  return '<span class="ar ' + cls + '" title="' + (dir === 'up' ? 'Above' : 'Below') + ' your target share">' + (dir === 'up' ? '▲' : '▼') + '</span>';
}

// "eye" button: visible = counted, crossed = paused, dashed = some ingredients paused
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.73 5.08A10.75 10.75 0 0 1 21.94 11.65a1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/></svg>';

function eyeBtn(state, act, attr, label) {
  return '<button class="eye ' + state + '" data-act="' + act + '" ' + attr + ' aria-label="' + esc(label) + '" aria-pressed="' + (state !== 'off') + '">' + (state === 'off' ? EYE_OFF : EYE) + '</button>';
}

const LEGEND = '<div class="legend">Arrows compare the mix with your target mix (from your goals; otherwise a typical 25 / 45 / 30 % split).</div>';

// four value tiles + one-line verdict; used for a single food and for a whole meal
function macroTiles(v) {
  const rt = rateEntry(v), g = me().goals;
  const tile = (k, label, valHtml, sub, arrow) =>
    '<div class="dt ' + k + '"><div class="top"><span>' + label + '</span>' + (arrow || '') + '</div><div class="v">' + valHtml + '</div><div class="s">' + sub + '</div></div>';
  const goalPct = k => (g[k] > 0 ? Math.round(v[k] / g[k] * 100) + '% of daily goal' : '');
  const tiles = tile('kcal', 'Calories', fmt(v.kcal) + ' <small>kcal</small>', goalPct('kcal') || '&nbsp;') +
    ['protein', 'carbs', 'fat'].map(k => tile(k, LABEL[k], fmt(v[k], 1) + ' <small>g</small>',
      (rt ? Math.round(rt[k].share * 100) + '% of energy' : '&nbsp;') + (goalPct(k) ? ' · ' + goalPct(k) : ''),
      rt ? arrowHtml(k, rt[k].dir) : '')).join('');
  let verdict = '';
  if (rt) {
    const parts = ['protein', 'carbs', 'fat'].filter(k => rt[k].dir !== 'ok').map(k => (rt[k].dir === 'up' ? 'High in ' : 'Low in ') + NAME_OF[k]);
    verdict = '<div class="verdict">' + (parts.length ? esc(parts.join(' · ')) : 'Close to your target mix') + '</div>';
  }
  return '<div class="dgrid">' + tiles + '</div>' + verdict;
}

function entryDetail(e, opening) {
  const v = entryVals(e);
  return '<div class="detail' + (opening ? ' opening' : '') + '">' + macroTiles(v) +
    '<div class="detail-foot"><span>Per 100 g: ' + fmt(e.per100.kcal) + ' kcal · P ' + fmt(e.per100.protein, 1) + ' · C ' + fmt(e.per100.carbs, 1) + ' · F ' + fmt(e.per100.fat, 1) + '</span>' +
    '<button class="btn small ghost" data-act="edit-entry" data-id="' + e.id + '">Edit amount</button></div>' + LEGEND + '</div>';
}

const isFresh = e => !!(ui.fresh && e.at >= ui.fresh.since);

function entryRow(e, nested) {
  const v = entryVals(e), open = ui.expanded === e.id;
  return '<div class="' + (nested ? 'sub' : 'row') + (e.active ? '' : ' paused') + (!nested && isFresh(e) ? ' fresh' : '') + '">' +
    eyeBtn(e.active ? 'on' : 'off', 'toggle', 'data-id="' + e.id + '"', e.active ? 'Stop counting this' : 'Count this again') +
    '<button class="row-main" data-act="expand-entry" data-id="' + e.id + '" aria-expanded="' + open + '">' +
    '<strong>' + esc(e.name) + '</strong>' +
    '<small class="l1"><b>' + fmt(e.grams, 1) + ' g</b> · ' + fmt(v.kcal) + ' kcal</small>' +
    '<small>' + mlineG(v) + '</small>' +
    (e.active || nested ? '' : '<small class="tag">paused — not counted</small>') +
    '</button>' +
    '<button class="icon-btn" data-act="del-entry" data-id="' + e.id + '" aria-label="Remove">✕</button>' +
    (open ? entryDetail(e, ui.opened === e.id) : '') +
    '</div>';
}

// A meal is collapsed by default; tap it to see the totals of the whole meal and its ingredients.
function groupCard(g) {
  const act = g.items.filter(e => e.active), tot = sumEntries(act), open = ui.expandedGroup === g.group;
  const state = act.length === g.items.length ? 'on' : act.length === 0 ? 'off' : 'part';
  const pausedN = g.items.length - act.length;
  const justOpened = ui.opened === g.group ? ' opening' : '';
  return '<div class="group' + (act.length === 0 ? ' paused' : '') + (g.items.some(isFresh) ? ' fresh' : '') + '"><div class="group-head">' +
    eyeBtn(state, 'toggle-group', 'data-gid="' + g.group + '"', state === 'on' ? 'Pause whole meal' : 'Count whole meal') +
    '<button class="row-main" data-act="expand-group" data-gid="' + g.group + '" aria-expanded="' + open + '"><strong>' + esc(g.name) + '</strong>' +
    '<small class="l1">' + (act.length ? '<b>' + fmt(tot.kcal) + ' kcal</b>' : 'paused — not counted') + ' · ' + g.items.length + ' item' + (g.items.length > 1 ? 's' : '') + '</small>' +
    (act.length ? '<small>' + mlineG(tot) + '</small>' : '') +
    (pausedN && act.length ? '<small class="tag">' + pausedN + ' paused</small>' : '') + '</button>' +
    '<button class="icon-btn" data-act="del-group" data-gid="' + g.group + '" aria-label="Remove whole meal">✕</button></div>' +
    (open
      ? '<div class="detail' + justOpened + '">' + macroTiles(act.length ? tot : sumEntries(g.items)) + LEGEND + '</div>' +
        '<div class="sect">Ingredients</div><div class="group-items' + justOpened + '">' + g.items.map(e => entryRow(e, true)).join('') + '</div>'
      : '') +
    '</div>';
}

function renderToday() {
  const key = viewKey(), tk = todayKey(), isToday = key === tk, day = getDay(key);
  const t = dayTotals(day);
  const pausedList = day.entries.filter(e => !e.active);
  const p = sumEntries(pausedList);
  const gk = goalOf('kcal');
  const left = gk ? gk - t.kcal : 0;
  const label = isToday ? 'Today' : key === addDays(tk, -1) ? 'Yesterday' : fmtDay(key, { weekday: 'long' });
  const sub = fmtDay(key, { day: 'numeric', month: 'long', year: 'numeric' });

  let list;
  if (day.entries.length) {
    list = '<div class="list">' + groupEntries(day.entries).map(g => g.single ? entryRow(g.single, false) : groupCard(g)).join('') + '</div>';
  } else if (day.legacy) {
    list = '<div class="empty">This day was imported from the old version (totals only, no item details).</div>';
  } else if (me().foods.length) {
    list = '<div class="empty"><p>Nothing logged yet.</p><p class="tiny">Tap ＋ to add your first food.</p></div>';
  } else {
    list = '<div class="empty"><p>You have no foods yet.</p><button class="btn" data-act="new-food">Create your first food</button></div>';
  }

  let bottom = '';
  if (isToday) {
    bottom = day.finished
      ? '<div class="done-banner"><span><strong>✓ Day finished.</strong> Reopen it to add more.</span><button class="btn small ghost" data-act="reopen-day">Reopen</button></div>'
      : (day.entries.length ? '<div class="finish-row"><button class="btn ghost block" data-act="finish-day">Finish day</button></div>' : '');
  }

  const summary = '<section class="card total"><div class="sum">' + ringHtml(t, gk) +
    '<div class="macrocol">' + macroRow('protein', t.protein) + macroRow('carbs', t.carbs) + macroRow('fat', t.fat) + '</div></div>' +
    (gk ? '<div class="remainline ' + (left < 0 ? 'over' : '') + '">' + (left >= 0 ? fmt(left) + ' kcal left' : fmt(-left) + ' kcal over') + '</div>' : '') +
    (pausedList.length ? '<div class="hint">Paused: ' + fmt(p.kcal) + ' kcal · If you counted everything: <strong>' + fmt(t.kcal + p.kcal) + ' kcal</strong></div>' : '') +
    '</section>';

  return '<header class="topbar daynav">' +
    '<button class="icon-btn" data-act="day-prev" aria-label="Previous day">‹</button>' +
    '<div class="titles"><h1>' + esc(label) + '</h1><p class="muted tiny">' + esc(sub) + '</p></div>' +
    '<button class="icon-btn" data-act="day-next" aria-label="Next day"' + (isToday ? ' disabled' : '') + '>›</button>' +
    '</header>' +
    weekStrip(key, tk, gk) +
    (isToday ? '' : '<div class="hint">You are editing a past day. <button class="link-btn" data-act="day-today">Back to today</button></div>') +
    '<div class="cols"><div class="col-a">' + summary + quickHtml() + '</div><div class="col-b">' + list + bottom + '</div></div>';
}

/* ---------- Foods & meals ---------- */

function foodInfoLine(f) {
  return fmt(f.kcal) + ' kcal · ' + mline(f) + ' <span>/ 100 g</span>';
}

// mode: 'manage' (Foods tab), 'pick' (add to a day), 'ing' (pick an ingredient for a meal)
function foodRows(q, mode) {
  const u = me(), qq = (q || '').trim().toLowerCase();
  let list = [...u.foods];
  list.sort(mode === 'manage'
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
  if (qq) list = list.filter(f => (f.name + ' ' + (f.desc || '')).toLowerCase().includes(qq));
  if (!list.length) {
    return '<div class="empty">' + (u.foods.length ? 'No matches.' : '<p>No foods yet.</p>') + '</div>';
  }
  return list.map(f => {
    const info = '<strong>' + esc(f.name) + (f.desc ? ' <span class="muted" style="font-weight:400">(' + esc(f.desc) + ')</span>' : '') + '</strong><small>' + foodInfoLine(f) + '</small>';
    if (mode !== 'manage') {
      return '<div class="row"><button class="row-main" data-act="' + (mode === 'ing' ? 'mi-pick' : 'pick-food') + '" data-id="' + f.id + '">' + info + '</button></div>';
    }
    return '<div class="row"><button class="row-main" data-act="edit-food" data-id="' + f.id + '">' + info + '</button>' +
      '<button class="icon-btn add" data-act="pick-food" data-id="' + f.id + '" aria-label="Add ' + esc(f.name) + ' to the day">＋</button></div>';
  }).join('');
}

function mealRows(q, mode) {
  const u = me(), qq = (q || '').trim().toLowerCase();
  let list = [...u.meals];
  list.sort(mode === 'manage'
    ? (a, b) => a.name.localeCompare(b.name)
    : (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name));
  if (qq) list = list.filter(m => m.name.toLowerCase().includes(qq));
  if (!list.length) {
    if (u.meals.length) return '<div class="empty">No matches.</div>';
    return '<div class="empty"><p>No meals yet.</p><p class="tiny">A meal combines foods, e.g. “Toast sandwich” = bread + salami. You can change the grams of each ingredient every time you eat it.</p>' +
      (u.foods.length ? '<button class="btn" data-act="new-meal">Create a meal</button>' : '<p class="tiny">Create some foods first.</p>') + '</div>';
  }
  return list.map(m => {
    const t = mealTotals(m);
    const info = '<strong>' + esc(m.name) + '</strong><small>' + esc(mealSummary(m)) + '</small><small>' + fmt(t.kcal) + ' kcal · ' + mline(t) + '</small>';
    if (mode === 'pick') return '<div class="row"><button class="row-main" data-act="pick-meal" data-id="' + m.id + '">' + info + '</button></div>';
    return '<div class="row"><button class="row-main" data-act="edit-meal" data-id="' + m.id + '">' + info + '</button>' +
      '<button class="icon-btn add" data-act="pick-meal" data-id="' + m.id + '" aria-label="Add ' + esc(m.name) + ' to the day">＋</button></div>';
  }).join('');
}

function renderFoods() {
  const isMeals = ui.foodsTab === 'meals';
  return '<header class="topbar"><div class="titles"><h1>' + (isMeals ? 'Meals' : 'Foods') + '</h1></div><button class="btn small" data-act="new-item">＋ New</button></header>' +
    '<div class="seg" style="margin-bottom:12px"><button class="' + (isMeals ? '' : 'on') + '" data-act="foods-tab" data-t="foods">Foods</button><button class="' + (isMeals ? 'on' : '') + '" data-act="foods-tab" data-t="meals">Meals</button></div>' +
    '<input class="input search" data-input="food-search" placeholder="Search ' + (isMeals ? 'meals' : 'foods') + '" value="' + esc(ui.search) + '" autocomplete="off">' +
    '<div id="foodList" class="list wide2">' + (isMeals ? mealRows(ui.search, 'manage') : foodRows(ui.search, 'manage')) + '</div>' +
    '<p class="note center">' + (isMeals ? 'A meal uses the current values of its foods. Past days never change.' : 'All values are per 100 g. Add a source so you can re-check them later.') + '</p>';
}

/* ---------- Profile ---------- */

function goalSummary() {
  const u = me(), parts = [];
  if (u.goals.kcal > 0) parts.push(fmt(u.goals.kcal) + ' kcal');
  ['protein', 'carbs', 'fat'].forEach(k => { if (u.goals[k] > 0) parts.push(LABEL[k][0] + ' ' + fmt(u.goals[k])); });
  return parts.length ? parts.join(' · ') : 'Off';
}

function listRow(page, title, value) {
  return '<button class="list-row" data-act="goto" data-page="' + page + '"><span>' + title + '</span>' +
    (value ? '<span class="muted">' + esc(value) + '</span>' : '') + '<span class="chev">›</span></button>';
}

function subHeader(title) {
  return '<header class="topbar"><button class="icon-btn" data-act="goto" data-page="home" aria-label="Back">‹</button><div class="titles"><h1>' + title + '</h1></div><span style="width:38px"></span></header>';
}

function renderProfile() {
  const u = me();
  if (ui.profilePage === 'stats') return renderStatsPage();
  if (ui.profilePage === 'goals') return renderGoalsPage();
  if (ui.profilePage === 'backup') return renderBackupPage();
  if (ui.profilePage === 'settings') return renderSettingsPage();
  const last = u.settings.lastExport ? new Date(u.settings.lastExport).toLocaleDateString() : 'never';
  const tp = themePref();
  return '<div class="profile-head"><div class="avatar">' + esc(u.name[0] || '?') + '</div><div><h1>' + esc(u.name) + '</h1><p class="muted">Profile on this device</p></div></div>' +
    '<div class="list-group">' +
    listRow('stats', 'Weekly stats', '') +
    listRow('goals', 'Daily goals', goalSummary()) +
    listRow('backup', 'Backup &amp; restore', 'Last: ' + last) +
    listRow('settings', 'Settings', '') +
    '</div>' +
    '<div class="section-title">Appearance</div>' +
    '<div class="seg">' + [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(x => '<button class="' + (tp === x[0] ? 'on' : '') + '" data-act="theme" data-t="' + x[0] + '">' + x[1] + '</button>').join('') + '</div>' +
    '<div class="list-group" style="margin-top:22px"><button class="list-row danger-text" data-act="logout"><span>Log out</span></button></div>';
}

/* ---------- Weekly stats ---------- */

function renderStatsPage() {
  const u = me(), tk = todayKey(), m = ui.metric, anim = enterNow ? ' anim' : '';
  const ws = addDays(weekStart(tk), ui.weekOffset * 7);
  const keys = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
  const dataKeys = Object.keys(u.days).filter(k => hasTotals(dayTotals(u.days[k]))).sort();
  const canPrev = dataKeys.length > 0 && weekStart(dataKeys[0]) < ws;
  const canNext = ui.weekOffset < 0;

  const rows = keys.map(k => {
    const d = u.days[k], t = dayTotals(d), has = hasTotals(t);
    return { k, t, v: t[m], has, future: k > tk, live: has && k === tk && !(d && d.finished) };
  });
  const goal = goalOf(m);
  const scaleMax = (Math.max(1, ...rows.map(r => r.v), goal || 0)) * 1.2;
  const counted = rows.filter(r => r.has && !r.live);
  const avg = counted.length ? counted.reduce((s, r) => s + r.v, 0) / counted.length : 0;
  const unit = m === 'kcal' ? 'kcal' : 'g';
  const dec = m === 'kcal' ? 0 : 1;
  const hit = r => (goal ? (m === 'protein' ? r.v >= goal * 0.9 : Math.abs(r.v - goal) <= goal * 0.1) : false);
  const hits = counted.filter(hit).length;
  const st = streaks(u, tk);
  const selInWeek = !!(ui.selDay && keys.includes(ui.selDay));

  /* --- hero: weekly average + chart --- */
  let vs = '<span class="muted tiny">No goal set for this value</span>';
  if (goal && counted.length) {
    const diff = avg - goal, near = Math.abs(diff) <= goal * 0.1;
    vs = '<span class="pill ' + (near ? 'ok' : diff > 0 ? 'up' : 'down') + '">' + (near ? '● on goal' : (diff > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(diff), dec) + ' ' + unit + (diff > 0 ? ' above' : ' below') + ' goal') + '</span>';
  } else if (goal) vs = '<span class="muted tiny">Goal: ' + fmt(goal) + ' ' + unit + '</span>';

  const cols = rows.map((r, i) => {
    const over = m === 'kcal' && goal && r.has && r.v > goal * 1.1;
    return '<button class="col ' + (r.k === ui.selDay ? 'sel' : '') + (r.future ? ' future' : '') + '" style="--i:' + i + '" data-act="sel-day" data-key="' + r.k + '"' + (r.future ? ' disabled' : '') + ' aria-label="' + esc(fmtDay(r.k, { weekday: 'long', day: 'numeric', month: 'short' })) + '">' +
      '<span class="val">' + (r.has ? fmt(r.v, 0) : '') + '</span>' +
      '<span class="bar ' + m + (over ? ' over' : '') + (r.live ? ' live' : '') + '" style="height:' + (r.has ? Math.max(2, r.v / scaleMax * 100) : 0) + '%"></span></button>';
  }).join('');
  const labels = rows.map(r =>
    '<span class="' + (r.k === tk ? 'today' : '') + '">' + esc(fmtDay(r.k, { weekday: 'short' })) + '<small>' + parseKey(r.k).getDate() + '</small></span>').join('');

  const hero = '<section class="card hero"><div class="weeknav">' +
    '<button class="icon-btn" data-act="week-prev"' + (canPrev ? '' : ' disabled') + ' aria-label="Previous week">‹</button>' +
    '<strong>' + esc(fmtDay(keys[0], { day: 'numeric', month: 'short' })) + ' – ' + esc(fmtDay(keys[6], { day: 'numeric', month: 'short' })) + '</strong>' +
    '<button class="icon-btn" data-act="week-next"' + (canNext ? '' : ' disabled') + ' aria-label="Next week">›</button></div>' +
    '<div class="hero-label muted tiny">Daily average</div>' +
    '<div class="hero-num"><span class="big">' + (counted.length ? '<span class="count" data-to="' + avg.toFixed(2) + '" data-dec="' + dec + '">' + fmt(avg, dec) + '</span>' : '–') + '</span><span class="unit">' + unit + ' / day</span></div>' +
    '<div style="margin-top:8px">' + vs + '</div>' +
    '<div class="chart' + anim + '"><div class="plot' + (selInWeek ? ' has-sel' : '') + '">' + cols +
    (goal ? '<div class="goal-line" style="bottom:' + (goal / scaleMax * 100) + '%"><span>goal ' + fmt(goal) + '</span></div>' : '') +
    '</div><div class="xlabels">' + labels + '</div></div></section>';

  /* --- tiles --- */
  const best = counted.length ? counted.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const goalHelp = !goal ? 'Set a goal to track this' : m === 'protein' ? 'at least 90% of goal' : 'within ±10% of goal';
  const tiles = '<div class="tiles2">' +
    '<div class="tile2 streak"><div class="lbl">🔥 Streak</div><div class="v">' + st.cur + '<small> day' + (st.cur === 1 ? '' : 's') + '</small></div><div class="s">best ' + st.best + (st.best === 1 ? ' day' : ' days') + '</div></div>' +
    '<div class="tile2 ' + (goal && hits ? 'hit' : '') + '"><div class="lbl">🎯 On target</div><div class="v">' + (goal ? hits + '<small> / ' + counted.length + '</small>' : '–') + '</div><div class="s">' + goalHelp + '</div></div>' +
    '<div class="tile2"><div class="lbl">Days logged</div><div class="v">' + counted.length + '<small> / 7</small></div><div class="s">today counts once it ends</div></div>' +
    '<div class="tile2"><div class="lbl">Highest day</div><div class="v">' + (best ? fmt(best.v, dec) + '<small> ' + unit + '</small>' : '–') + '</div><div class="s">' + (best ? esc(fmtDay(best.k, { weekday: 'long' })) : '&nbsp;') + '</div></div>' +
    '</div>';

  /* --- energy balance (surplus / deficit + weight estimate) --- */
  const maint = goalOf('maint');
  let balance;
  if (!maint) {
    balance = '<section class="card"><h2 style="margin-bottom:6px">Energy balance</h2>' +
      '<p class="muted" style="margin-bottom:12px">Add your maintenance calories (what you burn per day) to see your weekly surplus or deficit and an estimated weight change.</p>' +
      '<button class="btn small" data-act="goto" data-page="goals">Set maintenance calories</button></section>';
  } else {
    const wb = weekBalance(rows, maint);
    const neg = wb.total < 0, flat = wb.n > 0 && Math.abs(wb.avg) < 100;
    // same kcal scale above and below the zero line; the two halves share the plot height in proportion
    const diffs = rows.map(r => (r.has ? r.t.kcal - maint : 0));
    const maxPos = Math.max(150, ...diffs), maxNeg = Math.max(150, ...diffs.map(x => -x));
    const upShare = maxPos / (maxPos + maxNeg) * 100;
    const dcols = rows.map((r, i) => {
      const d = diffs[i];
      return '<div class="dv' + (r.live ? ' live' : '') + (r.future ? ' future' : '') + '" style="--i:' + i + '">' +
        '<div class="dv-up" style="height:' + upShare.toFixed(1) + '%">' + (d > 0 ? '<span class="dv-bar pos" style="height:' + (d / maxPos * 100).toFixed(1) + '%"></span>' : '') + '</div>' +
        '<div class="dv-dn" style="height:' + (100 - upShare).toFixed(1) + '%">' + (d < 0 ? '<span class="dv-bar neg" style="height:' + (-d / maxNeg * 100).toFixed(1) + '%"></span>' : '') + '</div></div>';
    }).join('');
    const dlabels = rows.map(r => '<span class="' + (r.k === tk ? 'today' : '') + '">' + esc(fmtDay(r.k, { weekday: 'short' })) + '<small>' + (r.has ? (r.t.kcal - maint > 0 ? '+' : '−') + fmt(Math.abs(r.t.kcal - maint)) : '–') + '</small></span>').join('');
    const low = counted.some(r => r.t.kcal < 800);
    balance = '<section class="card"><div class="bal-head"><h2>Energy balance</h2>' +
      (wb.n ? '<span class="pill ' + (flat ? 'ok' : neg ? 'down' : 'up') + '">' + (flat ? 'Around maintenance' : neg ? 'Deficit' : 'Surplus') + '</span>' : '') + '</div>' +
      (wb.n
        ? '<div class="bal-big ' + (flat ? '' : neg ? 'neg' : 'pos') + '"><span class="big">' + (neg ? '−' : '+') + '<span class="count" data-to="' + Math.abs(wb.total).toFixed(0) + '" data-dec="0">' + fmt(Math.abs(wb.total)) + '</span></span><small>kcal this week</small></div>' +
          '<div class="kg">≈ <span class="count" data-to="' + Math.abs(wb.kg).toFixed(2) + '" data-dec="2">' + fmt(Math.abs(wb.kg), 2) + '</span> kg ' + (flat ? 'change' : neg ? 'lost' : 'gained') + ' <span class="muted tiny">(estimate)</span></div>' +
          '<div class="muted tiny" style="margin-top:2px">' + (wb.avg < 0 ? '−' : '+') + fmt(Math.abs(wb.avg)) + ' kcal/day on average vs maintenance (' + fmt(maint) + ') · ' + wb.n + ' day' + (wb.n > 1 ? 's' : '') + ' counted</div>'
        : '<p class="muted">Nothing to compare yet this week.</p>') +
      '<div class="dvplot' + anim + '">' + dcols + '</div><div class="xlabels">' + dlabels + '</div>' +
      '<p class="note" style="margin-top:12px">Estimate: about 7 700 kcal ≈ 1 kg of body weight. Water, muscle and missed logging are not included — read it as a trend, not a measurement.' +
      (low ? ' Some days are very low; if you forgot to log, the estimate will be too low.' : '') + '</p></section>';
  }

  /* --- selected day --- */
  let detail = '<p class="note center">Tap a bar for details. Today is left out of the average until the day ends.</p>';
  if (selInWeek) {
    const r = rows.find(x => x.k === ui.selDay);
    detail = '<div class="card' + (ui.opened === r.k ? ' opening' : '') + '"><div class="detail-head"><strong>' + esc(fmtDay(r.k, { weekday: 'long', day: 'numeric', month: 'short' })) + '</strong>' +
      '<button class="btn small ghost" data-act="open-day" data-key="' + r.k + '">Open day</button></div>' +
      (r.has
        ? '<div class="detail-grid">' + MACROS.map(k => '<div><small>' + LABEL[k] + '</small><strong>' + fmt(r.t[k], k === 'kcal' ? 0 : 1) + '</strong></div>').join('') + '</div>'
        : '<p class="muted">Nothing counted on this day.</p>') + '</div>';
  }

  return subHeader('Weekly stats') +
    '<div class="seg" style="margin-bottom:14px">' + MACROS.map(k => '<button class="' + (m === k ? 'on' : '') + '" data-act="metric" data-m="' + k + '">' + (k === 'kcal' ? 'kcal' : LABEL[k]) + '</button>').join('') + '</div>' +
    hero + detail + tiles + balance +
    (goal ? '<p class="note">The dashed line uses your current goal.</p>' : '');
}

/* ---------- Goals ---------- */

function renderGoalsPage() {
  const g = me().goals;
  const f = (k, label, ph) => '<label class="field"><span>' + label + '</span><input class="input" name="' + k + '" inputmode="decimal" placeholder="' + ph + '" value="' + (g[k] > 0 ? g[k] : '') + '" data-input="goals-form" autocomplete="off"></label>';
  return subHeader('Daily goals') +
    '<form data-form="goals" class="card">' +
    '<p class="muted" style="margin-bottom:14px">All optional. Leave a field empty to switch that goal off.</p>' +
    f('kcal', 'Calories goal (kcal)', 'e.g. 2200') +
    '<div class="grid2">' + f('protein', 'Protein (g)', 'e.g. 150') + f('carbs', 'Carbs (g)', 'e.g. 250') + '</div>' +
    f('fat', 'Fat (g)', 'e.g. 70') +
    '<div id="goalHint" class="hint hidden"></div>' +
    '<div class="divider"></div>' +
    f('maint', 'Maintenance calories (kcal you burn per day)', 'e.g. 2600') +
    '<p class="muted tiny" style="margin:-4px 0 12px">Used for the surplus / deficit and the weight estimate in Weekly stats. A web search for “TDEE calculator” gives a starting point; adjust it after a few weeks of real results.</p>' +
    '<div id="goalPlan" class="hint hidden"></div>' +
    '<p class="error" id="goalErr"></p>' +
    '<button class="btn block">Save goals</button></form>' +
    '<p class="note">Changing goals only changes what you see from now on — logged food is never touched.</p>';
}

function updateGoalHint() {
  const form = $('form[data-form="goals"]'), hint = $('#goalHint'), plan = $('#goalPlan');
  if (!form || !hint) return;
  const k = num(form.kcal.value), p = num(form.protein.value), c = num(form.carbs.value), fa = num(form.fat.value), mt = num(form.maint.value);
  let shown = false;
  if ([k, p, c, fa].every(Number.isFinite) && k > 0) {
    const est = 4 * p + 4 * c + 9 * fa;
    if (Math.abs(est - k) > Math.max(60, k * 0.1)) {
      hint.innerHTML = 'Your macro goals add up to ≈ <strong>' + fmt(est) + ' kcal</strong>, but your calorie goal is ' + fmt(k) + '. That is fine if it is intentional.';
      shown = true;
    }
  }
  hint.classList.toggle('hidden', !shown);
  if (plan) {
    if (Number.isFinite(k) && k > 0 && Number.isFinite(mt) && mt > 0) {
      const d = k - mt, kgWeek = Math.abs(d) * 7 / KCAL_PER_KG;
      plan.innerHTML = Math.abs(d) < 50
        ? 'Your calorie goal is about your maintenance — weight should stay roughly stable.'
        : 'Your goal is <strong>' + fmt(Math.abs(d)) + ' kcal/day ' + (d < 0 ? 'below' : 'above') + '</strong> maintenance → about <strong>' + kgWeek.toFixed(2) + ' kg per week</strong> ' + (d < 0 ? 'lost' : 'gained') + ' (rough estimate).';
      plan.classList.remove('hidden');
    } else plan.classList.add('hidden');
  }
}

/* ---------- Backup ---------- */

function renderBackupPage() {
  const u = me();
  const last = u.settings.lastExport ? new Date(u.settings.lastExport).toLocaleString() : 'never';
  return subHeader('Backup &amp; restore') +
    '<section class="card"><p>Your data is stored <strong>only in this browser</strong>. If the browser data is cleared, or the Home Screen app is removed, it is gone — so export a backup now and then.</p>' +
    '<p class="muted tiny" style="margin:10px 0 16px">Last backup: ' + esc(last) + '</p>' +
    '<button class="btn block" data-act="export">Export backup</button></section>' +
    '<section class="card"><p style="margin-bottom:12px">Restore from a backup file. This <strong>replaces</strong> all foods, meals and days of this profile.</p>' +
    '<input type="file" id="importFile" accept="application/json,.json" data-input="import-file" class="hidden">' +
    '<button class="btn ghost block" data-act="import">Choose backup file…</button></section>' +
    '<p class="note">iPhone: the app on your Home Screen has its own storage, separate from Safari. Create your profile inside the Home Screen app (or restore a backup there).</p>';
}

/* ---------- Settings ---------- */

function renderSettingsPage() {
  const u = me();
  const opts = [0, 1, 2, 3, 4, 5, 6].map(h => '<option value="' + h + '"' + (h === rollover() ? ' selected' : '') + '>' + pad(h) + ':00</option>').join('');
  return subHeader('Settings') +
    '<section class="card"><label class="field"><span>A new day starts at</span><select class="input" data-input="rollover">' + opts + '</select></label>' +
    '<p class="muted tiny">Food you log between midnight and this time still counts for the previous day (late-night snacks).</p></section>' +
    '<section class="card"><label class="field"><span>USDA API key (optional)</span><input class="input" data-input="usda-key" value="' + esc(u.settings.usdaKey || '') + '" placeholder="DEMO_KEY is used if empty" autocomplete="off" autocapitalize="off"></label>' +
    '<p class="muted tiny">Used by “Look up values” when adding a food. Without your own key a shared demo key with a small daily limit is used. A free key takes a minute: fdc.nal.usda.gov/api-key-signup</p></section>' +
    '<section class="card"><h2 style="margin-bottom:12px">Change password</h2>' +
    '<form data-form="password" autocomplete="off">' +
    '<input class="input" type="password" name="old" placeholder="Current password" autocomplete="current-password" style="margin-bottom:10px">' +
    '<input class="input" type="password" name="new" placeholder="New password (min. 4 characters)" autocomplete="new-password" style="margin-bottom:10px">' +
    '<p class="error" id="pwErr"></p><button class="btn ghost block">Update password</button></form></section>' +
    '<section class="card"><h2 style="margin-bottom:6px">Delete profile</h2><p class="muted tiny" style="margin-bottom:12px">Removes ' + esc(u.name) + ' and all its foods and history from this device.</p>' +
    '<button class="btn danger block" data-act="delete-profile">Delete profile…</button></section>';
}

/* ---------- Auth ---------- */

function showAuth() {
  $('#app').classList.add('hidden');
  const el = $('#auth');
  el.classList.remove('hidden');
  const names = Object.values(db.users).map(u => u.name);
  if (!names.length) ui.authMode = 'register';
  const reg = ui.authMode === 'register';
  el.innerHTML =
    '<div class="auth-card">' +
    '<img class="logo" src="icon-192.png" alt="">' +
    '<div><h1>Meal Tracker</h1><p class="muted">Your foods. Your numbers.</p></div>' +
    (names.length ? '<div class="seg"><button class="' + (reg ? '' : 'on') + '" data-act="auth-mode" data-mode="login">Log in</button><button class="' + (reg ? 'on' : '') + '" data-act="auth-mode" data-mode="register">New profile</button></div>' : '') +
    '<form data-form="auth" autocomplete="on">' +
    '<input class="input" name="username" placeholder="Username" autocomplete="username" autocapitalize="off" autocorrect="off">' +
    '<input class="input" type="password" name="password" placeholder="Password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '">' +
    (reg ? '<input class="input" type="password" name="password2" placeholder="Repeat password" autocomplete="new-password">' : '') +
    '<p class="error" id="authError"></p>' +
    '<button class="btn block">' + (reg ? 'Create profile' : 'Log in') + '</button></form>' +
    (!reg && names.length ? '<div class="chips profiles">' + names.map(n => '<button class="chip" data-act="fill-user" data-name="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div>' : '') +
    '<p class="muted tiny">Profiles only exist on this device. The password just separates profiles; it does not encrypt your data.</p>' +
    '</div>';
}

/* ====================================================================
   Sheets: picker, amount, food form, meal form, meal amount
   ==================================================================== */

function renderPicker() {
  const t = ctx.pickTab, isMeals = t === 'meals';
  setSheet(
    '<div class="sheet-head"><h2>Add to day</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    '<div class="seg" style="margin-bottom:12px"><button class="' + (isMeals ? '' : 'on') + '" data-act="pick-tab" data-t="foods">Foods</button><button class="' + (isMeals ? 'on' : '') + '" data-act="pick-tab" data-t="meals">Meals</button></div>' +
    '<input class="input" data-input="pick-search" placeholder="Search ' + (isMeals ? 'meals' : 'foods') + '" autocomplete="off" style="margin-bottom:12px">' +
    '<div id="pickList" class="list">' + (isMeals ? mealRows('', 'pick') : foodRows('', 'pick')) + '</div>' +
    '<button class="btn ghost block" data-act="' + (isMeals ? 'new-meal' : 'new-food') + '" style="margin-top:14px">＋ New ' + (isMeals ? 'meal' : 'food') + '</button>'
  );
}

function openPicker() {
  ctx = { type: 'picker', pickTab: 'foods' };
  renderPicker();
}

function targetLabel(key) {
  const tk = todayKey();
  return key === tk ? 'Today' : key === addDays(tk, -1) ? 'Yesterday' : fmtDay(key, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Shared "what would the day look like" preview
function previewHtml(add, others, paused) {
  const after = others.kcal + add.kcal, gk = goalOf('kcal');
  return '<div class="pv-main"><strong>+' + fmt(add.kcal) + ' kcal</strong><span>' + mline(add) + '</span></div>' +
    '<div class="pv-total">Day total: ' + fmt(others.kcal) + ' → <strong>' + fmt(after) + ' kcal</strong></div>' +
    (gk ? '<div class="pv-goal ' + (after > gk ? 'over' : '') + '">' + (after <= gk ? fmt(gk - after) + ' left of ' + fmt(gk) : fmt(after - gk) + ' over ' + fmt(gk)) + '</div>' : '') +
    (paused ? '<div class="pv-note">Paused — this will not count until you switch it on.</div>' : '');
}

function dayOthers(key, excludeId) {
  const day = getDay(key);
  return day.legacy && !day.entries.length
    ? dayTotals(day)
    : sumEntries(day.entries.filter(e => e.active && e.id !== excludeId));
}

function openAmount(opts) {
  const u = me(), key = opts.key;
  let per, name, portion, grams;
  if (opts.mode === 'edit') {
    const e = opts.entry, f = u.foods.find(x => x.id === e.foodId);
    per = e.per100; name = e.name; portion = f ? f.portion : null; grams = e.grams;
  } else {
    const f = opts.food;
    per = { kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat };
    name = f.name; portion = f.portion; grams = f.lastGrams || (f.portion && f.portion.grams) || 100;
  }
  ctx = Object.assign({ type: 'amount', per }, opts);

  const chips = [];
  if (portion) [1, 2, 3].forEach(n => chips.push('<button type="button" class="chip" data-act="chip" data-g="' + n * portion.grams + '">' + n + ' ' + esc(portion.name) + '</button>'));
  [50, 100, 150, 200, 300].forEach(g => chips.push('<button type="button" class="chip" data-act="chip" data-g="' + g + '">' + g + ' g</button>'));

  setSheet(
    '<form data-form="amount" autocomplete="off">' +
    '<div class="sheet-head"><h2>' + esc(name) + '</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    '<p class="muted tiny">' + (opts.mode === 'edit' ? 'Editing on ' : 'Adding to ') + '<strong>' + esc(targetLabel(key)) + '</strong> · ' + foodInfoLine(per).replace(/<[^>]+>/g, '') + '</p>' +
    '<div class="amount"><input class="input" id="gramsInput" data-input="grams-text" inputmode="decimal" value="' + esc(String(grams)) + '" aria-label="Grams"><span>g</span></div>' +
    '<input type="range" id="gramsRange" data-input="grams-range" min="0" max="500" step="5" value="' + Math.min(500, grams) + '" aria-label="Grams slider">' +
    '<div class="chips">' + chips.join('') + '</div>' +
    '<div class="preview" id="preview"></div>' +
    (opts.mode === 'add' ? '<label class="switch-row"><input type="checkbox" id="whatIf" data-input="whatif"> Add as paused — just to see what the day would look like</label>' : '') +
    '<div class="sheet-actions">' +
    (opts.mode === 'edit' ? '<button type="button" class="btn ghost" data-act="amount-remove">Remove</button>' : '') +
    '<button class="btn" id="amountSave">' + (opts.mode === 'edit' ? 'Save' : 'Add') + '</button></div></form>'
  );
  updatePreview();
}

function updatePreview() {
  if (!ctx || ctx.type !== 'amount') return;
  const input = $('#gramsInput'), btn = $('#amountSave'), box = $('#preview');
  if (!input || !btn || !box) return;
  const g = num(input.value);
  if (!(g > 0 && g <= 10000)) {
    box.innerHTML = '<span class="muted">Enter an amount between 0 and 10 000 g.</span>';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const f = g / 100, per = ctx.per, add = {};
  MACROS.forEach(k => { add[k] = per[k] * f; });
  const paused = ctx.mode === 'edit' ? !ctx.entry.active : !!($('#whatIf') && $('#whatIf').checked);
  box.innerHTML = previewHtml(add, dayOthers(ctx.key, ctx.entry && ctx.entry.id), paused);
}

function setGrams(g) {
  $('#gramsInput').value = String(g);
  $('#gramsRange').value = Math.min(500, g);
  updatePreview();
}

/* ---------- Food form (+ look up) ---------- */

function foodDraft(f) {
  const s = x => (x === null || x === undefined ? '' : String(x));
  return {
    name: s(f && f.name), desc: s(f && f.desc),
    kcal: s(f && f.kcal), protein: s(f && f.protein), carbs: s(f && f.carbs), fat: s(f && f.fat),
    portionName: s(f && f.portion && f.portion.name), portionGrams: s(f && f.portion && f.portion.grams),
    source: s(f && f.source)
  };
}

function readFoodDraft(form) {
  const d = {};
  ['name', 'desc', 'kcal', 'protein', 'carbs', 'fat', 'portionName', 'portionGrams', 'source'].forEach(n => { d[n] = form[n].value; });
  return d;
}

function openFoodForm(id, opts = {}) {
  const f = id ? foodById(id) : null;
  ctx = { type: 'food', id: id || null, thenAdd: !!opts.thenAdd, view: 'form', draft: foodDraft(f), note: '' };
  renderFoodSheet();
}

function renderFoodSheet() {
  if (ctx.view === 'lookup') return renderLookup();
  const d = ctx.draft, f = ctx.id ? foodById(ctx.id) : null;
  const v = x => esc(String(x ?? ''));
  const nf = (name, label) => '<label class="field"><span>' + label + '</span><input class="input" name="' + name + '" inputmode="decimal" value="' + v(d[name]) + '" data-input="food-form" autocomplete="off"></label>';
  setSheet(
    '<form data-form="food" novalidate autocomplete="off">' +
    '<div class="sheet-head"><h2>' + (f ? 'Edit food' : 'New food') + '</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    (ctx.note ? '<div class="hint">' + esc(ctx.note) + '</div>' : '') +
    '<label class="field"><span>Name</span><input class="input" name="name" maxlength="60" value="' + v(d.name) + '" placeholder="e.g. Chicken breast"></label>' +
    '<button type="button" class="btn small ghost" data-act="lookup" style="margin:-4px 0 12px">🔍 Look up values by name</button>' +
    '<label class="field"><span>Description (optional)</span><input class="input" name="desc" maxlength="100" value="' + v(d.desc) + '" placeholder="e.g. raw, cooked, brand"></label>' +
    '<div class="grid2">' + nf('kcal', 'Calories / 100 g') + nf('protein', 'Protein g / 100 g') + nf('carbs', 'Carbs g / 100 g') + nf('fat', 'Fat g / 100 g') + '</div>' +
    '<div id="foodHint" class="hint hidden"></div>' +
    '<div class="grid2"><label class="field"><span>Unit name (optional)</span><input class="input" name="portionName" maxlength="30" value="' + v(d.portionName) + '" placeholder="e.g. egg, slice"></label>' +
    '<label class="field"><span>1 unit weighs (g)</span><input class="input" name="portionGrams" inputmode="decimal" value="' + v(d.portionGrams) + '" placeholder="e.g. 50"></label></div>' +
    '<p class="muted tiny" style="margin:-4px 0 12px">Optional shortcut: with “egg” and 50 g you get quick buttons “1 egg, 2 egg, 3 egg” when adding this food, so you do not need to weigh it.</p>' +
    '<label class="field"><span>Source (optional)</span><input class="input" name="source" maxlength="200" value="' + v(d.source) + '" placeholder="Link or note, e.g. USDA, package label"></label>' +
    (/^https?:\/\//i.test(d.source || '') ? '<p style="margin:-4px 0 12px"><a class="src" href="' + esc(d.source) + '" target="_blank" rel="noopener noreferrer">Open source ↗</a></p>' : '') +
    (f ? '<p class="muted tiny">Changing values does not change entries you already logged. Meals that use this food will use the new values from now on.</p>' : '') +
    '<p class="error" id="foodErr"></p>' +
    '<div class="sheet-actions">' + (f ? '<button type="button" class="btn ghost danger-text" data-act="delete-food">Delete</button>' : '') + '<button class="btn">Save</button></div></form>'
  );
  updateFoodHint();
}

function updateFoodHint() {
  const form = $('form[data-form="food"]'), hint = $('#foodHint');
  if (!form || !hint) return;
  const kEmpty = form.kcal.value.trim() === '';
  const k = num(form.kcal.value), p = num(form.protein.value) || 0, c = num(form.carbs.value) || 0, fa = num(form.fat.value) || 0;
  const est = Math.round(4 * p + 4 * c + 9 * fa);
  hint.classList.remove('bad');
  if (p + c + fa > 100.5) {
    hint.innerHTML = 'Protein + carbs + fat is more than 100 g — that is not possible per 100 g. Check the numbers.';
    hint.classList.add('bad');
  } else if (est > 0 && kEmpty) {
    hint.innerHTML = 'Macros add up to ≈ <strong>' + est + ' kcal</strong>. <button type="button" class="link-btn" data-act="use-calc" data-v="' + est + '">Use ' + est + ' kcal</button>';
  } else if (est > 0 && Number.isFinite(k) && Math.abs(k - est) > Math.max(25, est * 0.15)) {
    hint.innerHTML = 'Heads up: macros add up to ≈ <strong>' + est + ' kcal</strong> but you entered ' + fmt(k) + '. Fiber, alcohol or a typo can cause that — double-check your source. <button type="button" class="link-btn" data-act="use-calc" data-v="' + est + '">Use ' + est + '</button>';
    hint.classList.add('bad');
  } else {
    hint.classList.add('hidden');
    return;
  }
  hint.classList.remove('hidden');
}

function validateFood(form, selfId) {
  const u = me(), name = form.name.value.trim();
  if (!name) return { error: 'Give the food a name.' };
  if (u.foods.some(f => f.id !== selfId && f.name.trim().toLowerCase() === name.toLowerCase())) return { error: 'You already have a food with this name. Add a detail, e.g. "Rice (cooked)".' };
  const vals = {};
  for (const k of MACROS) {
    const raw = form[k].value.trim();
    const n = raw === '' ? (k === 'kcal' ? NaN : 0) : num(raw);
    if (!Number.isFinite(n)) return { error: k === 'kcal' ? 'Enter the calories per 100 g.' : 'Check the ' + LABEL[k].toLowerCase() + ' value.' };
    if (n < 0) return { error: 'Values cannot be negative.' };
    vals[k] = n;
  }
  if (vals.protein + vals.carbs + vals.fat > 100.5) return { error: 'Protein + carbs + fat cannot be more than 100 g per 100 g.' };
  if (vals.kcal > 900) return { error: 'More than 900 kcal per 100 g is not possible. Check the number.' };
  const pn = form.portionName.value.trim(), pgRaw = form.portionGrams.value.trim();
  let portion = null;
  if (pn || pgRaw) {
    const pg = num(pgRaw);
    if (!pn || !(pg > 0 && pg <= 5000)) return { error: 'A unit needs both a name and a weight in grams.' };
    portion = { name: pn, grams: pg };
  }
  return { ok: true, data: Object.assign({ name, desc: form.desc.value.trim(), portion, source: form.source.value.trim() }, vals) };
}

function renderLookup() {
  const L = ctx.lookup;
  setSheet(
    '<div class="sheet-head"><button type="button" class="icon-btn" data-act="lookup-back" aria-label="Back">‹</button><h2>Look up values</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    '<form data-form="lookup" class="lookup-bar"><input class="input" name="q" value="' + esc(L.q) + '" placeholder="e.g. chicken breast raw" autocomplete="off"><button class="btn">Search</button></form>' +
    '<p class="muted tiny" style="margin-bottom:10px">Searches USDA FoodData Central (English names) and Open Food Facts (packaged products, also Croatian). These are suggestions from public databases — compare them with your own source before saving.</p>' +
    '<div id="lookupRes" class="list"></div>'
  );
  renderLookupResults();
}

function renderLookupResults() {
  const L = ctx && ctx.lookup, box = $('#lookupRes');
  if (!L || !box) return;
  if (L.loading) { box.innerHTML = '<div class="empty">Searching…</div>'; return; }
  if (!L.results) { box.innerHTML = ''; return; }
  let h = L.results.map((r, i) =>
    '<div class="row"><button class="row-main" data-act="lookup-pick" data-i="' + i + '"><strong>' + esc(r.name) +
    (r.desc ? ' <span class="muted" style="font-weight:400">(' + esc(r.desc) + ')</span>' : '') + '</strong>' +
    '<small>' + fmt(r.kcal) + ' kcal · ' + mline(r) + ' / 100 g</small><small class="src">' + esc(r.source) + '</small></button></div>').join('');
  if (!L.results.length) h = '<div class="empty">No results' + (L.errors.length ? '.' : '. Try another spelling or an English name.') + '</div>';
  if (L.errors.length) h += '<p class="note">' + L.errors.map(esc).join(' · ') + '</p>';
  box.innerHTML = h;
}

async function runLookup(q) {
  const L = ctx && ctx.lookup;
  if (!L) return;
  const token = ++L.token;
  L.q = q; L.loading = true; L.results = null; L.errors = [];
  renderLookupResults();
  const [a, b] = await Promise.allSettled([searchUSDA(q), searchOFF(q)]);
  if (!ctx || ctx.lookup !== L || L.token !== token) return; // sheet closed or a newer search started
  const res = [];
  if (a.status === 'fulfilled') res.push(...a.value); else L.errors.push('USDA ' + whyFailed(a.reason));
  if (b.status === 'fulfilled') res.push(...b.value); else L.errors.push('Open Food Facts ' + whyFailed(b.reason));
  L.loading = false; L.results = res;
  renderLookupResults();
}

/* ---------- Meal form (create / edit a meal) ---------- */

// Slider for one ingredient. It goes to 500 g, or further when the amount is already larger.
function ingRange(kind, i, grams, name) {
  const g = Number.isFinite(grams) && grams > 0 ? grams : 0;
  const max = Math.max(500, Math.ceil(g / 100) * 100);
  return '<input type="range" class="ing-range" data-input="' + kind + '" data-i="' + i + '" min="0" max="' + max + '" step="5" value="' + Math.min(max, g) + '" aria-label="' + esc(name) + ' grams slider">';
}

// keep the text field and the slider of one ingredient in sync
function syncIng(textKind, rangeKind, i, fromRange, value) {
  const txt = $('input[data-input="' + textKind + '"][data-i="' + i + '"]'), rng = $('input[data-input="' + rangeKind + '"][data-i="' + i + '"]');
  if (fromRange) { if (txt) txt.value = String(value); }
  else if (rng && Number.isFinite(value) && value >= 0) rng.value = Math.min(+rng.max, value);
}

function openMealForm(id, opts = {}) {
  const m = id ? me().meals.find(x => x.id === id) : null;
  ctx = {
    type: 'meal', id: id || null, thenAdd: !!opts.thenAdd, view: 'edit',
    draft: { name: m ? m.name : '', items: m ? m.items.map(i => ({ foodId: i.foodId, grams: i.grams })) : [] }
  };
  renderMealForm();
}

function renderMealForm() {
  const d = ctx.draft, u = me();
  if (ctx.view === 'pick') {
    setSheet(
      '<div class="sheet-head"><button type="button" class="icon-btn" data-act="mi-back" aria-label="Back">‹</button><h2>Add ingredient</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
      '<input class="input" data-input="pick-search" placeholder="Search foods" autocomplete="off" style="margin-bottom:12px">' +
      '<div id="pickList" class="list">' + foodRows('', 'ing') + '</div>'
    );
    return;
  }
  const rows = d.items.map((it, i) => {
    const f = foodById(it.foodId);
    if (!f) return '';
    return '<div class="ing2"><div class="ing"><div class="ing-name"><strong>' + esc(f.name) + '</strong><small id="ik' + i + '"></small></div>' +
      '<div class="ing-g"><input class="input" inputmode="decimal" data-input="mi-grams" data-i="' + i + '" value="' + (Number.isFinite(it.grams) ? esc(String(it.grams)) : '') + '" aria-label="Grams of ' + esc(f.name) + '"></div>' +
      '<button type="button" class="icon-btn" data-act="mi-del" data-i="' + i + '" aria-label="Remove ingredient">✕</button></div>' +
      ingRange('mi-range', i, it.grams, f.name) + '</div>';
  }).join('');
  setSheet(
    '<form data-form="meal" novalidate autocomplete="off">' +
    '<div class="sheet-head"><h2>' + (ctx.id ? 'Edit meal' : 'New meal') + '</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    '<label class="field"><span>Meal name</span><input class="input" name="name" maxlength="60" data-input="meal-name" value="' + esc(d.name) + '" placeholder="e.g. Toast sandwich"></label>' +
    '<div class="section-title" style="margin-top:6px">Ingredients (default grams)</div>' +
    (rows || (u.foods.length ? '<p class="muted tiny" style="margin-bottom:10px">No ingredients yet. Add foods from your list, e.g. bread and salami.</p>' : '<p class="muted tiny" style="margin-bottom:10px">You need foods first: create them in the Foods tab, then build the meal.</p>')) +
    (u.foods.length ? '<button type="button" class="btn ghost block" data-act="mi-add">＋ Add ingredient</button>' : '') +
    '<div class="preview" id="mealTotal"></div>' +
    '<p class="muted tiny" style="margin-top:10px">You can change the grams of every ingredient each time you add the meal to a day.</p>' +
    '<p class="error" id="mealErr"></p>' +
    '<div class="sheet-actions">' + (ctx.id ? '<button type="button" class="btn ghost danger-text" data-act="delete-meal">Delete</button>' : '') + '<button class="btn">Save meal</button></div></form>'
  );
  updateMealForm();
}

function updateMealForm() {
  if (!ctx || ctx.type !== 'meal') return;
  const d = ctx.draft, t = zero();
  d.items.forEach((it, i) => {
    const f = foodById(it.foodId);
    if (!f) return;
    const k = (Number.isFinite(it.grams) && it.grams > 0 ? it.grams : 0) / 100;
    MACROS.forEach(m => { t[m] += f[m] * k; });
    const el = $('#ik' + i);
    if (el) el.textContent = fmt(f.kcal * k) + ' kcal';
  });
  const box = $('#mealTotal');
  if (box) box.innerHTML = d.items.length
    ? '<div class="pv-main"><strong>' + fmt(t.kcal) + ' kcal</strong><span>' + mline(t) + '</span></div>'
    : '<span class="muted">Add ingredients to see the total.</span>';
}

/* ---------- Add a meal to a day (grams editable per ingredient) ---------- */

function openMealAmount(meal, key) {
  ctx = { type: 'mealadd', meal, key, grams: meal.items.map(i => i.grams) };
  const rows = meal.items.map((it, i) => {
    const f = foodById(it.foodId);
    if (!f) return '';
    return '<div class="ing2"><div class="ing"><div class="ing-name"><strong>' + esc(f.name) + '</strong><small id="ak' + i + '"></small></div>' +
      '<div class="ing-g"><input class="input" inputmode="decimal" data-input="ma-grams" data-i="' + i + '" value="' + esc(String(it.grams)) + '" aria-label="Grams of ' + esc(f.name) + '"></div></div>' +
      ingRange('ma-range', i, it.grams, f.name) + '</div>';
  }).join('');
  setSheet(
    '<form data-form="mealadd" autocomplete="off">' +
    '<div class="sheet-head"><h2>' + esc(meal.name) + '</h2><button type="button" class="icon-btn" data-act="close-sheet" aria-label="Close">✕</button></div>' +
    '<p class="muted tiny" style="margin-bottom:12px">Adding to <strong>' + esc(targetLabel(key)) + '</strong> · change the grams for this time. Use 0 to leave an ingredient out.</p>' +
    rows +
    '<div class="preview" id="preview"></div>' +
    '<label class="switch-row"><input type="checkbox" id="whatIf" data-input="ma-opt"> Add as paused — just to see what the day would look like</label>' +
    '<label class="switch-row"><input type="checkbox" id="remember"> Save these amounts as the new default for this meal</label>' +
    '<div class="sheet-actions"><button class="btn" id="amountSave">Add meal</button></div></form>'
  );
  updateMealAdd();
}

function updateMealAdd() {
  if (!ctx || ctx.type !== 'mealadd') return;
  const meal = ctx.meal, gr = ctx.grams, btn = $('#amountSave'), box = $('#preview');
  if (!btn || !box) return;
  meal.items.forEach((it, i) => {
    const f = foodById(it.foodId), el = $('#ak' + i);
    if (f && el) el.textContent = fmt(f.kcal * (gr[i] > 0 ? gr[i] : 0) / 100) + ' kcal';
  });
  const valid = gr.every(g => Number.isFinite(g) && g >= 0 && g <= 10000) && gr.some(g => g > 0);
  btn.disabled = !valid;
  if (!valid) { box.innerHTML = '<span class="muted">Enter an amount for at least one ingredient (0–10 000 g).</span>'; return; }
  const paused = !!($('#whatIf') && $('#whatIf').checked);
  box.innerHTML = previewHtml(mealTotals(meal, gr), dayOthers(ctx.key), paused);
}

/* ---------- import / export ---------- */

function sanitizeImport(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.foods) || !o.days || typeof o.days !== 'object') return null;
  const n = v => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
  const trip = v => ({ kcal: n(v && v.kcal), protein: n(v && v.protein), carbs: n(v && v.carbs), fat: n(v && v.fat) });
  const foods = o.foods.filter(f => f && typeof f.name === 'string').map(f => Object.assign(trip(f), {
    id: String(f.id || uid()), name: f.name.slice(0, 60), desc: String(f.desc || '').slice(0, 100),
    portion: f.portion && f.portion.name && +f.portion.grams > 0 ? { name: String(f.portion.name).slice(0, 30), grams: +f.portion.grams } : null,
    source: String(f.source || '').slice(0, 200), createdAt: +f.createdAt || Date.now(), lastUsed: +f.lastUsed || 0, lastGrams: +f.lastGrams > 0 ? +f.lastGrams : null
  }));
  const ids = new Set(foods.map(f => f.id));
  const meals = (Array.isArray(o.meals) ? o.meals : []).filter(m => m && typeof m.name === 'string').map(m => ({
    id: String(m.id || uid()), name: m.name.slice(0, 60), createdAt: +m.createdAt || Date.now(), lastUsed: +m.lastUsed || 0,
    items: (Array.isArray(m.items) ? m.items : []).filter(i => i && ids.has(String(i.foodId)) && +i.grams > 0).map(i => ({ foodId: String(i.foodId), grams: +i.grams }))
  })).filter(m => m.items.length);
  const days = {};
  Object.keys(o.days).forEach(k => {
    const d = o.days[k];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d || typeof d !== 'object') return;
    days[k] = {
      entries: (Array.isArray(d.entries) ? d.entries : []).filter(e => e && +e.grams > 0 && e.per100).map(e => {
        const out = {
          id: String(e.id || uid()), foodId: e.foodId ? String(e.foodId) : null, name: String(e.name || 'Food').slice(0, 60),
          grams: +e.grams, active: e.active !== false, per100: trip(e.per100), at: +e.at || 0
        };
        if (e.groupId) { out.groupId = String(e.groupId); out.groupName = String(e.groupName || 'Meal').slice(0, 60); }
        return out;
      }),
      finished: !!d.finished,
      legacy: d.legacy && typeof d.legacy === 'object' ? trip(d.legacy) : null
    };
  });
  const goals = {};
  [...MACROS, 'maint'].forEach(k => { const v = +((o.goals || {})[k]); goals[k] = v > 0 ? v : null; });
  const rh = +((o.settings || {}).rolloverHour);
  return { foods, meals, days, goals, rolloverHour: Number.isInteger(rh) && rh >= 0 && rh <= 6 ? rh : DEFAULT_ROLLOVER };
}

async function exportData() {
  const u = me();
  const payload = { app: 'meal-tracker', version: 3, exportedAt: new Date().toISOString(), profile: u.name, foods: u.foods, meals: u.meals, days: u.days, goals: u.goals, settings: { rolloverHour: rollover() } };
  const fname = 'meal-tracker-' + u.name.replace(/[^a-z0-9_-]+/gi, '_') + '-' + ymd(new Date()) + '.json';
  const file = new File([JSON.stringify(payload, null, 2)], fname, { type: 'application/json' });
  let done = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Meal Tracker backup' }); done = true; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (!done) {
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  u.settings.lastExport = Date.now();
  persist();
  toast('Backup exported');
  render();
}

async function handleImportFile(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  inputEl.value = '';
  if (!file) return;
  let data = null;
  try { data = sanitizeImport(JSON.parse(await file.text())); } catch (e) { data = null; }
  if (!data) { toast('That file is not a valid backup.'); return; }
  const ok = await askConfirm({
    title: 'Replace this profile’s data?',
    text: 'The file has ' + data.foods.length + ' foods, ' + data.meals.length + ' meals and ' + Object.keys(data.days).length + ' days. Everything currently in this profile will be replaced. A safety copy of the current data is kept on this device.',
    ok: 'Replace', danger: true
  });
  if (!ok) return;
  try { localStorage.setItem(KEY + '_beforeImport', localStorage.getItem(KEY) || ''); } catch (e) { /* ignore */ }
  const u = me();
  u.foods = data.foods; u.meals = data.meals; u.days = data.days; u.goals = data.goals; u.settings.rolloverHour = data.rolloverHour;
  persist();
  render();
  toast('Backup restored');
}

/* ====================================================================
   Actions (click handlers, via data-act)
   ==================================================================== */

const actions = {
  'tab': el => { ui.tab = el.dataset.tab; if (ui.tab === 'profile') ui.profilePage = 'home'; ui.search = ''; ui.enter = true; render(); window.scrollTo(0, 0); },

  'day-prev': () => { ui.viewDate = addDays(viewKey(), -1); ui.enter = true; render(); },
  'day-next': () => { const n = addDays(viewKey(), 1); ui.viewDate = n >= todayKey() ? null : n; ui.enter = true; render(); },
  'day-today': () => { ui.viewDate = null; ui.enter = true; render(); },
  'pick-day': el => { const k = el.dataset.key; ui.viewDate = k >= todayKey() ? null : k; ui.enter = true; render(); },

  'toggle': el => {
    const e = getDay(viewKey()).entries.find(x => x.id === el.dataset.id);
    if (!e) return;
    e.active = !e.active;
    persist(); render();
  },
  'toggle-group': el => {
    const items = getDay(viewKey()).entries.filter(x => x.groupId === el.dataset.gid);
    if (!items.length) return;
    const all = items.every(x => x.active);
    items.forEach(x => { x.active = !all; });
    persist(); render();
  },
  'del-entry': el => animateOut(el, () => removeEntry(viewKey(), el.dataset.id)),
  'del-group': el => animateOut(el, () => removeGroup(viewKey(), el.dataset.gid)),
  'expand-entry': el => { const id = el.dataset.id; ui.expanded = ui.expanded === id ? null : id; ui.opened = ui.expanded; render(); },
  'expand-group': el => { const id = el.dataset.gid; ui.expandedGroup = ui.expandedGroup === id ? null : id; ui.opened = ui.expandedGroup; render(); },
  'edit-entry': el => {
    const e = getDay(viewKey()).entries.find(x => x.id === el.dataset.id);
    if (e) openAmount({ mode: 'edit', entry: e, key: viewKey() });
  },

  'add-food': () => openPicker(),
  'pick-tab': el => { ctx.pickTab = el.dataset.t; renderPicker(); },
  'pick-food': el => {
    const food = foodById(el.dataset.id);
    if (food) openAmount({ mode: 'add', food, key: viewKey() });
  },
  'quick-food': el => { const food = foodById(el.dataset.id); if (food) openAmount({ mode: 'add', food, key: viewKey() }); },
  'pick-meal': el => { const m = me().meals.find(x => x.id === el.dataset.id); if (m) openMealAmount(m, viewKey()); },
  'quick-meal': el => { const m = me().meals.find(x => x.id === el.dataset.id); if (m) openMealAmount(m, viewKey()); },
  'chip': el => setGrams(+el.dataset.g),
  'amount-remove': () => { const c = ctx; closeSheet(); if (c && c.entry) removeEntry(c.key, c.entry.id); },

  'foods-tab': el => { ui.foodsTab = el.dataset.t; ui.search = ''; ui.enter = true; render(); },
  'new-item': () => { if (ui.foodsTab === 'meals') openMealForm(null); else openFoodForm(null); },
  'new-food': () => openFoodForm(null, { thenAdd: !!(ctx && ctx.type === 'picker') }),
  'new-meal': () => openMealForm(null, { thenAdd: !!(ctx && ctx.type === 'picker') }),
  'edit-food': el => openFoodForm(el.dataset.id),
  'edit-meal': el => openMealForm(el.dataset.id),
  'use-calc': el => { const f = $('form[data-form="food"]'); if (f) { f.kcal.value = el.dataset.v; updateFoodHint(); } },

  'delete-food': async () => {
    const id = ctx && ctx.id, food = foodById(id);
    if (!food) return;
    const used = me().meals.filter(m => m.items.some(i => i.foodId === id));
    const ok = await askConfirm({
      title: 'Delete “' + food.name + '”?',
      text: 'Entries you already logged with it stay in your history.' + (used.length ? ' It will be removed from the meal' + (used.length > 1 ? 's' : '') + ': ' + used.map(m => m.name).join(', ') + '.' : ''),
      ok: 'Delete', danger: true
    });
    if (!ok) return;
    const u = me();
    u.foods = u.foods.filter(f => f.id !== id);
    u.meals.forEach(m => { m.items = m.items.filter(i => i.foodId !== id); });
    u.meals = u.meals.filter(m => m.items.length); // a meal with no ingredients left is removed
    persist(); render(); toast('Food deleted');
  },
  'delete-meal': async () => {
    const id = ctx && ctx.id, u = me(), meal = u.meals.find(m => m.id === id);
    if (!meal) return;
    const ok = await askConfirm({ title: 'Delete meal “' + meal.name + '”?', text: 'Days where you already logged it stay unchanged.', ok: 'Delete', danger: true });
    if (!ok) return;
    u.meals = u.meals.filter(m => m.id !== id);
    persist(); render(); toast('Meal deleted');
  },

  // look up values
  'lookup': () => {
    const f = $('form[data-form="food"]');
    if (!f) return;
    ctx.draft = readFoodDraft(f);
    ctx.view = 'lookup';
    ctx.lookup = { q: ctx.draft.name.trim(), loading: false, results: null, errors: [], token: 0 };
    renderFoodSheet();
    if (ctx.lookup.q.length >= 2) runLookup(ctx.lookup.q);
    else { const i = $('form[data-form="lookup"] [name="q"]'); if (i) i.focus(); }
  },
  'lookup-back': () => { ctx.view = 'form'; renderFoodSheet(); },
  'lookup-pick': el => {
    const r = ctx.lookup && ctx.lookup.results && ctx.lookup.results[+el.dataset.i];
    if (!r) return;
    const d = ctx.draft;
    if (!d.name.trim()) d.name = r.name;
    if (!d.desc.trim() && r.desc) d.desc = r.desc;
    d.kcal = String(r.kcal); d.protein = String(r.protein); d.carbs = String(r.carbs); d.fat = String(r.fat);
    if (r.url) d.source = r.url;
    ctx.note = 'Filled from ' + r.source + ' — check it against your own source before saving.';
    ctx.view = 'form';
    renderFoodSheet();
  },

  // meal editor
  'mi-add': () => { ctx.view = 'pick'; renderMealForm(); },
  'mi-back': () => { ctx.view = 'edit'; renderMealForm(); },
  'mi-pick': el => {
    const f = foodById(el.dataset.id);
    if (!f) return;
    ctx.draft.items.push({ foodId: f.id, grams: f.lastGrams || (f.portion && f.portion.grams) || 100 });
    ctx.view = 'edit';
    renderMealForm();
  },
  'mi-del': el => { ctx.draft.items.splice(+el.dataset.i, 1); renderMealForm(); },

  'finish-day': async () => {
    const key = viewKey(), day = getDay(key), t = dayTotals(day);
    if (!(t.kcal > 0)) { toast('Nothing counted yet.'); return; }
    const paused = day.entries.filter(e => !e.active).length;
    const ok = await askConfirm({
      title: 'Finish today?',
      text: fmt(t.kcal) + ' kcal · P ' + fmt(t.protein, 1) + ' · C ' + fmt(t.carbs, 1) + ' · F ' + fmt(t.fat, 1) + '.' + (paused ? ' ' + paused + ' paused item' + (paused > 1 ? 's' : '') + ' will not be counted.' : '') + ' You can reopen the day later.',
      ok: 'Finish day'
    });
    if (!ok) return;
    ensureDay(key).finished = true;
    persist(); render();
  },
  'reopen-day': () => { ensureDay(viewKey()).finished = false; persist(); render(); },

  'close-sheet': () => closeSheet(),

  'goto': el => { ui.profilePage = el.dataset.page; if (ui.profilePage === 'stats') ui.selDay = null; ui.enter = true; render(); window.scrollTo(0, 0); },
  'metric': el => { ui.metric = el.dataset.m; ui.enter = true; render(); },
  'week-prev': () => { ui.weekOffset -= 1; ui.selDay = null; ui.enter = true; render(); },
  'week-next': () => { ui.weekOffset = Math.min(0, ui.weekOffset + 1); ui.selDay = null; ui.enter = true; render(); },
  'sel-day': el => { ui.selDay = ui.selDay === el.dataset.key ? null : el.dataset.key; ui.opened = ui.selDay; render(); },
  'open-day': el => { const k = el.dataset.key; ui.viewDate = k >= todayKey() ? null : k; ui.tab = 'today'; ui.enter = true; render(); window.scrollTo(0, 0); },

  'theme': el => { try { localStorage.setItem(THEME_KEY, el.dataset.t); } catch (e) { /* ignore */ } applyTheme(); render(); },

  'export': () => exportData(),
  'import': () => { const f = $('#importFile'); if (f) f.click(); },

  'delete-profile': async () => {
    const u = me();
    const ok = await askConfirm({ title: 'Delete profile?', text: 'This permanently removes all foods and history of ' + u.name + ' from this device.', ok: 'Delete profile', danger: true, requireText: u.name });
    if (!ok) return;
    delete db.users[db.session];
    db.session = null;
    persist(); render();
  },
  'logout': () => { db.session = null; persist(); ui.tab = 'today'; ui.viewDate = null; ui.profilePage = 'home'; render(); },

  'auth-mode': el => { ui.authMode = el.dataset.mode; showAuth(); },
  'fill-user': el => { const i = $('form[data-form="auth"] [name="username"]'); if (i) { i.value = el.dataset.name; const p = $('form[data-form="auth"] [name="password"]'); if (p) p.focus(); } }
};

const inputs = {
  'food-search': t => { ui.search = t.value; const l = $('#foodList'); if (l) l.innerHTML = ui.foodsTab === 'meals' ? mealRows(ui.search, 'manage') : foodRows(ui.search, 'manage'); },
  'pick-search': t => {
    const l = $('#pickList');
    if (!l || !ctx) return;
    if (ctx.type === 'meal') l.innerHTML = foodRows(t.value, 'ing');
    else if (ctx.type === 'picker' && ctx.pickTab === 'meals') l.innerHTML = mealRows(t.value, 'pick');
    else l.innerHTML = foodRows(t.value, 'pick');
  },
  'grams-text': t => { const g = num(t.value); const r = $('#gramsRange'); if (r && g > 0) r.value = Math.min(500, g); updatePreview(); },
  'grams-range': t => { $('#gramsInput').value = t.value === '0' ? '' : t.value; updatePreview(); },
  'whatif': () => updatePreview(),
  'food-form': () => updateFoodHint(),
  'goals-form': () => updateGoalHint(),
  'rollover': t => { me().settings.rolloverHour = +t.value; persist(); toast('Saved'); },
  'usda-key': t => { me().settings.usdaKey = t.value.trim(); persist(); },
  'import-file': t => handleImportFile(t),
  'meal-name': t => { if (ctx && ctx.type === 'meal') ctx.draft.name = t.value; },
  'mi-grams': t => { if (ctx && ctx.type === 'meal') { const i = +t.dataset.i, g = num(t.value); ctx.draft.items[i].grams = g; syncIng('mi-grams', 'mi-range', i, false, g); updateMealForm(); } },
  'mi-range': t => { if (ctx && ctx.type === 'meal') { const i = +t.dataset.i, g = +t.value; ctx.draft.items[i].grams = g; syncIng('mi-grams', 'mi-range', i, true, g); updateMealForm(); } },
  'ma-grams': t => { if (ctx && ctx.type === 'mealadd') { const i = +t.dataset.i, g = num(t.value); ctx.grams[i] = g; syncIng('ma-grams', 'ma-range', i, false, g); updateMealAdd(); } },
  'ma-range': t => { if (ctx && ctx.type === 'mealadd') { const i = +t.dataset.i, g = +t.value; ctx.grams[i] = g; syncIng('ma-grams', 'ma-range', i, true, g); updateMealAdd(); } },
  'ma-opt': () => updateMealAdd()
};

const forms = {
  auth: async form => {
    const err = $('#authError'); err.textContent = '';
    const name = form.username.value.trim(), pw = form.password.value, key = name.toLowerCase();
    if (ui.authMode === 'login') {
      const u = db.users[key];
      if (!name || !pw || !u || !(await verifyPw(pw, u))) { err.textContent = 'Wrong username or password.'; return; }
    } else {
      if (name.length < 2 || name.length > 24) { err.textContent = 'Username must be 2–24 characters.'; return; }
      if (pw.length < 4) { err.textContent = 'Password must be at least 4 characters.'; return; }
      if (pw !== form.password2.value) { err.textContent = 'The two passwords do not match.'; return; }
      if (db.users[key]) { err.textContent = 'That username already exists on this device.'; return; }
      const salt = uid();
      db.users[key] = newUser(name, await hashPw(pw, salt), salt);
    }
    db.session = key;
    persist();
    ui.tab = 'today'; ui.viewDate = null; ui.profilePage = 'home'; ui.search = ''; ui.enter = true;
    render();
  },

  amount: () => {
    if (!ctx || ctx.type !== 'amount') return;
    const raw = num($('#gramsInput').value);
    if (!(raw > 0 && raw <= 10000)) return;
    const g = Math.round(raw * 10) / 10;
    if (ctx.mode === 'edit') {
      ctx.entry.grams = g;
      persist(); closeSheet(); render();
      return;
    }
    const paused = $('#whatIf').checked, food = ctx.food, key = ctx.key;
    const t0 = Date.now();
    addEntry(key, food, g, !paused);
    ui.fresh = { since: t0 };
    closeSheet();
    ui.tab = 'today';
    render();
    toast('Added ' + food.name + ' · ' + fmt(g, 1) + ' g' + (paused ? ' (paused)' : ''));
  },

  mealadd: () => {
    if (!ctx || ctx.type !== 'mealadd') return;
    const gr = ctx.grams.map(g => (Number.isFinite(g) ? Math.round(g * 10) / 10 : NaN));
    if (!gr.every(g => Number.isFinite(g) && g >= 0 && g <= 10000) || !gr.some(g => g > 0)) return;
    const meal = ctx.meal, key = ctx.key, paused = $('#whatIf').checked, remember = $('#remember').checked;
    const t0 = Date.now();
    logMeal(key, meal, gr, !paused);
    ui.fresh = { since: t0 };
    if (remember) { meal.items.forEach((it, i) => { if (gr[i] > 0) it.grams = gr[i]; }); persist(); }
    closeSheet();
    ui.tab = 'today';
    render();
    toast('Added ' + meal.name + (paused ? ' (paused)' : ''));
  },

  food: form => {
    const err = $('#foodErr'); err.textContent = '';
    const res = validateFood(form, ctx && ctx.id);
    if (!res.ok) { err.textContent = res.error; return; }
    const u = me(), thenAdd = ctx && ctx.thenAdd;
    let food;
    if (ctx && ctx.id) {
      food = u.foods.find(f => f.id === ctx.id);
      Object.assign(food, res.data);
    } else {
      food = Object.assign({ id: uid(), createdAt: Date.now(), lastUsed: 0, lastGrams: null }, res.data);
      u.foods.push(food);
    }
    persist();
    if (thenAdd) { openAmount({ mode: 'add', food, key: viewKey() }); render(); return; }
    closeSheet(); render(); toast('Food saved');
  },

  meal: form => {
    const err = $('#mealErr'); err.textContent = '';
    const u = me(), d = ctx.draft, name = form.name.value.trim();
    if (!name) { err.textContent = 'Give the meal a name.'; return; }
    if (u.meals.some(m => m.id !== ctx.id && m.name.trim().toLowerCase() === name.toLowerCase())) { err.textContent = 'You already have a meal with this name.'; return; }
    const items = d.items.filter(i => foodById(i.foodId));
    if (!items.length) { err.textContent = 'Add at least one ingredient.'; return; }
    if (!items.every(i => Number.isFinite(i.grams) && i.grams > 0 && i.grams <= 10000)) { err.textContent = 'Every ingredient needs an amount in grams (above 0).'; return; }
    const clean = items.map(i => ({ foodId: i.foodId, grams: Math.round(i.grams * 10) / 10 }));
    let meal;
    if (ctx.id) { meal = u.meals.find(m => m.id === ctx.id); meal.name = name; meal.items = clean; }
    else { meal = { id: uid(), name, items: clean, createdAt: Date.now(), lastUsed: 0 }; u.meals.push(meal); }
    persist();
    if (ctx.thenAdd) { openMealAmount(meal, viewKey()); render(); return; }
    closeSheet(); render(); toast('Meal saved');
  },

  lookup: form => {
    const q = form.q.value.trim();
    if (q.length < 2) return;
    runLookup(q);
  },

  goals: form => {
    const err = $('#goalErr'); err.textContent = '';
    const g = {}, names = { kcal: 'calorie', protein: 'protein', carbs: 'carbs', fat: 'fat', maint: 'maintenance' };
    for (const k of [...MACROS, 'maint']) {
      const raw = form[k].value.trim();
      if (raw === '') { g[k] = null; continue; }
      const n = num(raw);
      if (!Number.isFinite(n) || n < 0) { err.textContent = 'Check the ' + names[k] + ' value.'; return; }
      if ((k === 'kcal' || k === 'maint') && n > 20000) { err.textContent = 'That ' + names[k] + ' value looks too high.'; return; }
      g[k] = n > 0 ? n : null;
    }
    me().goals = g;
    persist();
    ui.profilePage = 'home';
    render();
    toast('Goals saved');
  },

  password: async form => {
    const err = $('#pwErr'); err.textContent = '';
    const u = me();
    if (!(await verifyPw(form.old.value, u))) { err.textContent = 'Current password is wrong.'; return; }
    if (form.new.value.length < 4) { err.textContent = 'New password must be at least 4 characters.'; return; }
    u.salt = uid();
    u.hash = await hashPw(form.new.value, u.salt);
    persist();
    form.reset();
    toast('Password updated');
  }
};

/* ====================================================================
   Boot
   ==================================================================== */

function boot() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el, e);
  });

  const onInput = e => {
    const t = e.target;
    if (t && t.dataset && t.dataset.input && inputs[t.dataset.input]) inputs[t.dataset.input](t, e);
  };
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);

  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (forms[form.dataset.form]) forms[form.dataset.form](form);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheetRoot.open')) closeSheet(); });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncKeyboard);
    window.visualViewport.addEventListener('scroll', syncKeyboard);
  }

  // Follow the phone's light/dark setting while the preference is "System".
  if (window.matchMedia) {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => { if (themePref() === 'system') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', on); else if (mq.addListener) mq.addListener(on);
  }

  // Coming back to the app after midnight: show the new day.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && me() && ui.tab === 'today' && !$('#sheetRoot.open')) render();
  });

  init();
}

async function init() {
  applyTheme();
  loadDb();
  await migrateOld();
  normalizeUsers();
  if (db.session && !db.users[db.session]) db.session = null;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') boot();

// Lets the logic be tested in Node without a browser.
if (typeof module !== 'undefined') {
  module.exports = {
    _setDb: x => { db = x; }, _getDb: () => db, loadDb, migrateOld, hashPw, verifyPw, newUser,
    dayTotals, sumEntries, entryVals, addEntry, ensureDay, getDay, sanitizeImport, weekStart, addDays, dayKeyAt, ymd, num, fmt, validateFood,
    mealTotals, logMeal, groupEntries, parseUSDA, parseOFF, normalizeUsers, rateEntry, targetShares, streaks, weekBalance
  };
}

/* Currency exchange — vanilla JS, no build step. */

const STORE_KEY = 'cx_state_v1';
const HINT_KEY = 'cx_removal_hint_v1';
const RATES_KEY = 'cx_rates_v1';
const MAX_ROWS = 12;
const STALE_MS = 30 * 60 * 1000; // refetch rates if the cache is older than 30 minutes

const DEFAULT_STATE = { base: 'USD', amount: 100, list: ['VND', 'CAD', 'JPY'] };

/* ---------- rate sources (all free, no API key) ---------- */
const SOURCES = [
  {
    name: 'open.er-api.com',
    url: base => `https://open.er-api.com/v6/latest/${base}`,
    parse: (data) => {
      if (!data || data.result !== 'success' || !data.rates) return null;
      return { rates: data.rates, time: (data.time_last_update_unix || 0) * 1000 || Date.now() };
    }
  },
  {
    name: 'currency-api',
    url: base => `https://latest.currency-api.pages.dev/v1/currencies/${base.toLowerCase()}.json`,
    parse: (data, base) => parseCurrencyApi(data, base)
  },
  {
    name: 'currency-api (jsdelivr)',
    url: base => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base.toLowerCase()}.json`,
    parse: (data, base) => parseCurrencyApi(data, base)
  }
];

function parseCurrencyApi(data, base) {
  const key = base.toLowerCase();
  if (!data || !data[key]) return null;
  const rates = {};
  for (const [code, value] of Object.entries(data[key])) rates[code.toUpperCase()] = value;
  const time = data.date ? new Date(`${data.date}T00:00:00Z`).getTime() : Date.now();
  return { rates, time };
}

/* ---------- state ---------- */
let state = loadState();
let rateTables = loadRates();   // { USD: { rates, time }, ... }
let sheetMode = null;           // 'base' | 'add' | index of a row
let swipe = null;          // in-flight swipe gesture
let openRow = null;        // the row currently showing its Delete panel
let longPressTimer = null;
let suppressNextClick = false;   // the click a drag or a hold leaves behind
let pendingRemove = null;
let fetching = false;
let lastError = '';
let deferredInstall = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!saved || !saved.base) return { ...DEFAULT_STATE };
    return {
      base: saved.base,
      amount: Number.isFinite(saved.amount) ? saved.amount : DEFAULT_STATE.amount,
      list: Array.isArray(saved.list) ? saved.list.filter(c => c !== saved.base) : [...DEFAULT_STATE.list]
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

function loadRates() {
  try { return JSON.parse(localStorage.getItem(RATES_KEY)) || {}; } catch { return {}; }
}

function saveRates() {
  try { localStorage.setItem(RATES_KEY, JSON.stringify(rateTables)); } catch {}
}

/* ---------- rate maths ---------- */
function rateFor(code) {
  if (code === state.base) return 1;
  const own = rateTables[state.base];
  if (own && Number.isFinite(own.rates[code])) return own.rates[code];
  // Fall back to any cached table that knows both currencies (lets you switch base offline).
  for (const table of Object.values(rateTables)) {
    const from = table.rates[state.base];
    const to = table.rates[code];
    if (Number.isFinite(from) && Number.isFinite(to) && from > 0) return to / from;
  }
  return null;
}

function ratesTime() {
  const own = rateTables[state.base];
  if (own) return own.time;
  const times = Object.values(rateTables).map(t => t.time).filter(Boolean);
  return times.length ? Math.max(...times) : 0;
}

function ratesAreStale() {
  const own = rateTables[state.base];
  if (!own) return true;
  return Date.now() - (own.fetched || own.time || 0) > STALE_MS;
}

async function fetchRates({ force = false } = {}) {
  if (fetching) return;
  if (!force && !ratesAreStale()) { render(); return; }
  fetching = true;
  lastError = '';
  render();

  const base = state.base;
  for (const source of SOURCES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(source.url(base), { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = source.parse(await res.json(), base);
      if (!parsed) throw new Error('unexpected response');
      rateTables[base] = { rates: parsed.rates, time: parsed.time, fetched: Date.now() };
      saveRates();
      fetching = false;
      render();
      return;
    } catch (err) {
      lastError = err && err.name === 'AbortError' ? 'request timed out' : String(err.message || err);
    }
  }

  fetching = false;
  render();
}

/* ---------- formatting ---------- */
/* Currencies with no subunit in everyday use — cents make no sense for them. */
const ZERO_DECIMAL = new Set(['VND']);

/* Above this, the cents are noise next to the size of the number. */
const WHOLE_ABOVE = 100000;

function decimalsFor(code, value) {
  if (ZERO_DECIMAL.has(code)) return 0;
  if (Math.abs(value) >= WHOLE_ABOVE) return 0;
  return 2;
}

function formatAmount(value, code) {
  if (!Number.isFinite(value)) return '—';
  const decimals = decimalsFor(code, value);
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value);
}

function formatRate(rate) {
  const decimals = rate >= 1 ? 4 : rate >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(rate);
}

/* Every amount starts big. A long number (VND runs to eight figures) would
   overflow the row, so step the size down by how many characters it has. */
function fitAmount(input) {
  const length = (input.textContent || '').length;
  const size = length <= 8 ? 36 : length <= 11 ? 31 : length <= 14 ? 26 : 22;
  input.style.fontSize = `${size}px`;
}

function fitAllAmounts() {
  fitAmount(el.baseAmount);
  el.list.querySelectorAll('.amount-value').forEach(fitAmount);
}

function parseAmount(text) {
  if (typeof text !== 'string') return NaN;
  let cleaned = text.replace(/[^\d.,-]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.replace(/,/g, '');
  else if (cleaned.includes(',')) cleaned = cleaned.replace(',', '.');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

/* Seed the pad with what the row actually shows, not full precision:
   449.91 rather than 449.914926, and 25000 rather than 25000.00. */
function padSeed(value, code) {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(decimalsFor(code, value));
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

/* ---------- flags ---------- */
let flagEmojiWorks = true;
function detectFlagEmoji() {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return true;
    ctx.font = '20px sans-serif';
    const flag = ctx.measureText('\u{1F1FA}\u{1F1F8}').width;
    const single = ctx.measureText('\u{1F1FA}').width;
    return flag < single * 1.6; // one glyph, not two letters side by side
  } catch {
    return true;
  }
}

function flagHTML(code) {
  const info = currencyInfo(code);
  if (flagEmojiWorks) return `<span class="flag">${info.flag}</span>`;
  return `<span class="flag is-text">${info.country || code.slice(0, 2)}</span>`;
}

/* ---------- elements ---------- */
const el = {
  baseChip: document.getElementById('baseChip'),
  baseFlag: document.getElementById('baseFlag'),
  baseCode: document.getElementById('baseCode'),
  baseAmount: document.getElementById('baseAmount'),
  list: document.getElementById('list'),
  addBtn: document.getElementById('addBtn'),
  hint: document.getElementById('hint'),
  padSheet: document.getElementById('padSheet'),
  padFlag: document.getElementById('padFlag'),
  padCode: document.getElementById('padCode'),
  padValue: document.getElementById('padValue'),
  confirmSheet: document.getElementById('confirmSheet'),
  confirmText: document.getElementById('confirmText'),
  confirmRemove: document.getElementById('confirmRemove'),
  refreshBtn: document.getElementById('refreshBtn'),
  installBtn: document.getElementById('installBtn'),
  status: document.getElementById('status'),
  sheet: document.getElementById('sheet'),
  sheetTitle: document.getElementById('sheetTitle'),
  search: document.getElementById('search'),
  options: document.getElementById('options')
};

/* ---------- rendering ---------- */
function render() {
  const baseInfo = currencyInfo(state.base);
  el.baseFlag.outerHTML = flagHTML(state.base);
  el.baseFlag = el.baseChip.querySelector('.flag');
  el.baseFlag.id = 'baseFlag';
  el.baseCode.textContent = state.base;
  el.baseChip.setAttribute('aria-label', `Base currency: ${baseInfo.name}. Tap to change.`);
  el.baseAmount.textContent = formatAmount(state.amount, state.base);

  el.list.innerHTML = '';
  state.list.forEach((code, index) => el.list.appendChild(renderRow(code, index)));

  el.addBtn.hidden = state.list.length >= MAX_ROWS;
  el.hint.hidden = state.list.length === 0 || localStorage.getItem(HINT_KEY) === '1';
  el.refreshBtn.classList.toggle('spin', fetching);
  openRow = null;
  fitAllAmounts();
  renderStatus();
}

function renderRow(code, index) {
  const info = currencyInfo(code);
  const rate = rateFor(code);
  const row = document.createElement('section');
  row.className = 'rate-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <button class="row-delete" data-action="remove" tabindex="-1" aria-label="Remove ${info.name}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z"/></svg>
      ${code}
    </button>
    <div class="row-surface">
      <div class="row">
        <button class="currency-chip" data-action="pick" aria-label="Change ${info.name}">
          ${flagHTML(code)}
          <span class="code">${code}</span>
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="amount-wrap">
          <button class="amount-value" data-code="${code}"
                  aria-label="Amount in ${info.name}, tap to edit">${rate === null ? '—' : formatAmount(state.amount * rate, code)}</button>
          <div class="rate-note">${rate === null ? 'rate unavailable' : `1 ${state.base} → ${formatRate(rate)} ${code}`}</div>
        </div>
      </div>
    </div>`;
  return row;
}

function renderStatus() {
  if (fetching) { el.status.textContent = 'Updating rates…'; el.status.classList.remove('error'); return; }

  const time = ratesTime();
  if (!time) {
    el.status.textContent = lastError ? `Could not load rates (${lastError})` : 'No rates yet — tap refresh.';
    el.status.classList.add('error');
    return;
  }
  const when = new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const offline = !navigator.onLine || lastError;
  el.status.textContent = offline ? `Offline — cached rates from ${when}` : `Rates updated ${when}`;
  el.status.classList.toggle('error', Boolean(offline));
}

/* ---------- amount editing: an in-app numpad ---------- */
/* A real text field makes the phone open its own keyboard and zoom the page in.
   Amounts are buttons, and tapping one opens this pad instead. */

let padCode = null;      // which currency is being typed
let padText = '';
let padReplace = true;   // the first key typed replaces the amount already there

function openPad(code) {
  const rate = code === state.base ? 1 : rateFor(code);
  if (rate === null) return;             // nothing sensible to type against
  padCode = code;
  padText = padSeed(state.amount * rate, code);
  padReplace = true;
  const info = currencyInfo(code);
  el.padFlag.innerHTML = flagHTML(code);
  el.padCode.textContent = code;
  el.padSheet.setAttribute('aria-label', `Enter an amount in ${info.name}`);
  renderPad();
  el.padSheet.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePad() {
  el.padSheet.hidden = true;
  document.body.style.overflow = '';
  padCode = null;
}

function renderPad() {
  const shown = padText === '' ? '0' : padText;
  el.padValue.textContent = shown;
  el.padValue.style.fontSize = shown.length <= 9 ? '40px' : shown.length <= 12 ? '34px' : '28px';
}

function padPress(key) {
  if (key === 'back') {
    padReplace = false;
    padText = padText.slice(0, -1);
    renderPad();
    return;
  }
  if (padReplace) { padText = ''; padReplace = false; }
  if (key === '.') {
    if (padText.includes('.')) return;
    padText = (padText || '0') + '.';
  } else {
    if (padText.replace(/[^0-9]/g, '').length >= 15) return;   // keep it sane
    padText = padText === '0' ? key : padText + key;
  }
  renderPad();
}

function applyPad() {
  const code = padCode;
  const value = parseAmount(padText);
  closePad();
  if (!Number.isFinite(value) || code === null) return;
  if (code === state.base) {
    state.amount = value;
  } else {
    const rate = rateFor(code);
    if (!rate) return;
    state.amount = value / rate;
  }
  saveState();
  render();
}

el.padSheet.addEventListener('click', e => {
  if (e.target.dataset.closePad) { closePad(); return; }
  const key = e.target.closest('.pad-key');
  if (key) { padPress(key.dataset.key); return; }
  if (e.target.closest('#padEnter')) applyPad();
});

/* A hardware keyboard should work too. */
document.addEventListener('keydown', e => {
  if (el.padSheet.hidden) return;
  if (/^[0-9]$/.test(e.key) || e.key === '.') { padPress(e.key); e.preventDefault(); return; }
  if (e.key === 'Backspace') { padPress('back'); e.preventDefault(); return; }
  if (e.key === 'Enter') { applyPad(); e.preventDefault(); }
});

el.baseAmount.addEventListener('click', () => openPad(state.base));

el.list.addEventListener('click', e => {
  const amount = e.target.closest('.amount-value');
  if (amount) { openPad(amount.dataset.code); return; }
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.closest('.rate-row').dataset.index);
  if (button.dataset.action === 'pick') openSheet(index);
  if (button.dataset.action === 'remove') removeRow(index);
});

function removeRow(index) {
  if (!state.list[index]) return;
  state.list.splice(index, 1);
  try { localStorage.setItem(HINT_KEY, '1'); } catch {}   // they know the gesture now
  saveState();
  render();
}

/* ---------- swipe left / press and hold to remove ---------- */
const SWIPE_START = 10;   // px before a drag counts as a swipe rather than a tap
const SWIPE_OPEN = 52;    // px dragged before the Delete panel stays open
const LONG_PRESS_MS = 500;

function closeOpenRow() {
  if (!openRow) return;
  openRow.classList.remove('open');
  openRow = null;
}

function endSwipe() {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (!swipe) return;
  const { row, dragging, dx } = swipe;
  const surface = row.querySelector('.row-surface');
  row.classList.remove('dragging');
  surface.style.transform = '';
  if (dragging) {
    suppressNextClick = true;   // a swipe must not also count as a tap
    closeOpenRow();
    if (dx <= -SWIPE_OPEN) { row.classList.add('open'); openRow = row; }
  }
  swipe = null;
}

el.list.addEventListener('pointerdown', e => {
  const row = e.target.closest('.rate-row');
  if (!row || e.target.closest('.row-delete')) return;
  if (openRow && openRow !== row) closeOpenRow();

  swipe = { row, startX: e.clientX, startY: e.clientY, dx: 0, dragging: false, pointerId: e.pointerId };

  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (!swipe || swipe.dragging) return;
    suppressNextClick = true;
    try { navigator.vibrate && navigator.vibrate(12); } catch {}
    askRemove(Number(row.dataset.index));
    swipe = null;
  }, LONG_PRESS_MS);
});

el.list.addEventListener('pointermove', e => {
  if (!swipe || e.pointerId !== swipe.pointerId) return;
  const dx = e.clientX - swipe.startX;
  const dy = e.clientY - swipe.startY;

  if (!swipe.dragging) {
    if (Math.abs(dy) > SWIPE_START && Math.abs(dy) > Math.abs(dx)) { endSwipe(); return; } // vertical scroll
    if (Math.abs(dx) <= SWIPE_START) return;
    swipe.dragging = true;
    clearTimeout(longPressTimer);
    swipe.row.classList.add('dragging');
    try { swipe.row.setPointerCapture(e.pointerId); } catch {}
  }

  const start = swipe.row.classList.contains('open') ? -104 : 0;
  swipe.dx = Math.max(-140, Math.min(0, start + dx));
  swipe.row.querySelector('.row-surface').style.transform = `translateX(${swipe.dx}px)`;
});

el.list.addEventListener('pointerup', endSwipe);
el.list.addEventListener('pointercancel', endSwipe);

// A swipe, or a tap while a row is open, must not reach the buttons underneath.
// Each new press starts clean, so a suppressed click can never strand the next tap.
document.addEventListener('pointerdown', () => { suppressNextClick = false; }, true);

document.addEventListener('click', e => {
  if (suppressNextClick) {
    suppressNextClick = false;
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  if (!openRow) return;
  if (e.target.closest('.row-delete')) return;
  if (openRow.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
  closeOpenRow();
}, true);

// Keyboard: Delete or Backspace on a focused currency removes it.
el.list.addEventListener('keydown', e => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const row = e.target.closest('.rate-row');
  if (!row) return;
  e.preventDefault();
  askRemove(Number(row.dataset.index));
});

/* ---------- confirm sheet ---------- */
function askRemove(index) {
  const code = state.list[index];
  if (!code) return;
  pendingRemove = index;
  el.confirmText.textContent = `Remove ${currencyInfo(code).name} (${code}) from your list?`;
  el.confirmSheet.hidden = false;
  document.body.style.overflow = 'hidden';
  el.confirmRemove.focus();
}

function closeConfirm() {
  el.confirmSheet.hidden = true;
  document.body.style.overflow = '';
  pendingRemove = null;
}

el.confirmRemove.addEventListener('click', () => {
  const index = pendingRemove;
  closeConfirm();
  if (index !== null) removeRow(index);
});

el.confirmSheet.addEventListener('click', e => { if (e.target.dataset.closeConfirm) closeConfirm(); });

/* ---------- picker sheet ---------- */
function openSheet(mode) {
  sheetMode = mode;
  el.sheetTitle.textContent =
    mode === 'base' ? 'Convert from' : mode === 'add' ? 'Add a currency' : 'Change currency';
  el.search.value = '';
  renderOptions('');
  el.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  // Focus the search box on pointer devices only; a phone keyboard popping up hides the list.
  if (window.matchMedia('(hover: hover)').matches) el.search.focus();
}

function closeSheet() {
  el.sheet.hidden = true;
  sheetMode = null;
  document.body.style.overflow = '';
}

function renderOptions(query) {
  const q = query.trim().toLowerCase();
  const used = new Set([state.base, ...state.list]);
  const matches = CURRENCIES.filter(c =>
    !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );

  if (!matches.length) {
    el.options.innerHTML = `<p class="empty">No currency matches “${query}”.</p>`;
    return;
  }

  el.options.innerHTML = matches.map(c => {
    const isCurrent =
      (sheetMode === 'base' && c.code === state.base) ||
      (typeof sheetMode === 'number' && c.code === state.list[sheetMode]);
    // Picking a new base may reuse a listed currency — the swap below sorts the list out.
    const blocked = sheetMode !== 'base' && used.has(c.code) && !isCurrent;
    return `
      <button class="option" data-code="${c.code}" ${blocked ? 'aria-disabled="true"' : ''}>
        ${flagHTML(c.code)}
        <span class="opt-code">${c.code}</span>
        <span class="opt-name">${c.name}</span>
        ${isCurrent ? '<span class="check">✓</span>' : blocked ? '<span class="check">in list</span>' : ''}
      </button>`;
  }).join('');
}

el.search.addEventListener('input', () => renderOptions(el.search.value));

el.options.addEventListener('click', e => {
  const option = e.target.closest('.option');
  if (!option || option.getAttribute('aria-disabled') === 'true') return;
  chooseCurrency(option.dataset.code);
});

function chooseCurrency(code) {
  if (sheetMode === 'base') {
    if (code !== state.base) {
      const oldRate = rateFor(code);            // convert the amount so the value stays the same
      state.list = state.list.filter(c => c !== code);
      if (!state.list.includes(state.base)) state.list.unshift(state.base);
      state.list = state.list.slice(0, MAX_ROWS);
      if (oldRate) state.amount = state.amount * oldRate;
      state.base = code;
    }
  } else if (sheetMode === 'add') {
    if (!state.list.includes(code) && code !== state.base) state.list.push(code);
  } else if (typeof sheetMode === 'number') {
    state.list[sheetMode] = code;
  }
  saveState();
  closeSheet();
  render();
  fetchRates();
}

el.sheet.addEventListener('click', e => { if (e.target.dataset.close) closeSheet(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!el.sheet.hidden) closeSheet();
  if (!el.confirmSheet.hidden) closeConfirm();
  if (!el.padSheet.hidden) closePad();
  closeOpenRow();
});

/* ---------- top bar ---------- */
el.baseChip.addEventListener('click', () => openSheet('base'));
el.addBtn.addEventListener('click', () => openSheet('add'));
el.refreshBtn.addEventListener('click', () => fetchRates({ force: true }));

window.addEventListener('online', () => fetchRates({ force: true }));
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchRates(); });

/* ---------- PWA ---------- */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  el.installBtn.hidden = false;
});

el.installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  el.installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => { el.installBtn.hidden = true; });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}


/* ---------- start ---------- */
flagEmojiWorks = detectFlagEmoji();
render();
fetchRates();

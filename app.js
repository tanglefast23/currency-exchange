/* Currency exchange — vanilla JS, no build step. */

const STORE_KEY = 'cx_state_v1';
const RATES_KEY = 'cx_rates_v1';
const MAX_ROWS = 12;
const STALE_MS = 30 * 60 * 1000; // refetch rates if the cache is older than 30 minutes

const DEFAULT_STATE = { base: 'USD', amount: 100, list: ['VND', 'CAD', 'JPY'], updatedAt: 0 };

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
let editing = false;
let fetching = false;
let lastError = '';
let deferredInstall = null;
let syncMessage = '';        // shown inside the sync sheet
let syncError = '';
let syncBusy = false;
let syncPushTimer = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!saved || !saved.base) return { ...DEFAULT_STATE };
    return {
      base: saved.base,
      amount: Number.isFinite(saved.amount) ? saved.amount : DEFAULT_STATE.amount,
      list: Array.isArray(saved.list) ? saved.list.filter(c => c !== saved.base) : [...DEFAULT_STATE.list],
      updatedAt: Number(saved.updatedAt) || 0
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState({ local = false } = {}) {
  if (!local) state.updatedAt = Date.now();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  if (!local) queueSync();
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
const amountFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatAmount(value) {
  if (!Number.isFinite(value)) return '—';
  return amountFmt.format(value);
}

function formatRate(rate) {
  const decimals = rate >= 1 ? 4 : rate >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(rate);
}

function parseAmount(text) {
  if (typeof text !== 'string') return NaN;
  let cleaned = text.replace(/[^\d.,-]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.replace(/,/g, '');
  else if (cleaned.includes(',')) cleaned = cleaned.replace(',', '.');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

function rawValue(value) {
  if (!Number.isFinite(value)) return '';
  return String(Math.round(value * 1e6) / 1e6);
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
  editBtn: document.getElementById('editBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  installBtn: document.getElementById('installBtn'),
  status: document.getElementById('status'),
  syncBtn: document.getElementById('syncBtn'),
  syncSheet: document.getElementById('syncSheet'),
  syncBody: document.getElementById('syncBody'),
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
  if (document.activeElement !== el.baseAmount) el.baseAmount.value = formatAmount(state.amount);

  el.list.innerHTML = '';
  state.list.forEach((code, index) => el.list.appendChild(renderRow(code, index)));

  el.addBtn.hidden = state.list.length >= MAX_ROWS;
  el.refreshBtn.classList.toggle('spin', fetching);
  renderStatus();
}

function renderRow(code, index) {
  const info = currencyInfo(code);
  const rate = rateFor(code);
  const row = document.createElement('section');
  row.className = 'card rate-row';
  row.dataset.index = String(index);
  row.innerHTML = `
    <div class="row">
      <button class="currency-chip" data-action="pick" aria-label="Change ${info.name}">
        ${flagHTML(code)}
        <span class="code">${code}</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
      </button>
      <div class="amount-wrap">
        <input class="amount-input" inputmode="decimal" enterkeyhint="done"
               aria-label="Amount in ${info.name}" data-code="${code}"
               value="${rate === null ? '—' : formatAmount(state.amount * rate)}" />
        <div class="rate-note">${rate === null ? 'rate unavailable' : `1 ${state.base} → ${formatRate(rate)} ${code}`}</div>
      </div>
      <button class="remove-btn" data-action="remove" aria-label="Remove ${info.name}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM7 11h10v2H7z"/></svg>
      </button>
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

/* ---------- amount editing ---------- */
function handleAmountInput(inputEl, code) {
  const value = parseAmount(inputEl.value);
  if (!Number.isFinite(value)) return;
  if (code === state.base) {
    state.amount = value;
  } else {
    const rate = rateFor(code);
    if (!rate) return;
    state.amount = value / rate;
  }
  saveState();
  updateOtherAmounts(inputEl);
}

function updateOtherAmounts(skipEl) {
  if (el.baseAmount !== skipEl) el.baseAmount.value = formatAmount(state.amount);
  el.list.querySelectorAll('.amount-input').forEach(input => {
    if (input === skipEl) return;
    const rate = rateFor(input.dataset.code);
    input.value = rate === null ? '—' : formatAmount(state.amount * rate);
  });
}

function wireAmountInput(inputEl, getCode) {
  inputEl.addEventListener('focus', () => {
    const code = getCode();
    const rate = code === state.base ? 1 : rateFor(code);
    inputEl.value = rate === null ? '' : rawValue(state.amount * rate);
    inputEl.select();
  });
  inputEl.addEventListener('input', () => handleAmountInput(inputEl, getCode()));
  inputEl.addEventListener('blur', () => {
    const code = getCode();
    const rate = code === state.base ? 1 : rateFor(code);
    inputEl.value = rate === null ? '—' : formatAmount(state.amount * rate);
  });
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') inputEl.blur(); });
}

wireAmountInput(el.baseAmount, () => state.base);

el.list.addEventListener('focusin', e => {
  const input = e.target.closest('.amount-input');
  if (input && !input.dataset.wired) {
    input.dataset.wired = '1';
    wireAmountInput(input, () => input.dataset.code);
    input.dispatchEvent(new Event('focus'));
  }
});

el.list.addEventListener('click', e => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.closest('.rate-row').dataset.index);
  if (button.dataset.action === 'pick') openSheet(index);
  if (button.dataset.action === 'remove') removeRow(index);
});

function removeRow(index) {
  state.list.splice(index, 1);
  saveState();
  render();
  if (!state.list.length) setEditing(false);
}

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
  if (!el.syncSheet.hidden) closeSyncSheet();
});

/* ---------- top bar ---------- */
el.baseChip.addEventListener('click', () => openSheet('base'));
el.addBtn.addEventListener('click', () => openSheet('add'));
el.refreshBtn.addEventListener('click', () => fetchRates({ force: true }));

function setEditing(next) {
  editing = next;
  document.body.classList.toggle('editing', editing);
  el.editBtn.textContent = editing ? 'Done' : 'Edit';
}
el.editBtn.addEventListener('click', () => setEditing(!editing));

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


/* ---------- sync (Supabase) ---------- */
/* Your currency list lives in this browser either way. When Supabase is set up
   and you sign in, the same list follows you to every device. Newest edit wins. */

function queueSync() {
  if (!SYNC.isSignedIn()) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => pushState(), 1200);
}

async function pushState() {
  if (!SYNC.isSignedIn()) return;
  try {
    await SYNC.push(state);
    syncError = '';
  } catch (err) {
    syncError = String(err.message || err);
  }
  renderSyncUi();
}

function adoptRemote(remote) {
  state.base = remote.base || state.base;
  state.amount = Number.isFinite(remote.amount) ? remote.amount : state.amount;
  state.list = (remote.list || []).filter(code => code !== remote.base);
  state.updatedAt = remote.updatedAt;
  saveState({ local: true });   // came from the server, no need to push it back
}

async function syncNow({ announce = false } = {}) {
  if (!SYNC.isSignedIn()) return;
  syncBusy = true;
  renderSyncUi();
  try {
    const remote = await SYNC.pull();
    if (remote && remote.updatedAt > (state.updatedAt || 0)) {
      adoptRemote(remote);
      render();
      fetchRates();
      syncMessage = 'Loaded your saved currencies.';
    } else {
      await SYNC.push(state);
      if (announce) syncMessage = 'Saved to your account.';
    }
    syncError = '';
  } catch (err) {
    syncError = String(err.message || err);
  }
  syncBusy = false;
  renderSyncUi();
}

function renderSyncUi() {
  const signedIn = SYNC.isSignedIn();
  el.syncBtn.classList.toggle('muted', !signedIn);
  el.syncBtn.classList.toggle('spin', syncBusy);
  el.syncBtn.setAttribute('aria-label', signedIn ? `Synced as ${SYNC.accountEmail()}` : 'Sync across devices');
  if (!el.syncSheet.hidden) renderSyncBody();
}

function renderSyncBody() {
  const note = syncError
    ? `<p class="sync-note error">${syncError}</p>`
    : syncMessage ? `<p class="sync-note ok">${syncMessage}</p>` : '';

  if (SYNC.isSignedIn()) {
    el.syncBody.innerHTML = `
      <p class="sync-lead">Signed in as <strong>${SYNC.accountEmail() || 'your account'}</strong>.
      Your base currency, amount and list are saved to your account and load on any device you sign in on.</p>
      ${note}
      <div class="sync-actions">
        <button class="primary-btn" data-sync-action="now" ${syncBusy ? 'disabled' : ''}>${syncBusy ? 'Syncing…' : 'Sync now'}</button>
        <button class="ghost-btn" data-sync-action="signout">Sign out</button>
      </div>`;
    return;
  }

  if (!SYNC.isConfigured()) {
    el.syncBody.innerHTML = `
      <p class="sync-lead">Your currencies are saved in this browser already. To carry them
      between devices, connect the app to Supabase.</p>
      <p class="sync-note">Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in your
      Vercel project, or paste them here to use them on this device only.</p>
      ${note}
      <form class="sync-form" data-sync-action="config">
        <label class="field"><span>Project URL</span>
          <input name="url" type="url" placeholder="https://xxxx.supabase.co" autocomplete="off" required /></label>
        <label class="field"><span>Anon key</span>
          <input name="anonKey" type="text" placeholder="eyJhbGci…" autocomplete="off" required /></label>
        <button class="primary-btn" type="submit">Connect</button>
      </form>`;
    return;
  }

  el.syncBody.innerHTML = `
    <p class="sync-lead">Enter your email and we will send you a sign-in link.
    Open it on any device to get the same currency list there.</p>
    ${note}
    <form class="sync-form" data-sync-action="signin">
      <label class="field"><span>Email</span>
        <input name="email" type="email" placeholder="you@example.com" autocomplete="email" required /></label>
      <button class="primary-btn" type="submit" ${syncBusy ? 'disabled' : ''}>${syncBusy ? 'Sending…' : 'Send sign-in link'}</button>
    </form>
    <button class="ghost-btn" data-sync-action="forget">Use a different Supabase project</button>`;
}

function openSyncSheet() {
  el.syncSheet.hidden = false;
  document.body.style.overflow = 'hidden';
  renderSyncBody();
}

function closeSyncSheet() {
  el.syncSheet.hidden = true;
  document.body.style.overflow = '';
  syncMessage = '';
  syncError = '';
}

el.syncBtn.addEventListener('click', openSyncSheet);
el.syncSheet.addEventListener('click', e => { if (e.target.dataset.closeSync) closeSyncSheet(); });

el.syncBody.addEventListener('submit', async e => {
  e.preventDefault();
  const action = e.target.dataset.syncAction;
  const data = new FormData(e.target);

  if (action === 'config') {
    SYNC.setManualConfig(data.get('url'), data.get('anonKey'));
    syncMessage = 'Connected. Now sign in with your email.';
    syncError = '';
    renderSyncBody();
    return;
  }

  if (action === 'signin') {
    syncBusy = true;
    syncError = '';
    renderSyncBody();
    try {
      await SYNC.sendMagicLink(data.get('email'));
      syncMessage = 'Check your email for the sign-in link, then open it on this device.';
    } catch (err) {
      syncError = String(err.message || err);
    }
    syncBusy = false;
    renderSyncBody();
  }
});

el.syncBody.addEventListener('click', async e => {
  const button = e.target.closest('button[data-sync-action]');
  if (!button) return;
  const action = button.dataset.syncAction;

  if (action === 'now') { await syncNow({ announce: true }); return; }

  if (action === 'signout') {
    SYNC.signOut();
    syncMessage = 'Signed out. This browser keeps its own list.';
    renderSyncUi();
    renderSyncBody();
    return;
  }

  if (action === 'forget') {
    SYNC.clearManualConfig();
    await SYNC.loadConfig();
    syncMessage = '';
    renderSyncBody();
  }
});

async function initSync() {
  const result = await SYNC.init();
  if (result && result.error) syncError = result.error;
  renderSyncUi();
  if (result && result.signedIn) {
    syncMessage = 'Signed in.';
    openSyncSheet();
  }
  if (SYNC.isSignedIn()) await syncNow();
}

/* ---------- start ---------- */
flagEmojiWorks = detectFlagEmoji();
render();
fetchRates();
initSync();

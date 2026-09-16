/* Supabase sync — plain fetch against the REST + auth endpoints, no SDK, no CDN.
   Keeps your base currency, amount and currency list on your account so the app
   remembers them on every device you sign in on. */

const SYNC = (() => {
  const CONFIG_KEY = 'cx_supabase_cfg_v1';
  const SESSION_KEY = 'cx_session_v1';
  const TABLE = 'cx_prefs';

  let config = null;    // { url, anonKey }
  let session = null;   // { access_token, refresh_token, expires_at, email, userId }
  let loadedConfig = false;

  /* ---------- storage ---------- */
  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function writeJSON(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  /* ---------- config ---------- */
  /* The URL and anon key are public values, but they never live in this repo.
     On Vercel they come from environment variables through /api/config; you can
     also paste them once in the app, and then they stay in this browser only. */
  async function loadConfig() {
    if (loadedConfig) return config;
    loadedConfig = true;

    const manual = readJSON(CONFIG_KEY);
    if (manual && manual.url && manual.anonKey) { config = manual; return config; }

    try {
      const res = await fetch('api/config', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.configured && data.url && data.anonKey) {
          config = { url: String(data.url).replace(/\/+$/, ''), anonKey: data.anonKey };
        }
      }
    } catch {}
    return config;
  }

  function setManualConfig(url, anonKey) {
    config = { url: String(url).trim().replace(/\/+$/, ''), anonKey: String(anonKey).trim() };
    writeJSON(CONFIG_KEY, config);
    loadedConfig = true;
    return config;
  }

  function clearManualConfig() {
    writeJSON(CONFIG_KEY, null);
    config = null;
    loadedConfig = false;
  }

  const isConfigured = () => Boolean(config && config.url && config.anonKey);

  /* ---------- session ---------- */
  function decodeJwt(token) {
    try {
      const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = raw + '='.repeat((4 - (raw.length % 4)) % 4);  // JWTs drop base64 padding
      const json = decodeURIComponent(
        atob(payload).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
      );
      return JSON.parse(json);
    } catch { return null; }
  }

  function storeSession(tokens) {
    const claims = decodeJwt(tokens.access_token) || {};
    session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Number(tokens.expires_at) || Math.floor(Date.now() / 1000) + Number(tokens.expires_in || 3600),
      email: claims.email || (tokens.user && tokens.user.email) || '',
      userId: claims.sub || (tokens.user && tokens.user.id) || ''
    };
    writeJSON(SESSION_KEY, session);
    return session;
  }

  /** Magic-link redirects land back here with tokens in the URL fragment. */
  function consumeAuthHash() {
    if (!location.hash || location.hash.length < 2) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    const error = params.get('error_description') || params.get('error');
    const accessToken = params.get('access_token');
    if (!error && !accessToken) return null;

    history.replaceState(null, '', location.pathname + location.search);
    if (error) return { error: decodeURIComponent(error.replace(/\+/g, ' ')) };

    storeSession({
      access_token: accessToken,
      refresh_token: params.get('refresh_token'),
      expires_in: params.get('expires_in')
    });
    return { signedIn: true };
  }

  async function refreshSession() {
    if (!session || !session.refresh_token || !isConfigured()) return false;
    try {
      const res = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!res.ok) { signOut(); return false; }
      storeSession(await res.json());
      return true;
    } catch {
      return false; // offline: keep the session, try again later
    }
  }

  async function validToken() {
    if (!session) return null;
    const skew = 60;
    if (session.expires_at - skew <= Math.floor(Date.now() / 1000)) {
      const ok = await refreshSession();
      if (!ok) return null;
    }
    return session.access_token;
  }

  async function sendMagicLink(email) {
    if (!isConfigured()) throw new Error('Supabase is not configured yet.');
    const redirect = location.origin + location.pathname;
    const res = await fetch(`${config.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
      method: 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), create_user: true })
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.msg || detail.error_description || detail.message || `sign-in failed (HTTP ${res.status})`);
    }
    return true;
  }

  function signOut() {
    session = null;
    writeJSON(SESSION_KEY, null);
  }

  const isSignedIn = () => Boolean(session && session.access_token);
  const accountEmail = () => (session && session.email) || '';

  /* ---------- preferences row ---------- */
  async function pull() {
    const token = await validToken();
    if (!token || !isConfigured()) return null;
    const url = `${config.url}/rest/v1/${TABLE}?select=base,amount,list,updated_at&user_id=eq.${session.userId}`;
    const res = await fetch(url, {
      headers: { apikey: config.anonKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`could not read your saved list (HTTP ${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const row = rows[0];
    return {
      base: row.base,
      amount: Number(row.amount),
      list: Array.isArray(row.list) ? row.list : [],
      updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0
    };
  }

  async function push(state) {
    const token = await validToken();
    if (!token || !isConfigured()) return false;
    const res = await fetch(`${config.url}/rest/v1/${TABLE}`, {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        user_id: session.userId,
        base: state.base,
        amount: state.amount,
        list: state.list,
        updated_at: new Date(state.updatedAt || Date.now()).toISOString()
      })
    });
    if (!res.ok) throw new Error(`could not save your list (HTTP ${res.status})`);
    return true;
  }

  async function init() {
    session = readJSON(SESSION_KEY);
    await loadConfig();
    return consumeAuthHash();
  }

  return {
    init, loadConfig, isConfigured, setManualConfig, clearManualConfig,
    sendMagicLink, signOut, isSignedIn, accountEmail,
    pull, push
  };
})();

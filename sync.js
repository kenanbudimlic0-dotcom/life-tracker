// Backup in ein privates GitHub-Repo. Der Token bleibt auf diesem Gerät und landet nie im Backup.
(function (root) {
  'use strict';

  const CONFIG_KEY = 'lt.sync';
  const DIRTY_KEY = 'lt.dirty';
  const LAST_KEY = 'lt.lastSync';
  const FILE = 'tracker.json';
  const API = 'https://api.github.com';
  const DEBOUNCE_MS = 3000;
  const TIMEOUT_MS = 20000;
  const MAX_ATTEMPTS = 4;

  let host = null;
  let timer = null;
  let running = false;
  let runAgain = false;
  let changeCount = 0;
  let lastError = '';

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* Der Status zeigt weiterhin "Noch nicht gesichert". */ }
  }

  function getConfig() {
    try {
      const cfg = JSON.parse(read(CONFIG_KEY));
      return cfg && cfg.owner && cfg.repo && cfg.token ? cfg : null;
    } catch (e) {
      return null;
    }
  }

  function isDirty() {
    return read(DIRTY_KEY) === '1';
  }

  function formatLast(ts) {
    const zone = { timeZone: 'Europe/Vienna' };
    const time = new Date(ts).toLocaleTimeString('de-AT', { ...zone, hour: '2-digit', minute: '2-digit' });
    const day = (d) => d.toLocaleDateString('de-AT', zone);
    if (day(new Date(ts)) === day(new Date())) return `Gesichert um ${time}`;
    const date = new Date(ts).toLocaleDateString('de-AT', { ...zone, day: 'numeric', month: 'numeric' });
    return `Gesichert am ${date} um ${time}`;
  }

  function getStatus() {
    if (!getConfig()) return { kind: 'off', text: 'Backup nicht eingerichtet' };
    if (running) return { kind: 'busy', text: 'Wird gesichert …' };
    if (lastError) return { kind: 'error', text: lastError };
    if (isDirty()) return { kind: 'pending', text: 'Noch nicht gesichert' };
    const last = Number(read(LAST_KEY));
    return last ? { kind: 'ok', text: formatLast(last) } : { kind: 'pending', text: 'Noch nicht gesichert' };
  }

  function announce() {
    if (host) host.onStatus(getStatus());
  }

  // ---------- GitHub-API ----------

  function explain(status) {
    if (status === 401) return 'Token ungültig oder abgelaufen';
    if (status === 403) return 'Token hat keine Berechtigung';
    if (status === 404) return 'Repo nicht gefunden oder Token hat keinen Zugriff';
    return `GitHub meldet Fehler ${status}`;
  }

  async function api(cfg, path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`, {
        cache: 'no-store',
        signal: controller.signal,
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options && options.headers),
        },
      });
      if (!response.ok) throw new ApiError(response.status, explain(response.status));
      return response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'Keine Verbindung zu GitHub');
    } finally {
      clearTimeout(timeout);
    }
  }

  function encodeBase64(text) {
    let binary = '';
    new TextEncoder().encode(text).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function decodeBase64(base64) {
    const binary = atob(base64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }

  async function fetchRemote(cfg) {
    let file;
    try {
      file = await api(cfg, `/contents/${FILE}`);
    } catch (error) {
      if (error.status === 404) return null; // Noch kein Backup vorhanden, oder der PUT meldet den Fehler.
      throw error;
    }
    // Über 1 MB liefert die Contents-API keinen Inhalt mehr mit.
    const base64 = file.content ? file.content : (await api(cfg, `/git/blobs/${file.sha}`)).content;
    let data;
    try {
      data = JSON.parse(decodeBase64(base64));
    } catch (e) {
      throw new ApiError(0, 'Backup-Datei auf GitHub ist beschädigt');
    }
    if (!root.Logic.isValidState(data)) {
      throw new ApiError(0, 'Backup-Datei stammt von einer neueren App oder ist beschädigt');
    }
    return { data, sha: file.sha };
  }

  function pushRemote(cfg, state, sha) {
    const stamp = new Date(root.Logic.clock()).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
    const body = { message: `Backup ${stamp}`, content: encodeBase64(root.Logic.serialize(state, 1)) };
    if (sha) body.sha = sha;
    return api(cfg, `/contents/${FILE}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ---------- Abgleich ----------

  async function syncOnce(cfg) {
    for (let attempt = 1; ; attempt += 1) {
      const remote = await fetchRemote(cfg);
      // Ab hier bis zum nächsten await läuft alles am Stück, keine Eingabe geht dazwischen verloren.
      const seen = changeCount;
      const local = host.getState();
      const merged = remote ? root.Logic.merge(local, remote.data) : local;
      if (root.Logic.serialize(merged) !== root.Logic.serialize(local)) host.replaceState(merged);
      const upToDate = remote && root.Logic.serialize(merged) === root.Logic.serialize(remote.data);
      try {
        if (!upToDate) await pushRemote(cfg, merged, remote && remote.sha);
        return seen;
      } catch (error) {
        // Ein anderes Gerät war schneller: neu laden und nochmal zusammenführen.
        const conflict = error.status === 409 || error.status === 422;
        if (!conflict || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  async function run() {
    const cfg = getConfig();
    if (!host || !cfg) { announce(); return; }
    if (running) { runAgain = true; return; }
    if (navigator.onLine === false) {
      lastError = '';
      announce();
      return;
    }
    clearTimeout(timer);
    running = true;
    announce();
    try {
      const seen = await syncOnce(cfg);
      lastError = '';
      write(LAST_KEY, String(Date.now()));
      if (seen === changeCount) write(DIRTY_KEY, null);
      else runAgain = true;
    } catch (error) {
      lastError = error.status === 0 && error.message === 'Keine Verbindung zu GitHub'
        ? '' // Normaler Offline-Fall: später automatisch nachholen.
        : `Backup fehlgeschlagen: ${error.message}`;
      if (!lastError) write(DIRTY_KEY, '1');
    } finally {
      running = false;
      announce();
      if (runAgain) {
        runAgain = false;
        schedule();
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function markDirty() {
    changeCount += 1;
    write(DIRTY_KEY, '1');
    announce();
    if (getConfig()) schedule();
  }

  // Prüft Zugang und Sichtbarkeit, bevor Daten hochgeladen werden.
  async function connect(owner, repo, token) {
    const cfg = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
    if (!cfg.owner || !cfg.repo || !cfg.token) throw new Error('Bitte alle drei Felder ausfüllen');
    const info = await api(cfg, '');
    if (info.private !== true) {
      throw new Error('Dieses Repo ist öffentlich. Deine Daten dürfen nur in ein privates Repo.');
    }
    write(CONFIG_KEY, JSON.stringify(cfg));
    lastError = '';
    await run();
  }

  function disconnect() {
    clearTimeout(timer);
    write(CONFIG_KEY, null);
    write(LAST_KEY, null);
    lastError = '';
    announce();
  }

  function init(hostApi) {
    host = hostApi;
    root.addEventListener('online', run);
    announce();
    run();
  }

  root.Sync = { init, run, markDirty, connect, disconnect, getConfig, getStatus };
})(globalThis);

// Oberfläche: Woche, Verlauf, Vergleich und Checkliste.
(function () {
  'use strict';

  const STATE_KEY = 'lt.state';
  const { Logic, Sync } = globalThis;

  const viewEl = document.getElementById('view');
  const titleEl = document.getElementById('title');
  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');

  let state;
  let view = 'week';
  let selectedKey = null; // null bedeutet: immer die aktuelle Woche
  let compareKey = null;
  let editingPast = false;
  let renderPending = false;
  let toastTimer = null;

  // ---------- Hilfen ----------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked' || key === 'disabled') el[key] = Boolean(value);
      else el.setAttribute(key, value === true ? '' : value);
    });
    children.flat().forEach((child) => {
      if (child !== null && child !== undefined && child !== false) el.append(child);
    });
    return el;
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  function now() {
    return Logic.clock().getTime();
  }

  function persist() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Speichern auf dem Gerät fehlgeschlagen');
    }
  }

  function saveChange() {
    persist();
    Sync.markDirty();
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Logic.isValidState(parsed)) return parsed;
        throw new Error('invalid');
      }
    } catch (e) {
      // Unlesbare Daten nicht wegwerfen, sondern zur Rettung aufheben.
      try { if (raw) localStorage.setItem(`${STATE_KEY}.corrupt`, raw); } catch (ignored) { /* kein Platz */ }
    }
    return Logic.defaultState();
  }

  function growTextareas() {
    viewEl.querySelectorAll('textarea').forEach(grow);
  }

  function grow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  function isTyping() {
    const el = document.activeElement;
    return Boolean(el && viewEl.contains(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
  }

  // ---------- Wochen-Bereich ----------

  function activeKey() {
    return selectedKey || Logic.currentKey();
  }

  function setItem(key, itemId, patch) {
    const week = state.weeks[key];
    const item = week && week.items.find((entry) => entry.id === itemId);
    if (!item) return;
    Object.assign(item, patch);
    week.updatedAt = now();
    saveChange();
    updateSummary(key);
  }

  function updateSummary(key) {
    const box = viewEl.querySelector('[data-summary]');
    if (box) box.replaceWith(summaryCard(key));
  }

  function summaryCard(key) {
    const { achieved, total, percent } = Logic.weekStats(state.weeks[key]);
    const fill = h('span');
    fill.style.width = `${percent}%`;
    return h('section', { class: 'summary', 'data-summary': true },
      h('p', { class: 'summary-text' }, `KW ${Logic.weekNumber(key)}: ${achieved} von ${total} erreicht (${percent} %)`),
      h('div', { class: 'bar', role: 'presentation' }, fill));
  }

  function weekNav(key) {
    const isCurrent = key === Logic.currentKey();
    const go = (delta) => () => {
      const next = Logic.shiftWeek(key, delta);
      selectedKey = next === Logic.currentKey() ? null : next;
      editingPast = false;
      render();
      window.scrollTo(0, 0);
    };
    return h('div', { class: 'weeknav' },
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Vorherige Woche', onclick: go(-1) }, '‹'),
      h('div', { class: 'weeknav-label' },
        h('strong', null, `KW ${Logic.weekNumber(key)}`),
        h('span', null, Logic.formatRange(key))),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Nächste Woche', disabled: isCurrent, onclick: go(1) }, '›'));
  }

  function groupByCategory(items) {
    const groups = new Map();
    items.forEach((item) => {
      const name = item.category || 'Ohne Kategorie';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(item);
    });
    return [...groups.entries()];
  }

  function editableItem(key, item) {
    const card = h('article', { class: `item${item.achieved ? ' is-achieved' : ''}` });
    card.append(
      h('h3', null, item.name || 'Ohne Namen'),
      h('label', { class: 'field' }, h('span', null, 'Ziel'),
        h('textarea', {
          rows: 1,
          placeholder: 'Was ist das Ziel?',
          value: item.goal,
          oninput: (e) => { grow(e.target); setItem(key, item.id, { goal: e.target.value, goalEdited: true }); },
        })),
      h('label', { class: 'field' }, h('span', null, 'Was ich gemacht habe'),
        h('textarea', {
          rows: 1,
          placeholder: 'Was hast du gemacht?',
          value: item.done,
          oninput: (e) => { grow(e.target); setItem(key, item.id, { done: e.target.value }); },
        })),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: item.achieved,
          onchange: (e) => {
            card.classList.toggle('is-achieved', e.target.checked);
            setItem(key, item.id, { achieved: e.target.checked });
          },
        }),
        h('span', null, 'Ziel erreicht')));
    return card;
  }

  function readonlyItem(item) {
    return h('article', { class: `item${item.achieved ? ' is-achieved' : ''}` },
      h('h3', null, item.name || 'Ohne Namen'),
      h('dl', null,
        h('dt', null, 'Ziel'), h('dd', null, item.goal || '–'),
        h('dt', null, 'Was ich gemacht habe'), h('dd', null, item.done || '–')),
      h('p', { class: 'outcome' }, item.achieved ? '✓ Ziel erreicht' : 'Ziel nicht erreicht'));
  }

  function renderWeek() {
    const key = activeKey();
    const current = Logic.currentKey();
    const isCurrent = key === current;
    const week = state.weeks[key];
    const nodes = [weekNav(key)];

    if (!week) {
      nodes.push(h('section', { class: 'empty' },
        h('p', null, 'Für diese Woche gibt es keine Einträge.'),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => {
            Logic.createWeek(state, key, now());
            editingPast = true;
            saveChange();
            render();
          },
        }, 'Woche nachtragen')));
    } else {
      const editable = isCurrent || editingPast;
      nodes.push(summaryCard(key));
      if (!isCurrent) {
        nodes.push(h('div', { class: 'row' },
          h('span', { class: 'badge' }, 'Abgerechnet'),
          h('button', {
            type: 'button',
            onclick: () => { editingPast = !editingPast; render(); },
          }, editingPast ? 'Fertig' : 'Bearbeiten')));
      }
      if (!week.items.length) {
        nodes.push(h('section', { class: 'empty' }, h('p', null, 'Noch keine Punkte. Lege sie unter „Checkliste“ an.')));
      }
      groupByCategory(week.items).forEach(([name, items]) => {
        nodes.push(h('h2', { class: 'category' }, name));
        items.forEach((item) => nodes.push(editable ? editableItem(key, item) : readonlyItem(item)));
      });
    }

    nodes.push(h('div', { class: 'row actions' },
      h('button', { type: 'button', onclick: () => openCompare(key) }, 'Vor einem Jahr'),
      !isCurrent && h('button', {
        type: 'button',
        onclick: () => { selectedKey = null; editingPast = false; render(); window.scrollTo(0, 0); },
      }, 'Zur aktuellen Woche')));
    return nodes;
  }

  // ---------- Verlauf und Vergleich ----------

  function openCompare(key) {
    compareKey = key;
    view = 'compare';
    render();
    window.scrollTo(0, 0);
  }

  function renderHistory() {
    const keys = Logic.listWeekKeys(state);
    const nodes = [h('div', { class: 'row actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => openCompare(Logic.currentKey()) }, 'Vor einem Jahr'))];
    let year = null;
    keys.forEach((key) => {
      const weekYear = Logic.weekYear(key);
      if (weekYear !== year) {
        year = weekYear;
        nodes.push(h('h2', { class: 'category' }, String(year)));
      }
      const { achieved, total, percent } = Logic.weekStats(state.weeks[key]);
      const fill = h('span');
      fill.style.width = `${percent}%`;
      nodes.push(h('button', {
        type: 'button',
        class: 'history-row',
        onclick: () => {
          selectedKey = key === Logic.currentKey() ? null : key;
          editingPast = false;
          view = 'week';
          render();
          window.scrollTo(0, 0);
        },
      },
      h('span', { class: 'history-main' }, h('strong', null, `KW ${Logic.weekNumber(key)}`), h('span', null, Logic.formatRange(key))),
      h('span', { class: 'history-score' }, `${achieved} von ${total}`),
      h('span', { class: 'bar' }, fill)));
    });
    return nodes;
  }

  function compareSide(week, itemId) {
    const item = week && week.items.find((entry) => entry.id === itemId);
    if (!item) return h('div', { class: 'cmp-cell is-missing' }, '–');
    return h('div', { class: 'cmp-cell' },
      h('p', null, h('b', null, 'Ziel: '), item.goal || '–'),
      h('p', null, h('b', null, 'Gemacht: '), item.done || '–'),
      h('p', { class: 'outcome' }, item.achieved ? '✓ Erreicht' : 'Nicht erreicht'));
  }

  function compareHead(key) {
    const week = state.weeks[key];
    const stats = week ? Logic.weekStats(week) : null;
    return h('div', { class: 'cmp-head' },
      h('strong', null, `KW ${Logic.weekNumber(key)} / ${Logic.weekYear(key)}`),
      h('span', null, Logic.formatRange(key)),
      h('span', { class: 'cmp-score' }, stats ? `${stats.achieved} von ${stats.total} (${stats.percent} %)` : 'Keine Daten'));
  }

  function renderCompare() {
    const key = compareKey || Logic.currentKey();
    const pastKey = Logic.sameWeekLastYear(key);
    const week = state.weeks[key];
    const past = state.weeks[pastKey];
    const nodes = [
      h('div', { class: 'row actions' }, h('button', {
        type: 'button',
        onclick: () => { view = 'history'; render(); },
      }, '‹ Zum Verlauf')),
      h('div', { class: 'cmp-grid' }, compareHead(pastKey), compareHead(key)),
    ];
    if (!past) {
      nodes.push(h('section', { class: 'empty' }, h('p', null, `Für KW ${Logic.weekNumber(pastKey)} / ${Logic.weekYear(pastKey)} gibt es keine Einträge.`)));
    }
    const seen = new Set();
    const items = [];
    [...((week && week.items) || []), ...((past && past.items) || [])].forEach((item) => {
      if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
    });
    if (past || (week && week.items.length)) {
      items.forEach((item) => {
        nodes.push(h('h3', { class: 'cmp-name' }, item.name || 'Ohne Namen'));
        nodes.push(h('div', { class: 'cmp-grid' }, compareSide(past, item.id), compareSide(week, item.id)));
      });
    }
    return nodes;
  }

  // ---------- Checkliste ----------

  function touchTemplate() {
    const time = now();
    state.template.updatedAt = time;
    const key = Logic.currentKey();
    const week = state.weeks[key];
    // Die aktuelle Woche zieht mit, abgeschlossene Wochen bleiben wie sie sind.
    if (Logic.reconcileWeek(state, key) && week && week.updatedAt) week.updatedAt = time;
    saveChange();
  }

  function findCategory(catId) {
    return state.template.categories.find((cat) => cat.id === catId);
  }

  function findItem(catId, itemId) {
    const cat = findCategory(catId);
    return cat && cat.items.find((item) => item.id === itemId);
  }

  function move(list, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return false;
    [list[index], list[target]] = [list[target], list[index]];
    return true;
  }

  function moveEntry(getList, id, delta) {
    const list = getList();
    if (!list) return;
    if (move(list, list.findIndex((entry) => entry.id === id), delta)) {
      touchTemplate();
      render();
    }
  }

  function focusLast(selector) {
    const fields = viewEl.querySelectorAll(selector);
    if (fields.length) fields[fields.length - 1].focus();
  }

  function moveButtons(getList, id, index, length) {
    return h('div', { class: 'move' },
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Nach oben', disabled: index === 0, onclick: () => moveEntry(getList, id, -1) }, '↑'),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Nach unten', disabled: index === length - 1, onclick: () => moveEntry(getList, id, 1) }, '↓'));
  }

  function renderTemplateItem(cat, item, index) {
    const itemsOf = () => { const c = findCategory(cat.id); return c && c.items; };
    return h('div', { class: 'tpl-item' },
      h('div', { class: 'tpl-fields' },
        h('input', {
          type: 'text',
          class: 'tpl-item-name',
          'aria-label': 'Name des Punkts',
          placeholder: 'Name des Punkts',
          value: item.name,
          oninput: (e) => {
            const target = findItem(cat.id, item.id);
            if (target) { target.name = e.target.value; touchTemplate(); }
          },
        }),
        h('input', {
          type: 'text',
          'aria-label': 'Standardziel',
          placeholder: 'Standardziel, z. B. 3x pro Woche',
          value: item.defaultGoal,
          oninput: (e) => {
            const target = findItem(cat.id, item.id);
            if (target) { target.defaultGoal = e.target.value; touchTemplate(); }
          },
        })),
      h('div', { class: 'tpl-actions' },
        moveButtons(itemsOf, item.id, index, cat.items.length),
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            const label = item.name || 'diesen Punkt';
            if (!window.confirm(`„${label}“ löschen? Alte Wochen bleiben unverändert. Hast du diese Woche schon etwas eingetragen, bleibt der Punkt bis Sonntag sichtbar.`)) return;
            const c = findCategory(cat.id);
            if (!c) return;
            c.items = c.items.filter((entry) => entry.id !== item.id);
            touchTemplate();
            render();
          },
        }, 'Löschen')));
  }

  function renderCategory(cat, index, count) {
    return h('section', { class: 'tpl-cat' },
      h('div', { class: 'tpl-cat-head' },
        h('input', {
          type: 'text',
          class: 'tpl-cat-name',
          'aria-label': 'Name der Kategorie',
          placeholder: 'Name der Kategorie',
          value: cat.name,
          oninput: (e) => {
            const target = findCategory(cat.id);
            if (target) { target.name = e.target.value; touchTemplate(); }
          },
        }),
        moveButtons(() => state.template.categories, cat.id, index, count)),
      cat.items.map((item, i) => renderTemplateItem(cat, item, i)),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          onclick: () => {
            const c = findCategory(cat.id);
            if (!c) return;
            c.items.push({ id: Logic.newId(), name: '', defaultGoal: '' });
            touchTemplate();
            render();
            focusLast(`[data-cat="${cat.id}"] .tpl-item-name`);
          },
        }, '+ Punkt'),
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            if (!window.confirm(`Kategorie „${cat.name || 'ohne Namen'}“ mit allen Punkten löschen? Alte Wochen bleiben unverändert.`)) return;
            state.template.categories = state.template.categories.filter((entry) => entry.id !== cat.id);
            touchTemplate();
            render();
          },
        }, 'Kategorie löschen')));
  }

  function renderBackup() {
    const cfg = Sync.getConfig();
    const box = h('section', { class: 'panel', id: 'backup' }, h('h2', null, 'Backup auf GitHub'));
    if (cfg) {
      box.append(
        h('p', null, `Verbunden mit ${cfg.owner}/${cfg.repo}`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'primary', onclick: () => Sync.run() }, 'Jetzt sichern'),
          h('button', {
            type: 'button',
            class: 'danger',
            onclick: () => {
              if (!window.confirm('Backup trennen? Der Token wird von diesem Gerät gelöscht, deine Daten bleiben erhalten.')) return;
              Sync.disconnect();
              render();
            },
          }, 'Trennen')));
      return box;
    }
    const owner = h('input', { type: 'text', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' });
    const repo = h('input', { type: 'text', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', value: 'life-tracker-data' });
    const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
    const connect = h('button', {
      type: 'button',
      class: 'primary',
      onclick: async () => {
        connect.disabled = true;
        try {
          await Sync.connect(owner.value, repo.value, token.value);
          const status = Sync.getStatus();
          toast(status.kind === 'ok' ? 'Backup ist eingerichtet' : status.text);
          render();
        } catch (error) {
          toast(error.message);
          connect.disabled = false;
        }
      },
    }, 'Verbinden');
    box.append(
      h('label', { class: 'field' }, h('span', null, 'GitHub-Benutzername'), owner),
      h('label', { class: 'field' }, h('span', null, 'Privates Repo'), repo),
      h('label', { class: 'field' }, h('span', null, 'Token'), token),
      h('p', { class: 'hint' }, 'Der Token bleibt nur auf diesem Gerät gespeichert.'),
      connect);
    return box;
  }

  function exportData() {
    const blob = new Blob([Logic.serialize(state, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const today = Logic.clock().toLocaleDateString('sv-SE', { timeZone: 'Europe/Vienna' });
    const link = h('a', { href: url, download: `life-tracker-${today}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!Logic.isValidState(data)) throw new Error('invalid');
      state = Logic.merge(state, data);
      saveChange();
      render();
      toast('Daten importiert');
    } catch (e) {
      toast('Diese Datei konnte nicht gelesen werden');
    }
  }

  function renderChecklist() {
    const cats = state.template.categories;
    const file = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
      onchange: (e) => {
        if (e.target.files[0]) importData(e.target.files[0]);
        e.target.value = '';
      },
    });
    return [
      h('p', { class: 'hint' }, 'Änderungen gelten ab der aktuellen Woche. Alte Wochen bleiben unverändert.'),
      cats.map((cat, i) => {
        const section = renderCategory(cat, i, cats.length);
        section.dataset.cat = cat.id;
        return section;
      }),
      h('div', { class: 'row actions' },
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => {
            state.template.categories.push({ id: Logic.newId(), name: '', items: [] });
            touchTemplate();
            render();
            focusLast('.tpl-cat-name');
          },
        }, '+ Kategorie')),
      renderBackup(),
      h('section', { class: 'panel' },
        h('h2', null, 'Datei-Sicherung'),
        h('div', { class: 'row' },
          h('button', { type: 'button', onclick: exportData }, 'Exportieren'),
          h('button', { type: 'button', onclick: () => file.click() }, 'Importieren')),
        h('p', { class: 'hint' }, 'Beim Import gewinnt pro Woche die zuletzt geänderte Version. Der Token ist nie Teil der Datei.'),
        file),
    ];
  }

  // ---------- Grundgerüst ----------

  const VIEWS = {
    week: { title: 'Woche', tab: 'week', render: renderWeek },
    history: { title: 'Verlauf', tab: 'history', render: renderHistory },
    compare: { title: 'Vor einem Jahr', tab: 'history', render: renderCompare },
    checklist: { title: 'Checkliste', tab: 'checklist', render: renderChecklist },
  };

  function render() {
    renderPending = false;
    const current = VIEWS[view];
    titleEl.textContent = current.title;
    document.querySelectorAll('.tabs button').forEach((btn) => {
      if (btn.dataset.tab === current.tab) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    viewEl.replaceChildren(...current.render().flat(Infinity).filter(Boolean));
    growTextareas();
  }

  function renderUnlessTyping() {
    if (isTyping()) renderPending = true;
    else render();
  }

  // Beim Offenlassen über Mitternacht am Montag beginnt die neue Woche automatisch.
  function checkRollover() {
    const key = Logic.currentKey();
    if (state.weeks[key]) return;
    Logic.ensureCurrentWeek(state);
    persist();
    renderUnlessTyping();
  }

  function showStatus(status) {
    statusEl.textContent = status.text;
    statusEl.dataset.kind = status.kind;
  }

  function start() {
    state = loadState();
    Logic.ensureCurrentWeek(state);
    persist();

    document.querySelectorAll('.tabs button').forEach((btn) => {
      btn.addEventListener('click', () => {
        view = btn.dataset.tab;
        if (view === 'week') { selectedKey = null; editingPast = false; }
        render();
        window.scrollTo(0, 0);
      });
    });
    statusEl.addEventListener('click', () => {
      view = 'checklist';
      render();
      const backup = document.getElementById('backup');
      if (backup) backup.scrollIntoView();
    });
    window.addEventListener('resize', growTextareas);
    viewEl.addEventListener('focusout', () => {
      setTimeout(() => { if (renderPending && !isTyping()) render(); }, 0);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkRollover();
        Sync.run();
      }
    });

    render();
    Sync.init({
      getState: () => state,
      replaceState: (next) => {
        state = next;
        persist();
        renderUnlessTyping();
      },
      onStatus: showStatus,
    });

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // Nur für die Tests: neu zeichnen nach simuliertem Datum.
  globalThis.App = { refresh: () => { checkRollover(); render(); } };

  start();
})();

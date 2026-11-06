// Kalenderwochen, Abrechnung und Zusammenführen der Daten. Kein Zugriff auf die Oberfläche.
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DAY_MS = 86400000;
  const WEEK_KEY = /^(\d{4})-W(\d{2})$/;
  const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August',
    'September', 'Oktober', 'November', 'Dezember'];

  const viennaFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const Logic = {
    SCHEMA_VERSION,
    // Austauschbar, damit sich Wochenwechsel testen lassen.
    clock: () => new Date(),
  };

  // ---------- Kalender ----------

  function viennaYMD(date) {
    const parts = {};
    viennaFormat.formatToParts(date).forEach((p) => { parts[p.type] = Number(p.value); });
    return { y: parts.year, m: parts.month, d: parts.day };
  }

  function isoWeek(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay() || 7;
    dt.setUTCDate(dt.getUTCDate() + 4 - dow); // Donnerstag derselben Woche bestimmt das Jahr
    const year = dt.getUTCFullYear();
    const week = Math.ceil(((dt - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
    return { year, week };
  }

  function makeKey(year, week) {
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  function parseKey(key) {
    const match = WEEK_KEY.exec(key);
    if (!match) throw new Error(`Ungültige Woche: ${key}`);
    return { year: Number(match[1]), week: Number(match[2]) };
  }

  function mondayOf(key) {
    const { year, week } = parseKey(key);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow = jan4.getUTCDay() || 7;
    return new Date(jan4.getTime() + ((week - 1) * 7 - (dow - 1)) * DAY_MS);
  }

  Logic.weekKeyForDate = function (date) {
    const { y, m, d } = viennaYMD(date);
    const { year, week } = isoWeek(y, m, d);
    return makeKey(year, week);
  };

  Logic.currentKey = () => Logic.weekKeyForDate(Logic.clock());

  Logic.shiftWeek = function (key, delta) {
    const dt = new Date(mondayOf(key).getTime() + delta * 7 * DAY_MS);
    const { year, week } = isoWeek(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    return makeKey(year, week);
  };

  Logic.weeksInYear = function (year) {
    return isoWeek(year, 12, 28).week; // Der 28.12. liegt immer in der letzten Woche des Jahres.
  };

  Logic.sameWeekLastYear = function (key) {
    const { year, week } = parseKey(key);
    return makeKey(year - 1, Math.min(week, Logic.weeksInYear(year - 1)));
  };

  Logic.weekNumber = (key) => parseKey(key).week;
  Logic.weekYear = (key) => parseKey(key).year;

  Logic.formatRange = function (key) {
    const a = mondayOf(key);
    const b = new Date(a.getTime() + 6 * DAY_MS);
    const [ad, am, ay] = [a.getUTCDate(), a.getUTCMonth(), a.getUTCFullYear()];
    const [bd, bm, by] = [b.getUTCDate(), b.getUTCMonth(), b.getUTCFullYear()];
    if (ay !== by) return `${ad}. ${MONTHS[am]} ${ay} – ${bd}. ${MONTHS[bm]} ${by}`;
    if (am !== bm) return `${ad}. ${MONTHS[am]} – ${bd}. ${MONTHS[bm]} ${by}`;
    return `${ad}.–${bd}. ${MONTHS[bm]} ${by}`;
  };

  Logic.formatWeek = (key) => `KW ${Logic.weekNumber(key)} · ${Logic.formatRange(key)}`;

  // ---------- Daten ----------

  Logic.newId = function () {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  // Feste IDs und updatedAt 0: Eine frische Installation überschreibt beim Abgleich nie ein Backup.
  Logic.defaultState = function () {
    return {
      schemaVersion: SCHEMA_VERSION,
      template: {
        updatedAt: 0,
        categories: [{
          id: 'default-sport',
          name: 'Sport',
          items: [
            { id: 'default-fitness', name: 'Fitness', defaultGoal: '' },
            { id: 'default-gym', name: 'Gym', defaultGoal: '' },
          ],
        }],
      },
      weeks: {},
    };
  };

  Logic.isValidState = function (data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) return false;
    if (!data.template || !Array.isArray(data.template.categories)) return false;
    if (!data.weeks || typeof data.weeks !== 'object' || Array.isArray(data.weeks)) return false;
    return Object.keys(data.weeks).every((key) => (
      WEEK_KEY.test(key) && data.weeks[key] && Array.isArray(data.weeks[key].items)
    ));
  };

  function templateItems(state) {
    const items = [];
    state.template.categories.forEach((cat) => {
      cat.items.forEach((item) => { items.push({ ...item, category: cat.name }); });
    });
    return items;
  }

  function hasEntry(item) {
    return Boolean(item.goalEdited || item.done || item.achieved);
  }

  // Bringt eine Woche auf den Stand der Checkliste. Nur für die aktuelle Woche gedacht,
  // abgeschlossene Wochen werden nie angefasst. Liefert true, wenn sich etwas geändert hat.
  Logic.reconcileWeek = function (state, key) {
    const week = state.weeks[key];
    if (!week) return false;
    const before = JSON.stringify(week.items);
    const existing = new Map(week.items.map((item) => [item.id, item]));
    const next = templateItems(state).map((tpl) => {
      const item = existing.get(tpl.id);
      existing.delete(tpl.id);
      if (!item) {
        return {
          id: tpl.id, name: tpl.name, category: tpl.category, goal: tpl.defaultGoal || '',
          goalEdited: false, done: '', achieved: false,
        };
      }
      item.name = tpl.name;
      item.category = tpl.category;
      if (!item.goalEdited) item.goal = tpl.defaultGoal || '';
      return item;
    });
    // Gelöschte Punkte verschwinden nur, wenn diese Woche noch nichts eingetragen wurde.
    existing.forEach((item) => { if (hasEntry(item)) next.push(item); });
    week.items = next;
    return JSON.stringify(next) !== before;
  };

  Logic.createWeek = function (state, key, updatedAt) {
    state.weeks[key] = { key, updatedAt: updatedAt || 0, items: [] };
    Logic.reconcileWeek(state, key);
    return state.weeks[key];
  };

  // Legt die aktuelle Woche bei Bedarf an. updatedAt bleibt 0, bis du selbst etwas einträgst.
  Logic.ensureCurrentWeek = function (state) {
    const key = Logic.currentKey();
    if (!state.weeks[key]) Logic.createWeek(state, key, 0);
    else Logic.reconcileWeek(state, key);
    return key;
  };

  Logic.weekStats = function (week) {
    const total = week.items.length;
    const achieved = week.items.filter((item) => item.achieved).length;
    return { total, achieved, percent: total ? Math.round((achieved / total) * 100) : 0 };
  };

  Logic.listWeekKeys = function (state) {
    return Object.keys(state.weeks).sort().reverse();
  };

  // Pro Woche und für die Checkliste gewinnt die zuletzt geänderte Version.
  // Wochen fallen beim Zusammenführen nie weg.
  Logic.merge = function (local, remote) {
    const out = {
      schemaVersion: SCHEMA_VERSION,
      template: local.template.updatedAt > remote.template.updatedAt ? local.template : remote.template,
      weeks: {},
    };
    new Set([...Object.keys(local.weeks), ...Object.keys(remote.weeks)]).forEach((key) => {
      const a = local.weeks[key];
      const b = remote.weeks[key];
      if (!a) out.weeks[key] = b;
      else if (!b) out.weeks[key] = a;
      else out.weeks[key] = (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
    });
    const merged = JSON.parse(JSON.stringify(out));
    Logic.ensureCurrentWeek(merged);
    return merged;
  };

  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      const sorted = {};
      Object.keys(value).sort().forEach((key) => { sorted[key] = sortKeys(value[key]); });
      return sorted;
    }
    return value;
  }

  // Gleiche Daten ergeben immer denselben Text, unabhängig von der Reihenfolge der Felder.
  Logic.serialize = function (state, indent) {
    return JSON.stringify(sortKeys(state), null, indent);
  };

  root.Logic = Logic;
})(globalThis);

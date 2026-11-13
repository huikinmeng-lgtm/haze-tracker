/* Shared by the page (app.js) and the service worker (sw.js).
   Fetches NEA PSI / PM2.5 data from data.gov.sg, stores settings in IndexedDB
   and decides when to raise a threshold notification. */
(function (g) {
  'use strict';

  const API = 'https://api-open.data.gov.sg/v2/real-time/api';

  const REGIONS = [
    { id: 'national', label: 'National' },
    { id: 'north', label: 'North' },
    { id: 'west', label: 'West' },
    { id: 'central', label: 'Central' },
    { id: 'east', label: 'East' },
    { id: 'south', label: 'South' },
  ];

  const DEFAULTS = { region: 'national', threshold: 100, enabled: false, apiKey: '' };

  // NEA 24-hr PSI descriptors
  function psiBand(v) {
    if (typeof v !== 'number' || isNaN(v)) return { key: 'na', label: 'No data', color: '#7b8794' };
    if (v <= 50) return { key: 'good', label: 'Good', color: '#2a8f55' };
    if (v <= 100) return { key: 'moderate', label: 'Moderate', color: '#2f74c0' };
    if (v <= 200) return { key: 'unhealthy', label: 'Unhealthy', color: '#c76a0a' };
    if (v <= 300) return { key: 'very', label: 'Very unhealthy', color: '#c4312a' };
    return { key: 'hazardous', label: 'Hazardous', color: '#8a1c4b' };
  }

  // NEA 1-hr PM2.5 bands (ug/m3)
  function pmBand(v) {
    if (typeof v !== 'number' || isNaN(v)) return { key: 'na', label: 'No data', color: '#7b8794' };
    if (v <= 55) return { key: 'normal', label: 'Normal', color: '#2a8f55' };
    if (v <= 150) return { key: 'elevated', label: 'Elevated', color: '#c76a0a' };
    if (v <= 250) return { key: 'high', label: 'High', color: '#c4312a' };
    return { key: 'veryhigh', label: 'Very high', color: '#8a1c4b' };
  }

  /* ---------- tiny IndexedDB key/value store ---------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function kvGet(key, fallback) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = function () { resolve(r.result === undefined ? fallback : r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  async function kvSet(key, value) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function loadSettings() {
    const saved = await kvGet('settings', {});
    return Object.assign({}, DEFAULTS, saved);
  }
  function saveSettings(settings) { return kvSet('settings', settings); }

  /* ---------- NEA data ---------- */
  async function getJson(path, apiKey) {
    const headers = apiKey ? { 'x-api-key': apiKey } : {};
    const res = await fetch(API + '/' + path, { headers: headers, cache: 'no-store' });
    if (!res.ok) throw new Error('NEA API returned HTTP ' + res.status);
    const json = await res.json();
    if (json && json.errorMsg) throw new Error(String(json.errorMsg));
    return json;
  }

  // Pick the newest item and return { time, readings }. Accepts the v2 shape
  // ({ data: { items } }) and the older v1 shape ({ items }).
  function latestItem(json) {
    const root = (json && json.data) || json || {};
    const items = Array.isArray(root.items) ? root.items : [];
    if (!items.length) throw new Error('No readings in response');
    const item = items.reduce(function (a, b) {
      return new Date(b.timestamp || 0) > new Date(a.timestamp || 0) ? b : a;
    });
    return { time: item.timestamp || item.updatedTimestamp || null, readings: item.readings || {} };
  }

  function pickRegions(series) {
    const out = {};
    REGIONS.forEach(function (r) {
      const v = series && (series[r.id] !== undefined ? series[r.id] : series[r.id.toUpperCase()]);
      if (typeof v === 'number' && isFinite(v)) out[r.id] = v;
    });
    return out;
  }

  async function fetchReadings(apiKey) {
    const results = await Promise.allSettled([getJson('psi', apiKey), getJson('pm25', apiKey)]);
    if (results[0].status === 'rejected' && results[1].status === 'rejected') throw results[0].reason;

    const data = { fetchedAt: Date.now(), psiTime: null, pmTime: null, psi24: {}, pm1: {} };
    if (results[0].status === 'fulfilled') {
      const p = latestItem(results[0].value);
      data.psiTime = p.time;
      data.psi24 = pickRegions(p.readings.psi_twenty_four_hourly);
    }
    if (results[1].status === 'fulfilled') {
      const m = latestItem(results[1].value);
      data.pmTime = m.time;
      data.pm1 = pickRegions(m.readings.pm25_one_hourly);
    }
    if (!Object.keys(data.psi24).length && !Object.keys(data.pm1).length) {
      throw new Error('Unexpected response format from NEA API');
    }
    return data;
  }

  /* ---------- alerting ---------- */
  function regionLabel(id) {
    const r = REGIONS.filter(function (x) { return x.id === id; })[0];
    return r ? r.label : id;
  }

  // Notify only when the reading moves from below the threshold to at/above it.
  // The first evaluation after settings change just records the current state.
  async function processReadings(data, settings, registration) {
    if (!settings.enabled) return { notified: false };
    const value = data.psi24[settings.region];
    if (typeof value !== 'number') return { notified: false };

    const above = value >= settings.threshold;
    const state = await kvGet('alertState', null);
    const sameConfig = state && state.region === settings.region && state.threshold === settings.threshold;

    await kvSet('alertState', { region: settings.region, threshold: settings.threshold, above: above });

    if (!(sameConfig && state.above === false && above)) return { notified: false, above: above };
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return { notified: false, above: above };

    const reg = registration || (g.registration);
    if (!reg || !reg.showNotification) return { notified: false, above: above };

    const band = psiBand(value);
    await reg.showNotification('Haze alert: ' + regionLabel(settings.region) + ' PSI ' + value, {
      body: '24-hr PSI is ' + value + ' (' + band.label + '), at or above your threshold of ' + settings.threshold + '.',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: 'haze-threshold',
      renotify: true,
      data: { url: './' },
    });
    return { notified: true, above: above };
  }

  async function checkAndNotify(registration) {
    const settings = await loadSettings();
    if (!settings.enabled) return null;
    const data = await fetchReadings(settings.apiKey);
    await kvSet('latest', data);
    await processReadings(data, settings, registration);
    return data;
  }

  g.Haze = {
    REGIONS: REGIONS,
    DEFAULTS: DEFAULTS,
    psiBand: psiBand,
    pmBand: pmBand,
    regionLabel: regionLabel,
    kvGet: kvGet,
    kvSet: kvSet,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    fetchReadings: fetchReadings,
    latestItem: latestItem,
    processReadings: processReadings,
    checkAndNotify: checkAndNotify,
  };
})(typeof self !== 'undefined' ? self : globalThis);

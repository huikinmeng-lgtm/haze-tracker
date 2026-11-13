(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const REFRESH_MS = 5 * 60 * 1000;

  let settings = Object.assign({}, Haze.DEFAULTS);
  let latest = null;
  let errorMsg = '';
  let reg = null;
  let bgSync = false;
  let deferredPrompt = null;

  /* ---------- formatting ---------- */
  const timeFmt = new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const dayFmt = new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' });
  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : timeFmt.format(d);
  }
  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const sameDay = dayFmt.format(d) === dayFmt.format(new Date());
    return sameDay ? timeFmt.format(d) : dayFmt.format(d) + ', ' + timeFmt.format(d);
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '–'; }

  /* ---------- rendering ---------- */
  function cardHtml(region, hero) {
    const psi = latest && latest.psi24[region.id];
    const pm = latest && latest.pm1[region.id];
    const pb = Haze.psiBand(psi);
    const mb = Haze.pmBand(pm);
    const watching = settings.region === region.id;
    const tag = watching ? '<span class="watch">' + (settings.enabled ? 'Alert on' : 'Selected') + '</span>' : '';
    return (
      '<article class="card region' + (hero ? ' hero-card' : '') + (watching ? ' watching' : '') + '" style="--c:' + pb.color + '">' +
        '<div class="row"><h3>' + region.label + '</h3>' + tag + '</div>' +
        '<div class="metric">' +
          '<span class="big">' + num(psi) + '</span>' +
          '<span class="pill" style="--c:' + pb.color + '">' + pb.label + '</span>' +
        '</div>' +
        '<div class="cap">24-hr PSI</div>' +
        (region.id === 'national' && typeof pm !== 'number' ? '' :
          '<div class="pm" style="--c:' + mb.color + '">' +
            '<span class="cap">1-hr PM2.5</span>' +
            '<span><b>' + num(pm) + '</b> µg/m³ <span class="pill small" style="--c:' + mb.color + '">' + mb.label + '</span></span>' +
          '</div>') +
      '</article>'
    );
  }

  function render() {
    const regions = Haze.REGIONS;
    const national = regions.filter(function (r) { return r.id === 'national'; })[0];
    $('national').outerHTML = '<section id="national" aria-label="National readings">' + cardHtml(national, true) + '</section>';
    $('regions').innerHTML = regions.filter(function (r) { return r.id !== 'national'; })
      .map(function (r) { return cardHtml(r, false); }).join('');

    // header status line
    const upd = $('updated');
    if (latest) {
      const t = latest.psiTime || latest.pmTime;
      upd.textContent = (errorMsg ? 'Offline. Last reading ' : 'Updated ') + (t ? fmtStamp(t) : fmtStamp(latest.fetchedAt));
    } else {
      upd.textContent = errorMsg ? 'No data yet' : 'Loading…';
    }

    renderBanner();
    renderNotifStatus();
  }

  function renderBanner() {
    const b = $('banner');
    let text = '';
    let kind = '';
    const v = latest && latest.psi24[settings.region];
    if (errorMsg) {
      text = 'Could not reach the NEA data service (' + errorMsg + '). ' + (latest ? 'Showing the last reading.' : 'Pull to retry.');
      kind = 'error';
    } else if (settings.enabled && typeof v === 'number' && v >= settings.threshold) {
      text = Haze.regionLabel(settings.region) + ' 24-hr PSI is ' + Math.round(v) + ', at or above your threshold of ' + settings.threshold + '.';
      kind = 'warn';
    }
    b.hidden = !text;
    b.className = 'banner ' + kind;
    b.textContent = text;
  }

  function renderNotifStatus() {
    const el = $('notifStatus');
    if (typeof Notification === 'undefined') {
      el.textContent = isIos() && !isStandalone()
        ? 'On iPhone, add this app to your home screen first (iOS 16.4 or later), then turn alerts on.'
        : 'This browser cannot show notifications.';
      return;
    }
    if (Notification.permission === 'denied') {
      el.textContent = 'Notifications are blocked. Allow them for this app in your browser or phone settings, then switch alerts on again.';
      return;
    }
    if (!settings.enabled) { el.textContent = ''; return; }
    el.textContent = 'Watching ' + Haze.regionLabel(settings.region) + ' for 24-hr PSI of ' + settings.threshold + ' or more. ' +
      (bgSync
        ? 'Checked every few minutes while the app is open, and occasionally in the background.'
        : 'Checked every few minutes while the app is open. Keep it open (or in the background) to be alerted.');
  }

  /* ---------- data ---------- */
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    $('refresh').classList.add('spin');
    try {
      const data = await Haze.fetchReadings(settings.apiKey);
      latest = data;
      errorMsg = '';
      await Haze.kvSet('latest', data);
      if (settings.enabled) await Haze.processReadings(data, settings, reg);
    } catch (e) {
      errorMsg = (e && e.message) || 'network error';
    } finally {
      busy = false;
      $('refresh').classList.remove('spin');
      render();
    }
  }

  /* ---------- settings ---------- */
  function persist() { return Haze.saveSettings(settings); }

  async function setupBackground() {
    bgSync = false;
    if (!reg || !('periodicSync' in reg)) return;
    try {
      if (settings.enabled) {
        const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (st.state === 'granted') {
          await reg.periodicSync.register('haze-check', { minInterval: 15 * 60 * 1000 });
          bgSync = true;
        }
      } else {
        await reg.periodicSync.unregister('haze-check');
      }
    } catch (e) { /* unsupported or not permitted */ }
  }

  async function onEnabledChange() {
    const box = $('enabled');
    if (box.checked) {
      if (typeof Notification === 'undefined') { box.checked = false; renderNotifStatus(); return; }
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') { box.checked = false; settings.enabled = false; await persist(); render(); return; }
    }
    settings.enabled = box.checked;
    await persist();
    await setupBackground();
    await refresh();
  }

  async function onTestNotification() {
    if (typeof Notification === 'undefined') { renderNotifStatus(); return; }
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted' || !reg) { renderNotifStatus(); return; }
    await reg.showNotification('Haze Tracker test', {
      body: 'Notifications are working. You will be alerted when the PSI crosses your threshold.',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      tag: 'haze-test',
      data: { url: './' },
    });
  }

  function bindSettings() {
    const sel = $('region');
    Haze.REGIONS.forEach(function (r) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label;
      sel.appendChild(o);
    });
    sel.value = settings.region;
    $('threshold').value = settings.threshold;
    $('thresholdOut').textContent = settings.threshold;
    $('enabled').checked = settings.enabled;
    $('apiKey').value = settings.apiKey;

    sel.addEventListener('change', async function () {
      settings.region = sel.value;
      await persist();
      await refresh();
    });
    $('threshold').addEventListener('input', function (e) {
      $('thresholdOut').textContent = e.target.value;
    });
    $('threshold').addEventListener('change', async function (e) {
      settings.threshold = Number(e.target.value);
      await persist();
      await refresh();
    });
    $('enabled').addEventListener('change', onEnabledChange);
    $('apiKey').addEventListener('change', async function (e) {
      settings.apiKey = e.target.value.trim();
      await persist();
      await refresh();
    });
    $('testNotif').addEventListener('click', onTestNotification);
    $('refresh').addEventListener('click', refresh);
  }

  /* ---------- install ---------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

  function setupInstall() {
    if (isStandalone()) return;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      $('installText').textContent = 'Install Haze Tracker for quick access from your home screen.';
      $('installBtn').hidden = false;
      $('install').hidden = false;
    });
    window.addEventListener('appinstalled', function () { $('install').hidden = true; });
    $('installBtn').addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('install').hidden = true;
    });
    if (isIos()) {
      $('installText').textContent = 'Tap the Share button in Safari, then choose “Add to Home Screen”. Alerts on iPhone only work from the home screen app.';
      $('install').hidden = false;
    }
  }

  /* ---------- start ---------- */
  async function init() {
    try { settings = await Haze.loadSettings(); } catch (e) { /* use defaults */ }
    bindSettings();
    setupInstall();

    try { latest = await Haze.kvGet('latest', null); } catch (e) { /* ignore */ }
    render();

    // Register the service worker, but never let it hold up the first data fetch.
    let swSetup = Promise.resolve();
    if ('serviceWorker' in navigator) {
      swSetup = (async function () {
        try {
          await navigator.serviceWorker.register('sw.js');
          reg = await navigator.serviceWorker.ready;
          await setupBackground();
        } catch (e) { /* service worker unavailable (needs HTTPS) */ }
      })();
    }
    await Promise.race([swSetup, new Promise(function (r) { setTimeout(r, 1500); })]);

    await refresh();

    setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && (!latest || Date.now() - latest.fetchedAt > 2 * 60 * 1000)) refresh();
    });
  }

  init();
})();

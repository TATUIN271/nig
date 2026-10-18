// =============================================================
// WHOOP card on health.html — recovery, sleep and strain.
// Login + data go through the /api/whoop Vercel function (it holds
// the client secret). Tokens stay on this device only: the whoop_*
// keys are deliberately NOT in health's cloud-sync key list.
// =============================================================
(function () {
  'use strict';
  const API = '/api/whoop';
  const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
  const SCOPES = 'offline read:recovery read:cycles read:sleep';
  const TOKENS_KEY = 'whoop_tokens';
  const CACHE_KEY = 'whoop_cache';
  const STATE_KEY = 'whoop_oauth_state';
  const STALE_MS = 10 * 60 * 1000;
  const RING_LEN = 603.19;   // 2πr for r=96, matches the CSS dasharray
  const MIN_BASELINE = 3;    // days of history needed before zoning a metric

  const ZONE_COLORS = {
    green:  { hex: '#6BE3A4', rgb: '107, 227, 164' },
    yellow: { hex: '#F2C063', rgb: '242, 192, 99' },
    red:    { hex: '#FF6B6B', rgb: '255, 107, 107' },
  };

  const $ = (id) => document.getElementById(id);
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function setStatus(msg) { $('whoopAuthStatus').textContent = msg || ''; }
  function showConnected(on) {
    $('whoopDisconnected').style.display = on ? 'none' : '';
    $('whoopConnected').style.display = on ? '' : 'none';
  }

  // ---------- API + tokens ----------
  async function api(payload) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { status: r.status, ok: r.ok, data };
  }
  function storeTokens(t) {
    save(TOKENS_KEY, {
      access_token: t.access_token,
      refresh_token: t.refresh_token || null,
      expires_at: Date.now() + (t.expires_in || 3600) * 1000,
    });
  }
  // Returns fresh tokens, null if WHOOP rejected the refresh token
  // (user must reconnect), or throws on a network/server problem.
  async function refreshTokens(tokens) {
    if (!tokens || !tokens.refresh_token) return null;
    const r = await api({ action: 'refresh', refresh_token: tokens.refresh_token });
    if (r.ok && r.data && r.data.access_token) {
      // WHOOP rotates refresh tokens; keep the old one only if none came back.
      storeTokens(Object.assign({}, r.data, { refresh_token: r.data.refresh_token || tokens.refresh_token }));
      return load(TOKENS_KEY);
    }
    if (r.status === 400 || r.status === 401) return null;
    throw new Error('refresh_failed');
  }

  let inFlight = null;
  function loadData() {
    // One request at a time — two parallel refreshes would race on the
    // rotating refresh token and log the user out.
    if (!inFlight) inFlight = doLoad().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function doLoad() {
    $('whoopUpdated').textContent = 'loading…';
    try {
      let t = load(TOKENS_KEY);
      if (t && (!t.expires_at || Date.now() > t.expires_at - 60000)) t = await refreshTokens(t);
      if (!t) return lostConnection();
      let r = await api({ action: 'data', access_token: t.access_token });
      if (r.status === 401) {
        t = await refreshTokens(t);
        if (!t) return lostConnection();
        r = await api({ action: 'data', access_token: t.access_token });
      }
      if (!r.ok || !r.data) throw new Error('data_failed');
      const cache = { fetchedAt: Date.now(), data: r.data };
      save(CACHE_KEY, cache);
      render(cache);
    } catch (e) {
      const cache = load(CACHE_KEY);
      $('whoopUpdated').textContent = cache ? 'offline · ' + fmtTime(cache.fetchedAt) : 'couldn’t load';
    }
  }
  function lostConnection() {
    drop(TOKENS_KEY);
    drop(CACHE_KEY);
    showConnected(false);
    setStatus('Your WHOOP connection expired — connect again.');
  }

  // ---------- Login ----------
  async function connect() {
    setStatus('Opening WHOOP…');
    let cfg = null;
    try { cfg = await (await fetch(API)).json(); } catch (e) {}
    if (!cfg) { setStatus('WHOOP only works on the deployed site (it needs /api/whoop).'); return; }
    if (!cfg.configured) { setStatus('WHOOP isn’t set up yet — add the WHOOP_* environment variables in Vercel.'); return; }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem(STATE_KEY, state); } catch (e) {}
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: SCOPES,
      state,
    });
    location.href = AUTH_URL + '?' + params.toString();
  }
  async function finishLogin(code, state) {
    let expected = null;
    try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch (e) {}
    if (!expected || expected !== state) { setStatus('Sign-in check failed — try connecting again.'); return; }
    setStatus('Connecting…');
    try {
      const r = await api({ action: 'exchange', code });
      if (r.ok && r.data && r.data.access_token) { storeTokens(r.data); setStatus(''); }
      else setStatus('WHOOP sign-in failed — try again.');
    } catch (e) { setStatus('Network error — try again.'); }
  }
  function disconnect() {
    const t = load(TOKENS_KEY);
    drop(TOKENS_KEY);
    drop(CACHE_KEY);
    showConnected(false);
    setStatus('Disconnected.');
    if (t && t.access_token) api({ action: 'revoke', access_token: t.access_token }).catch(() => {});
  }

  // ---------- Formatting ----------
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(ms) {
    if (!ms && ms !== 0) return '—';
    const mins = Math.round(ms / 60000);
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function avg(values) {
    const v = values.map(num).filter((n) => n != null);
    return v.length >= MIN_BASELINE ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }
  function pct(a, b) { return Math.round((a / b - 1) * 100); }

  function recoveryZone(score) {
    if (score >= 67) return 'green';
    if (score >= 34) return 'yellow';
    return 'red';
  }
  function setZone(id, zone, title) {
    const el = $(id);
    el.className = 'whoop-zone' + (zone ? ' z-' + zone : '');
    el.title = title || '';
  }

  // ---------- Render ----------
  function render(cache) {
    const d = (cache && cache.data) || {};
    const recs = (d.recovery || []).filter((x) => x && x.score_state === 'SCORED' && x.score);
    const sleeps = (d.sleep || []).filter((x) => x && x.score_state === 'SCORED' && x.score && !x.nap);
    const rec = recs[0] ? recs[0].score : null;
    const sl = sleeps[0] ? sleeps[0].score : null;
    const cyc = (d.cycle || [])[0];
    const strain = cyc && cyc.score ? num(cyc.score.strain) : null;

    $('whoopUpdated').textContent = 'updated ' + fmtTime(cache.fetchedAt);
    $('whoopCalibrating').style.display = rec && rec.user_calibrating ? '' : 'none';

    // Recovery ring
    const score = rec ? num(rec.recovery_score) : null;
    const zone = score != null ? recoveryZone(score) : null;
    const fill = $('whoopRecoveryRingFill');
    $('whoopRecoveryScore').textContent = score != null ? Math.round(score) + '%' : '—';
    if (zone) {
      const c = ZONE_COLORS[zone];
      fill.style.stroke = c.hex;
      fill.style.filter = 'drop-shadow(0 0 10px rgba(' + c.rgb + ', 0.45))';
      fill.style.strokeDashoffset = String(RING_LEN * (1 - Math.max(0, Math.min(100, score)) / 100));
      $('whoopRecoveryLabel').textContent =
        zone === 'green' ? 'Green · ready to perform' :
        zone === 'yellow' ? 'Yellow · maintain' : 'Red · recover';
      $('whoopRecoveryLabel').style.color = c.hex;
    } else {
      fill.style.strokeDashoffset = String(RING_LEN);
      $('whoopRecoveryLabel').textContent = 'No scored recovery yet';
      $('whoopRecoveryLabel').style.color = '';
    }

    // Baselines from the previous days (today excluded)
    const hrv = rec ? num(rec.hrv_rmssd_milli) : null;
    const rhr = rec ? num(rec.resting_heart_rate) : null;
    const skin = rec ? num(rec.skin_temp_celsius) : null;
    const spo2 = rec ? num(rec.spo2_percentage) : null;
    const resp = sl ? num(sl.respiratory_rate) : null;
    const hrvBase = avg(recs.slice(1).map((r) => r.score.hrv_rmssd_milli));
    const rhrBase = avg(recs.slice(1).map((r) => r.score.resting_heart_rate));
    const skinBase = avg(recs.slice(1).map((r) => r.score.skin_temp_celsius));
    const respBase = avg(sleeps.slice(1).map((s) => s.score.respiratory_rate));

    // Sleep stages
    const st = sl && sl.stage_summary;
    let asleep = null;
    if (st) {
      const rem = st.total_rem_sleep_time_milli || 0;
      const deep = st.total_slow_wave_sleep_time_milli || 0;
      const light = st.total_light_sleep_time_milli || 0;
      const awake = st.total_awake_time_milli || 0;
      const total = rem + deep + light + awake;
      asleep = rem + deep + light;
      if (total > 0) {
        $('whoopStageRem').style.width = (rem / total * 100) + '%';
        $('whoopStageDeep').style.width = (deep / total * 100) + '%';
        $('whoopStageLight').style.width = (light / total * 100) + '%';
        $('whoopStageAwake').style.width = (awake / total * 100) + '%';
        $('whoopStageRemTxt').textContent = fmtDur(rem);
        $('whoopStageDeepTxt').textContent = fmtDur(deep);
        $('whoopStageLightTxt').textContent = fmtDur(light);
        $('whoopStageAwakeTxt').textContent = fmtDur(awake);
        $('whoopStagesMeta').textContent = fmtDur(total) + ' in bed';
        $('whoopStages').style.display = '';
      } else {
        $('whoopStages').style.display = 'none';
      }
    } else {
      $('whoopStages').style.display = 'none';
    }

    // Stats grid
    const perf = sl ? num(sl.sleep_performance_percentage) : null;
    $('whoopSleepScore').textContent = perf != null ? Math.round(perf) + '%' : '—';
    $('whoopSleepDuration').textContent = asleep != null ? fmtDur(asleep) : '—';
    setZone('whoopZoneSleep',
      perf == null ? '' : perf >= 85 ? 'good' : perf >= 70 ? 'norm' : perf >= 50 ? 'warn' : 'bad',
      perf != null ? 'Sleep performance ' + Math.round(perf) + '%' : '');

    $('whoopStrain').textContent = strain != null ? strain.toFixed(1) : '—';
    $('whoopStrainDay').textContent = cyc && cyc.end ? 'last cycle' : 'today';
    setZone('whoopZoneStrain',
      strain == null ? '' : (strain >= 18 || (zone === 'red' && strain >= 10)) ? 'warn' : 'norm',
      strain != null ? 'Day strain ' + strain.toFixed(1) + ' / 21' : '');

    $('whoopHrv').textContent = hrv != null ? Math.round(hrv) : '—';
    setZone('whoopZoneHrv',
      hrv == null || hrvBase == null ? '' :
      hrv >= hrvBase * 1.05 ? 'good' : hrv >= hrvBase * 0.9 ? 'norm' : hrv >= hrvBase * 0.8 ? 'warn' : 'bad',
      hrvBase != null && hrv != null ? Math.round(hrv) + ' ms vs ' + Math.round(hrvBase) + ' ms recent average' : '');

    $('whoopRhr').textContent = rhr != null ? Math.round(rhr) : '—';
    setZone('whoopZoneRhr',
      rhr == null || rhrBase == null ? '' :
      rhr <= rhrBase - 2 ? 'good' : rhr <= rhrBase + 2 ? 'norm' : rhr <= rhrBase + 5 ? 'warn' : 'bad',
      rhrBase != null && rhr != null ? Math.round(rhr) + ' bpm vs ' + Math.round(rhrBase) + ' bpm recent average' : '');

    // Biomarker strip
    $('whoopSkinTemp').textContent = skin != null ? skin.toFixed(1) + '°C' : '—';
    const skinDelta = skin != null && skinBase != null ? skin - skinBase : null;
    setZone('whoopZoneSkin',
      skinDelta == null ? '' : Math.abs(skinDelta) < 0.5 ? 'norm' : Math.abs(skinDelta) < 1 ? 'warn' : 'bad',
      skinDelta != null ? (skinDelta >= 0 ? '+' : '') + skinDelta.toFixed(1) + '°C vs recent average' : '');

    $('whoopSpo2').textContent = spo2 != null ? spo2.toFixed(1) + '%' : '—';
    setZone('whoopZoneSpo2',
      spo2 == null ? '' : spo2 >= 95 ? 'good' : spo2 >= 92 ? 'norm' : spo2 >= 90 ? 'warn' : 'bad', '');

    $('whoopResp').textContent = resp != null ? resp.toFixed(1) + ' rpm' : '—';
    const respDelta = resp != null && respBase != null ? resp - respBase : null;
    setZone('whoopZoneResp',
      respDelta == null ? '' : Math.abs(respDelta) < 1 ? 'norm' : Math.abs(respDelta) < 2 ? 'warn' : 'bad',
      respDelta != null ? (respDelta >= 0 ? '+' : '') + respDelta.toFixed(1) + ' rpm vs recent average' : '');

    $('whoopBio').style.display = skin != null || spo2 != null || resp != null ? '' : 'none';

    renderVerdict(zone, { hrv, hrvBase, rhr, rhrBase, perf, asleep, need: sleepNeed(sl), skinDelta });
  }

  function sleepNeed(sl) {
    const n = sl && sl.sleep_needed;
    if (!n) return null;
    return (n.baseline_milli || 0) + (n.need_from_sleep_debt_milli || 0) +
      (n.need_from_recent_strain_milli || 0) + (n.need_from_recent_nap_milli || 0);
  }

  function renderVerdict(zone, m) {
    if (!zone) { $('whoopVerdict').style.display = 'none'; return; }
    const c = ZONE_COLORS[zone];
    const badge = $('whoopVerdictBadge');
    badge.textContent = zone === 'green' ? 'Push' : zone === 'yellow' ? 'Moderate' : 'Recover';
    badge.style.color = c.hex;
    badge.style.background = 'rgba(' + c.rgb + ', 0.12)';
    badge.style.borderColor = 'rgba(' + c.rgb + ', 0.40)';
    $('whoopVerdictHeadline').textContent =
      zone === 'green' ? 'Well recovered — a good day for hard training.' :
      zone === 'yellow' ? 'Partly recovered — train, but keep the intensity moderate.' :
      'Low recovery — keep today light and prioritise sleep tonight.';

    const reasons = [];
    if (m.hrv != null && m.hrvBase != null) {
      const p = pct(m.hrv, m.hrvBase);
      reasons.push('HRV ' + Math.round(m.hrv) + ' ms — ' + (p === 0 ? 'right on' : Math.abs(p) + '% ' + (p > 0 ? 'above' : 'below')) + ' your recent average.');
    }
    if (m.rhr != null && m.rhrBase != null) {
      const diff = Math.round(m.rhr - m.rhrBase);
      reasons.push('Resting HR ' + Math.round(m.rhr) + ' bpm — ' + (diff === 0 ? 'same as' : Math.abs(diff) + ' bpm ' + (diff > 0 ? 'above' : 'below')) + ' usual.');
    }
    if (m.asleep != null) {
      reasons.push('Slept ' + fmtDur(m.asleep) + (m.need ? ' of ' + fmtDur(m.need) + ' needed' : '') +
        (m.perf != null ? ' (' + Math.round(m.perf) + '% sleep performance).' : '.'));
    }
    if (m.skinDelta != null && Math.abs(m.skinDelta) >= 0.5) {
      reasons.push('Skin temperature ' + (m.skinDelta > 0 ? 'up' : 'down') + ' ' + Math.abs(m.skinDelta).toFixed(1) + '°C — worth watching if you feel run down.');
    }
    const box = $('whoopVerdictReasons');
    box.textContent = '';
    reasons.forEach((r) => {
      const div = document.createElement('div');
      div.textContent = '· ' + r;
      box.appendChild(div);
    });

    const avoid =
      zone === 'yellow' ? 'max-effort lifts and PR attempts.' :
      zone === 'red' ? 'hard training, alcohol and late caffeine.' : '';
    $('whoopVerdictAvoidText').textContent = avoid;
    $('whoopVerdictAvoid').style.display = avoid ? '' : 'none';
    $('whoopVerdict').style.display = '';
  }

  // ---------- Boot ----------
  async function init() {
    if (!$('whoopConnected')) return;
    $('whoopConnectBtn').addEventListener('click', connect);
    $('whoopRefreshBtn').addEventListener('click', () => loadData());
    $('whoopDisconnectBtn').addEventListener('click', disconnect);

    // Back from WHOOP's login page: strip ?code/state from the URL first so
    // a reload can't replay a one-time code.
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (code || error) history.replaceState(null, '', location.pathname + location.hash);
    if (error) setStatus('WHOOP sign-in was cancelled.');
    if (code) await finishLogin(code, params.get('state'));

    if (!load(TOKENS_KEY)) { showConnected(false); return; }
    showConnected(true);
    const cache = load(CACHE_KEY);
    if (cache) render(cache);
    if (!cache || Date.now() - cache.fetchedAt > STALE_MS) loadData();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !load(TOKENS_KEY)) return;
      const c = load(CACHE_KEY);
      if (!c || Date.now() - c.fetchedAt > STALE_MS) loadData();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

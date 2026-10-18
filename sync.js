// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// Stores the page's localStorage keys as one JSONB row in the
// public.app_state table (keyed by appKey) and listens on the
// Supabase realtime channel so other devices update within ~1s.
// Several pages may share one appKey (health + po-water): each
// push merges into the existing row instead of replacing it.
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://usfmbeerdaqrlvjwrlah.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_gbl3qEWjQGKh04vpyF95Mw_CAq_Al-U';

  // Postgres JSONB reorders object keys, so compare values with
  // sorted keys — otherwise our own echo looks like a remote change.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function parse(raw) {
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  // For pages that keep state in memory and don't re-render on
  // 'storage' events: reload so the page picks up the remote data.
  // Rate-limited so a page that rewrites its keys on load can't loop.
  window.cloudSyncReload = function () {
    try {
      const last = +sessionStorage.getItem('sync:reloadAt') || 0;
      if (Date.now() - last < 10000) return;
      sessionStorage.setItem('sync:reloadAt', String(Date.now()));
    } catch (e) { return; }
    location.reload();
  };

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, ready = false, pendingPush = false;
    let lastSyncedJson = null;   // stable() of the full row we last saw or wrote
    let remoteData = {};         // full row data, incl. keys owned by other pages

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v != null) out[k] = parse(v);
      }
      return out;
    }
    // Keep keys this page doesn't own, replace the ones it does.
    function mergeInto(base) {
      const out = {};
      for (const k of Object.keys(base || {})) if (!matches(k)) out[k] = base[k];
      return Object.assign(out, collect());
    }

    // Hook on the prototype — assigning localStorage.setItem directly
    // can just store an item named "setItem" in some browsers.
    const proto = Storage.prototype;
    const origSet = proto.setItem, origRemove = proto.removeItem;
    proto.setItem = function (k, v) {
      origSet.call(this, k, v);
      try { if (this === localStorage && !suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    proto.removeItem = function (k) {
      origRemove.call(this, k);
      try { if (this === localStorage && !suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      remoteData = remote;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const local = localStorage.getItem(k);
          if (local == null || stable(parse(local)) !== stable(remote[k])) {
            try { origSet.call(localStorage, k, JSON.stringify(remote[k])); changed = true; } catch (e) {}
          }
        }
        // Drop local prefixed keys the other device deleted — but only
        // when the row already tracks that prefix, so a row written by
        // another page (or before this page synced) can't wipe local data.
        const remoteKeys = Object.keys(remote);
        for (const k of listAllKeys()) {
          if (k in remote) continue;
          const prefix = syncedPrefixes.find(p => k.indexOf(p) === 0);
          if (prefix && remoteKeys.some(r => r.indexOf(prefix) === 0)) {
            try { origRemove.call(localStorage, k); changed = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      try {
        // Re-read the row so keys written by other pages since our
        // last look (e.g. topbar water +1) aren't overwritten.
        const { data, error: readErr } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!readErr && data && data.data) remoteData = data.data;
      } catch (e) {}
      const state = mergeInto(remoteData);
      const json = stable(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { lastSyncedJson = json; remoteData = state; }
      } catch (e) {}
    }
    function schedulePush() {
      if (!ready) { pendingPush = true; return; }
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      if (!ready) return;
      const state = mergeInto(remoteData);
      const json = stable(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data) {
          lastSyncedJson = stable(data.data);
          applyRemote(data.data);
        }
      } catch (e) {}
      ready = true;
      // Upload anything stored locally that the row doesn't have yet
      // (first use on this device, or keys the row never held).
      if (stable(mergeInto(remoteData)) !== lastSyncedJson) pendingPush = true;
      if (pendingPush) { pendingPush = false; schedulePush(); }
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = stable(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();

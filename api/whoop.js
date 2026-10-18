// =============================================================
// WHOOP proxy (Vercel serverless function at /api/whoop).
// WHOOP's token endpoint needs the client secret, so the login
// exchange and token refresh happen here. Data calls go through
// here too, to avoid browser CORS issues with the WHOOP API.
//
// Set these in Vercel → Project → Settings → Environment Variables:
//   WHOOP_CLIENT_ID      from developer.whoop.com
//   WHOOP_CLIENT_SECRET  from developer.whoop.com
//   WHOOP_REDIRECT_URI   e.g. https://your-site.vercel.app/health.html
// =============================================================
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer/v2';

function config() {
  return {
    clientId: process.env.WHOOP_CLIENT_ID || '',
    clientSecret: process.env.WHOOP_CLIENT_SECRET || '',
    redirectUri: process.env.WHOOP_REDIRECT_URI || '',
  };
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = config();
  const body = new URLSearchParams(Object.assign({}, params, {
    client_id: clientId,
    client_secret: clientSecret,
  }));
  const r = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    return { status: r.ok ? 502 : r.status, body: { error: 'token_failed' } };
  }
  return {
    status: 200,
    body: {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_in: data.expires_in || 3600,
    },
  };
}

async function whoopGet(path, accessToken) {
  const r = await fetch(WHOOP_API + path, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (r.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  if (!r.ok) { const e = new Error('whoop_error'); e.status = 502; throw e; }
  return r.json();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { clientId, clientSecret, redirectUri } = config();

  // GET → public config the page needs to start the login.
  if (req.method === 'GET') {
    return res.status(200).json({
      configured: Boolean(clientId && clientSecret && redirectUri),
      clientId,
      redirectUri,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(503).json({ error: 'not_configured' });
  }

  const body = req.body || {};
  const action = body.action;
  try {
    if (action === 'exchange') {
      if (typeof body.code !== 'string' || !body.code) return res.status(400).json({ error: 'missing_code' });
      const out = await tokenRequest({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: redirectUri,
      });
      return res.status(out.status).json(out.body);
    }

    if (action === 'refresh') {
      if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
        return res.status(400).json({ error: 'missing_refresh_token' });
      }
      const out = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        scope: 'offline',
      });
      return res.status(out.status).json(out.body);
    }

    if (action === 'data') {
      if (typeof body.access_token !== 'string' || !body.access_token) {
        return res.status(400).json({ error: 'missing_access_token' });
      }
      // 14 days of recovery + sleep gives a personal baseline for the zones.
      const [recovery, sleep, cycle] = await Promise.all([
        whoopGet('/recovery?limit=14', body.access_token),
        whoopGet('/activity/sleep?limit=14', body.access_token),
        whoopGet('/cycle?limit=1', body.access_token),
      ]);
      return res.status(200).json({
        recovery: recovery.records || [],
        sleep: sleep.records || [],
        cycle: cycle.records || [],
      });
    }

    if (action === 'revoke') {
      if (typeof body.access_token === 'string' && body.access_token) {
        await fetch(WHOOP_API + '/user/access', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + body.access_token },
        }).catch(() => {});
      }
      return res.status(204).end();
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'server_error' });
  }
};

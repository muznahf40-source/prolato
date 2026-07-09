const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('kv_store table ready');
}
ensureTable().catch(err => {
  console.error('Failed to initialize database. Check DATABASE_URL.', err);
});

/* ---------------- Key-value storage API (unchanged) ---------------- */
app.get('/api/kv/:key', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [req.params.key]);
    res.json({ value: rows.length ? rows[0].value : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.post('/api/kv/:key', async (req, res) => {
  try {
    const { value } = req.body;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string (JSON.stringify it client-side)' });
    }
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---------------- Microsoft (Outlook / Entra ID) sign-in ---------------- */
// Required environment variables:
//   MS_CLIENT_ID     - the "Application (client) ID" from your Azure app registration
//   MS_CLIENT_SECRET - a client secret value created for that app registration
//   MS_TENANT        - your organization's "Directory (tenant) ID" (restricts sign-in
//                      to your Prolato accounts only). Use "common" only for testing —
//                      it would allow ANY Microsoft/Outlook account to sign in.
//   SESSION_SECRET   - any long random string, used to sign the session cookie
//   APP_URL          - optional; your Render URL (e.g. https://your-app.onrender.com).
//                      If unset, it's inferred from the incoming request.
const MS_CLIENT_ID = process.env.MS_CLIENT_ID;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const MS_TENANT = process.env.MS_TENANT || 'common';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const isProd = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

function getRedirectUri(req) {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/callback`;
}

app.get('/auth/login', (req, res) => {
  if (!MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    return res.status(500).send('Microsoft sign-in is not configured yet. Set MS_CLIENT_ID and MS_CLIENT_SECRET in Render.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 5 * 60 * 1000 });
  const redirectUri = getRedirectUri(req);
  const authUrl = `https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT)}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: MS_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state
    }).toString();
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`Sign-in failed: ${error_description || error}`);
  }
  if (!code || !state || state !== req.cookies.oauth_state) {
    return res.status(400).send('Sign-in failed: invalid or expired login attempt. Please try again from the tracker.');
  }
  try {
    const redirectUri = getRedirectUri(req);
    const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        client_secret: MS_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        scope: 'openid profile email User.Read'
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token exchange failed', tokenData);
      return res.status(500).send('Sign-in failed while contacting Microsoft. Please try again.');
    }

    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const me = await meRes.json();
    const email = me.mail || me.userPrincipalName;
    const name = me.displayName || email;
    if (!email) {
      return res.status(500).send('Signed in, but Microsoft did not return an email address for this account.');
    }

    const sessionToken = jwt.sign({ email, name }, SESSION_SECRET, { expiresIn: '30d' });
    res.cookie('session', sessionToken, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.clearCookie('oauth_state');
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('Sign-in failed. Please try again.');
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.session;
  if (!token) return res.json({ user: null });
  try {
    const data = jwt.verify(token, SESSION_SECRET);
    res.json({ user: { email: data.email, name: data.name } });
  } catch (e) {
    res.json({ user: null });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Prolato Outreach Pipeline server running on port ${PORT}`));

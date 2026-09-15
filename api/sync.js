// api/sync.js
// Reads and writes files in the same shared Drive folder the app has always used — just
// through the service account instead of whichever person's personal Google session was
// active. Folder ID copied directly from the existing client-side sync code
// (SHARED_DRIVE_FOLDER_ID in index.html) so this targets the exact same folder, not a new one.
//
// Handles three different files by name, not just the main one — the frontend also keeps
// chat photos and an archive in two separate files in this same folder (see
// PHOTOS_FILE_NAME/ARCHIVE_FILE_NAME in index.html), both read/written through this same
// endpoint via the ?file= query param (GET) or file body field (POST). Defaults to the main
// data file when omitted, so the primary sync call site doesn't need to specify anything.
//
// *** REWRITTEN to drop the `googleapis` npm package ***
// This was the ONLY api/*.js file in this project importing it, and it was the direct cause
// of persistent "Sync timed out" errors: `googleapis` is a huge meta-package, and parsing it
// on a cold Vercel function start can eat several seconds on its own (Vercel's own guidance:
// "large dependencies... parsing and evaluating JavaScript code can take 3-5 seconds or
// longer" — vercel.com/guides/how-can-i-improve-serverless-function-lambda-cold-start-
// performance-on-vercel). check-reminders.js already proved raw REST calls + a hand-signed
// service-account JWT talk to Drive just fine without it, so that's the pattern here too —
// same external behavior (request/response shapes below are byte-for-byte unchanged, so
// nothing on the client needs to know this changed), just a much lighter dependency footprint.
//
// The token-verification logic below is intentionally duplicated from api/auth.js rather
// than imported from a shared api/_lib/session.js file — an earlier version shared it via
// that file, but Vercel's deployment bundle wasn't picking it up (ERR_MODULE_NOT_FOUND at
// runtime despite the file existing in the repo). Duplicating ~25 lines across two small
// functions is a reasonable trade to sidestep that entire class of deploy issue. If either
// file's session logic ever needs to change, remember to update both copies.
//
// Required env vars (already present if the Vercel dashboard already lists them — this app
// likely already had these for another purpose):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   SESSION_SECRET   — same value as api/auth.js uses to sign tokens; this file only verifies.
//
// One-time manual setup step, separate from env vars: the service account is its own distinct
// Google identity, so it needs to be individually invited to the Drive folder — open the
// "Olympus CA Tracker" folder in Drive → Share → paste GOOGLE_SERVICE_ACCOUNT_EMAIL's address
// → Editor. Skipping this means every request below fails with a 404/403 from Drive, not
// because the code is wrong but because the service account genuinely can't see the folder yet.
//
// No third-party Drive package needed — just built-in fetch and crypto.
//
// Auth: every request needs `Authorization: Bearer <token>` from a prior /api/auth call.
// GET  /api/sync?file=<name>  → 200 { data: <JSON, or null if the file doesn't exist yet>, modifiedTime }
// POST /api/sync              → body { file?: <name>, payload: <JSON to save> }; 200 { ok: true }
//   (file defaults to the main data file on both GET and POST when omitted)

import { createHmac, timingSafeEqual, createSign } from 'crypto';

const FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s';
const DEFAULT_FILE_NAME = 'olympus-data.json';

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Returns 'umang' | 'chetna' if the token is validly signed and unexpired, otherwise null —
// the entire access-control boundary for this endpoint. Every failure mode (bad format, bad
// signature, expired, unrecognized profile) returns the same null rather than a specific
// reason, so a caller probing the endpoint can't learn which part failed.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  let payload;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  if (!safeEqual(signature, sign(payload))) return null;
  const [profile, expiresAtStr] = payload.split('.');
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (profile !== 'umang' && profile !== 'chetna') return null;
  return profile;
}

// ── Service-account auth + raw Drive REST calls (same pattern as check-reminders.js) ──────
function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getServiceAccountAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Vercel env vars are single-line — the PEM key's real newlines get stored as the literal
  // two characters "\n", which need converting back before the key will parse.
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  if (!email || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set correctly');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).access_token;
}

async function findFile(accessToken, fileName) {
  const q = encodeURIComponent(`name='${fileName}' and '${FOLDER_ID}' in parents and trashed=false`);
  // orderBy is the important part here, not just a nicety: if a same-named file was ever
  // accidentally duplicated (e.g. two POSTs racing to create it the very first time, before
  // either had seen the other exist), Drive's list order for otherwise-tied files isn't
  // guaranteed to put the newest one first. Without this, findFile() could nondeterministically
  // return whichever copy Drive feels like on a given call — meaning reads AND writes silently
  // flip between the two files from request to request, which looks exactly like "data
  // randomly reverts, unrelated to anything I tapped." Sorting newest-first means every call
  // consistently resolves to the most-recently-written copy even if a duplicate exists.
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent('files(id,name,modifiedTime)')}&orderBy=modifiedTime%20desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  const { files } = await resp.json();
  if (files && files.length > 1) {
    // Not fatal — we still proceed with the newest one — but worth surfacing loudly, since
    // this means a duplicate exists and should be cleaned up by hand in Drive (the extra
    // file is dead weight that can only cause confusion, never gets read once this sorting
    // is in place, but isn't automatically deleted here to avoid destroying data on a guess).
    console.warn(`Found ${files.length} files named '${fileName}' in the shared folder — using the most recently modified one (${files[0].modifiedTime}). Consider deleting the older duplicate(s) manually.`);
  }
  return (files && files[0]) || null;
}

async function readFileContent(accessToken, fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  return resp.text();
}

async function updateFileContent(accessToken, fileId, jsonString) {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: jsonString,
    }
  );
  if (!resp.ok) throw new Error(`Drive write failed: ${resp.status} ${await resp.text()}`);
}

// Only reachable the first time a file (main data / photos / archive) is ever written — needs
// a multipart body since, unlike an update, a brand-new file has to set its name and parent
// folder (metadata) AND its content in the same request.
async function createFile(accessToken, fileName, jsonString) {
  const boundary = `olympus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: fileName, parents: [FOLDER_ID] });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n${jsonString}\r\n` +
    `--${boundary}--`;
  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!resp.ok) throw new Error(`Drive create failed: ${resp.status} ${await resp.text()}`);
}

// Only letters, digits, dots, hyphens, underscores — every filename this endpoint actually
// uses (olympus-data.json, olympus-chat-photos.json, olympus-archive.json) fits this, and it
// keeps an arbitrary ?file= value from being usable to inject anything into the Drive query
// string built above.
function isValidFileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name);
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const profile = verifyToken(token);
  if (!profile) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  let accessToken;
  try {
    accessToken = await getServiceAccountAccessToken();
  } catch (err) {
    console.error('Service account credentials not configured correctly:', err);
    res.status(500).json({ error: 'Server misconfigured — check GOOGLE_SERVICE_ACCOUNT_* env vars' });
    return;
  }

  if (req.method === 'GET') {
    const fileName = req.query && req.query.file ? req.query.file : DEFAULT_FILE_NAME;
    if (!isValidFileName(fileName)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    try {
      const existing = await findFile(accessToken, fileName);
      if (!existing) {
        res.status(200).json({ data: null, modifiedTime: null });
        return;
      }
      const raw = await readFileContent(accessToken, existing.id);
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error('Shared file content was not valid JSON:', e);
        res.status(500).json({ error: 'Shared data file is corrupted' });
        return;
      }
      res.status(200).json({ data, modifiedTime: existing.modifiedTime });
    } catch (err) {
      console.error('sync GET failed:', err);
      res.status(500).json({ error: 'Failed to read shared data' });
    }
    return;
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const fileName = body.file || DEFAULT_FILE_NAME;
    const payload = body.payload;
    if (!isValidFileName(fileName)) {
      res.status(400).json({ error: 'Invalid file name' });
      return;
    }
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Missing or invalid payload' });
      return;
    }
    try {
      const existing = await findFile(accessToken, fileName);
      const jsonString = JSON.stringify(payload);
      if (existing) {
        await updateFileContent(accessToken, existing.id, jsonString);
      } else {
        // Only reachable if the file genuinely doesn't exist yet — for the main data file,
        // if this fires on what should already exist, it almost always means the Drive-
        // sharing setup step above wasn't done. For the photos/archive files, it's normal
        // the first time either feature is ever used.
        await createFile(accessToken, fileName, jsonString);
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('sync POST failed:', err);
      res.status(500).json({ error: 'Failed to save shared data' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

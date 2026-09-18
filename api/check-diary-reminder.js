// api/check-diary-reminder.js
// Fires once a day, timed for ~midnight IST — "fill in today's diary before you sleep."
// Also checks yesterday's diary, so a backlog of more than one unfilled day gets called out
// explicitly rather than only ever nagging about the most recent one. This is a genuinely
// separate cron from check-reminders.js (which runs once daily too, but at 9 PM IST, and
// covers different reasons) rather than folded into it, since Vercel Hobby allows up to 2
// cron jobs — see vercel.json — so there's room for a second, differently-timed one instead
// of forcing everything onto one schedule.
//
// "Filled" here means the SAME thing index.html's diaryDayStatus() calls 'closed' — the
// Close Day flow actually completed (diaryReflections[profileId][date].closedAt is set), not
// just some text typed in. A day with content but never closed out still counts as
// not-filled, matching how the client-side in-app banner (computeNotifications() in
// index.html) treats it — this endpoint is the "even if the app was never opened that day"
// backstop for the same requirement, not a separate/looser one.
//
// Same shared Drive file, same service-account auth, same raw-fetch + hand-signed JWT
// pattern as check-reminders.js and check-habit-time-reminders.js (no `googleapis` package —
// see sync.js's header comment for why that one got rewritten to drop it). Read-only: this
// endpoint never writes back to Drive, so there's no re-fetch-before-write dance needed here.
import crypto from 'crypto';
import webpush from 'web-push';

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const DRIVE_FOLDER_ID = '1Wr2t2KJUw5vEi0Vbi2290m09kacBdM0s'; // "Olympus CA Tracker"
const DATA_FILE_NAME = 'olympus-data.json';
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const PROFILE_IDS = ['umang', 'chetna'];

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same 5 AM→4:59 AM study-day boundary as index.html's todayStr(). At a hair past real
// midnight (when this cron is actually timed to fire), that boundary hasn't rolled over yet
// — so this correctly still resolves to the day that's ending, i.e. exactly the day someone
// should be closing out before bed, not a "new" day that just started.
function todayStrIST(nowUtc) {
  nowUtc = nowUtc || new Date();
  const shifted = new Date(nowUtc.getTime() + IST_OFFSET_MINUTES * 60000);
  if (shifted.getUTCHours() < 5) shifted.setUTCDate(shifted.getUTCDate() - 1);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function isDiaryClosed(data, profileId, dateStr) {
  const entry = data.diaryReflections && data.diaryReflections[profileId] && data.diaryReflections[profileId][dateStr];
  return !!(entry && entry.closedAt);
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET is not set on the server' });
    return;
  }
  if (!safeEqual(req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = { today: null, yesterday: null, sent: [], skipped: [], errors: [] };
  try {
    const today = todayStrIST();
    const yesterday = addDaysStr(today, -1);
    result.today = today;
    result.yesterday = yesterday;

    const accessToken = await getServiceAccountAccessToken();
    const fileId = await findDataFileId(accessToken);
    const data = await downloadData(accessToken, fileId);

    if (!data || typeof data !== 'object' || !data.logs) {
      throw new Error('Downloaded file did not look like valid Olympus data — aborting.');
    }
    const pushSubscriptions = data.pushSubscriptions || {};
    const pushPrefs = data.pushPrefs || {};

    for (const profileId of PROFILE_IDS) {
      if (pushPrefs[profileId] && pushPrefs[profileId].diaryReminder === false) {
        result.skipped.push({ profileId, reason: 'diaryReminder push type disabled' });
        continue;
      }
      const subscription = pushSubscriptions[profileId];
      if (!subscription) {
        result.skipped.push({ profileId, reason: 'not subscribed' });
        continue;
      }
      const todayDone = isDiaryClosed(data, profileId, today);
      const yestDone = isDiaryClosed(data, profileId, yesterday);
      if (todayDone && yestDone) {
        result.skipped.push({ profileId, reason: 'already filled' });
        continue;
      }
      const title = !todayDone && !yestDone
        ? '📔 Diary not filled for today or yesterday'
        : !todayDone
          ? "📔 Today's diary isn't filled yet"
          : "📔 Yesterday's diary was never filled";
      const payload = JSON.stringify({
        title,
        body: 'Close Day from the Diary tab — it only takes a minute.',
        data: { url: './' },
      });
      try {
        await webpush.sendNotification(subscription, payload);
        result.sent.push({ profileId, title });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          result.skipped.push({ profileId, reason: 'subscription expired' });
        } else {
          result.errors.push({ profileId, error: err.message });
        }
      }
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('check-diary-reminder failed:', err);
    res.status(500).json({ error: err.message, partial: result });
  }
}

async function getServiceAccountAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto
    .createSign('RSA-SHA256')
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

async function findDataFileId(accessToken) {
  const q = encodeURIComponent(`'${DRIVE_FOLDER_ID}' in parents and name='${DATA_FILE_NAME}' and trashed=false`);
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  const { files } = await resp.json();
  if (!files || !files.length) throw new Error(`${DATA_FILE_NAME} not found in folder ${DRIVE_FOLDER_ID}`);
  return files[0].id;
}

async function downloadData(accessToken, fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

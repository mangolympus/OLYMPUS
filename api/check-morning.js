// api/check-morning.js  (v139)
// Runs from Vercel's own cron (see vercel.json) every morning at ~08:00 IST -- no external scheduler, no extra secret: Vercel sends the
// existing CRON_SECRET itself, exactly like check-reminders.js. It takes over the cron slot the midnight diary reminder used (the free
// plan allows only two daily crons), and covers that job's purpose too:
//   * Monday  -> the weekly review: "last week in numbers, open Statistics" (pref: weeklyReview)
//   * any day -> if YESTERDAY's diary was never closed: "close it to unlock your timer" (pref: diaryReminder). Since v138 an unclosed
//                yesterday blocks starting the timer, so the morning is the moment this matters, rather than midnight.
// (Today's diary is now reminded in the 9 PM combined reminder -- check-reminders.js.)
// Pushes are high urgency with a TTL so Android's Doze mode doesn't hold them back. Idempotent: each is stamped in pushState, so a
// second run the same day (manual test, retry) sends nothing twice. Same service-account Drive access, raw-fetch + hand-signed JWT and
// re-fetch-before-write pattern as check-reminders.js (helpers duplicated on purpose -- see auth.js's header comment).
// NOTE: on the free Vercel plan a daily cron fires "within the scheduled hour", not at the exact minute -- so expect 8:00-8:59 AM.
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
const PAPER_NICKS = { fr: 'FR', afm: 'AFM', audit: 'AUDIT', dt: 'DT', idt: 'IDT', ibs: 'IBS' };

webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// IST wall clock + the 5 AM -> 4:59 AM study day (same as todayStr() in index.html).
function istNow(nowUtc) {
  nowUtc = nowUtc || new Date();
  const shifted = new Date(nowUtc.getTime() + IST_OFFSET_MINUTES * 60000);
  const hour = shifted.getUTCHours(), minute = shifted.getUTCMinutes();
  const day = new Date(shifted.getTime());
  if (hour < 5) day.setUTCDate(day.getUTCDate() - 1);
  return { hour, minute, minutes: hour * 60 + minute, studyDay: day.toISOString().slice(0, 10), weekday: day.getUTCDay() }; // weekday: 0 Sun .. 1 Mon
}
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function hoursOn(data, profileId, day) {
  return ((data.logs && data.logs[profileId]) || []).filter((l) => l.date === day).reduce((s, l) => s + Number(l.hours || 0), 0);
}
function fmtH(h) { return (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') + 'h'; }

// Monday is `today`; the review covers last Monday..Sunday against the week before it.
function weekStats(data, profileId, mondayStr) {
  const target = Number((data.targets && data.targets[profileId]) || 4);
  let total = 0, studied = 0, hit = 0;
  for (let i = 0; i < 7; i++) {
    const h = hoursOn(data, profileId, addDaysStr(mondayStr, i));
    total += h; if (h > 0) studied++; if (h >= target) hit++;
  }
  return { total, studied, hit };
}
function neglectedPaper(data, profileId, today) {
  const logs = (data.logs && data.logs[profileId]) || [];
  let worst = null;
  Object.keys(PAPER_NICKS).forEach((pid) => {
    const dates = logs.filter((l) => l.paperId === pid && Number(l.hours) > 0).map((l) => l.date).sort();
    if (!dates.length) return;
    const ago = Math.round((new Date(today + 'T00:00:00Z') - new Date(dates[dates.length - 1] + 'T00:00:00Z')) / 86400000);
    if (ago >= 7 && (!worst || ago > worst.ago)) worst = { nick: PAPER_NICKS[pid], ago };
  });
  return worst;
}
function buildWeeklyDigest(data, profileId, today) {
  const lastMon = addDaysStr(today, -7), prevMon = addDaysStr(today, -14);
  const w = weekStats(data, profileId, lastMon), p = weekStats(data, profileId, prevMon);
  if (w.total <= 0 && p.total <= 0) return null;
  const diff = Math.round((w.total - p.total) * 10) / 10;
  let body = `${fmtH(w.total)} last week (${diff > 0 ? '+' : ''}${fmtH(diff)} vs the week before) · studied ${w.studied}/7 days · target met ${w.hit}×.`;
  const gap = neglectedPaper(data, profileId, today);
  if (gap) body += ` ${gap.nick} untouched for ${gap.ago} days.`;
  body += ' Open Statistics to see what needs attention.';
  return { title: '📊 Your week in numbers — time to review', body };
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).access_token;
}
async function findDataFileId(accessToken) {
  const q = encodeURIComponent(`'${DRIVE_FOLDER_ID}' in parents and name='${DATA_FILE_NAME}' and trashed=false`);
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status} ${await resp.text()}`);
  const { files } = await resp.json();
  if (!files || !files.length) throw new Error(`${DATA_FILE_NAME} not found`);
  return files[0].id;
}
async function downloadData(accessToken, fileId) {
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Drive download failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}
async function uploadData(accessToken, fileId, data) {
  const resp = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`Drive write failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}


export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) { res.status(500).json({ error: 'CRON_SECRET is not set on the server' }); return; }
  if (!safeEqual(req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`)) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = { now: null, sent: [], skipped: [], errors: [] };
  try {
    const t = req.query && req.query.at ? istNow(new Date(String(req.query.at))) : istNow(); // ?at=ISO is for testing only (needs the secret anyway)
    result.now = t;
    const accessToken = await getAccessToken();
    const fileId = await findDataFileId(accessToken);
    const data = await downloadData(accessToken, fileId);
    if (!data || typeof data !== 'object' || !data.logs || !data.targets) throw new Error('Downloaded file did not look like valid Olympus data — aborting.');
    const subs = data.pushSubscriptions || {};
    const prefs = data.pushPrefs || {};
    const state = data.pushState || {};
    const stamps = []; // {profileId, kind, slot}
    const expired = [];

    const send = async (profileId, kind, slot, title, body, extraData) => {
      const payload = JSON.stringify({ title, body, tag: `olympus-${kind}-${t.studyDay}${slot ? '-' + slot : ''}`, data: Object.assign({ url: './', kind: kind === 'weekly' ? 'weekly' : 'reminder' }, extraData || {}) });
      try {
        await webpush.sendNotification(subs[profileId], payload, { urgency: 'high', TTL: kind === 'weekly' ? 43200 : 21600 });
        stamps.push({ profileId, kind, slot });
        result.sent.push({ profileId, kind, slot });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) { expired.push(profileId); result.skipped.push({ profileId, kind, reason: 'subscription expired' }); }
        else result.errors.push({ profileId, kind, error: err.message });
      }
    };

    const yesterday = addDaysStr(t.studyDay, -1);
    for (const profileId of PROFILE_IDS) {
      if (!subs[profileId]) { result.skipped.push({ profileId, reason: 'not subscribed' }); continue; }
      const pp = prefs[profileId] || {};
      // Monday weekly review
      if (t.weekday === 1 && pp.weeklyReview !== false) {
        const sentOn = state.weeklyReviewSent && state.weeklyReviewSent[profileId];
        if (sentOn !== t.studyDay) {
          const digest = buildWeeklyDigest(data, profileId, t.studyDay);
          if (digest) await send(profileId, 'weekly', '', digest.title, digest.body, { go: 'stats', url: './?go=stats' });
          else result.skipped.push({ profileId, kind: 'weekly', reason: 'no data to review' });
        }
      }
      // Yesterday's diary still open (it blocks the timer from v138 on). Not for someone with no history at all.
      if (pp.diaryReminder !== false) {
        const hasHistory = ((data.logs && data.logs[profileId]) || []).some((l) => l.date < t.studyDay);
        const refl = data.diaryReflections && data.diaryReflections[profileId] && data.diaryReflections[profileId][yesterday];
        const closed = !!(refl && refl.closedAt);
        const sentOn = state.diaryMorningSent && state.diaryMorningSent[profileId];
        if (hasHistory && !closed && sentOn !== t.studyDay) {
          await send(profileId, 'diary', '', "📔 Close yesterday's diary to start your timer", "Yesterday's diary isn't closed yet, and the timer stays locked until it is. It only takes a minute.", { url: './' });
        }
      }
    }

    if (stamps.length || expired.length) {
      // Re-fetch and patch only the fields this endpoint owns (a stale snapshot must never overwrite a study session saved meanwhile).
      let target = data;
      try {
        const fresh = await downloadData(accessToken, fileId);
        if (fresh && typeof fresh === 'object' && fresh.logs && fresh.targets) target = fresh;
      } catch (e) { console.warn('Re-fetch before write failed — using the start-of-run snapshot:', e.message); }
      if (!target.pushState) target.pushState = { targetHitDate: {} };
      if (!target.pushState.weeklyReviewSent) target.pushState.weeklyReviewSent = {};
      if (!target.pushState.diaryMorningSent) target.pushState.diaryMorningSent = {};
      stamps.forEach(({ profileId, kind }) => {
        if (kind === 'weekly') target.pushState.weeklyReviewSent[profileId] = t.studyDay;
        else if (kind === 'diary') target.pushState.diaryMorningSent[profileId] = t.studyDay;
      });
      // An expired subscription is left for the owner's own device to repair (see reconcilePushSubscription() in index.html).
      await uploadData(accessToken, fileId, target);
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('check-morning failed:', err);
    res.status(500).json({ error: err.message, partial: result });
  }
}

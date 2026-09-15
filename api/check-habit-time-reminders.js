// api/check-habit-time-reminders.js
// Pushes a reminder shortly after a 'time' habit's target time passes and it's still not
// checked off — e.g. "wake up by 6:00 AM" nags around 6:00–6:20 if nobody's tapped it yet.
//
// *** THIS CANNOT RUN AS A NORMAL VERCEL CRON ENTRY IN vercel.json ***
// Vercel's Hobby plan only allows cron jobs to fire once per day (confirmed against
// vercel.com/docs/cron-jobs/usage-and-pricing, Jan 2026) — fine for check-reminders.js's one
// evening run, but useless here: a habit's target time is arbitrary (6:00 AM, 11:00 PM,
// whatever the profile picked), so catching it requires checking every ~10–15 minutes, not
// once a day. Two ways to actually run this:
//   1. Upgrade to Vercel Pro (per-minute cron), add a normal crons entry for this path.
//   2. Stay on Hobby (free) and point a free external scheduler at this URL instead —
//      e.g. cron-job.org: create a job hitting
//      https://mangolympus.vercel.app/api/check-habit-time-reminders every 10–15 minutes,
//      with header  Authorization: Bearer <CRON_SECRET>  (same secret check-reminders.js
//      already uses — reused here rather than a second secret to manage).
// Either way, nothing needs to change in this file itself — it doesn't know or care who's
// calling it, only that the Bearer token matches.
//
// Same shared Drive file, same service-account auth, same re-fetch-before-write pattern, and
// the same duplicated sign()/safeEqual()-style helpers as every other api/*.js file here —
// see auth.js's comment for why they're duplicated instead of imported from one shared file.
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
// How long after the target time a still-unchecked habit keeps nagging. Wider than the
// expected ~10–15 min external poll interval so a slightly-late or skipped poll can't let a
// whole reminder window slip through unnoticed.
const REMINDER_WINDOW_MINUTES = 25;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same 5 AM→4:59 AM study-day boundary as index.html's todayStr()/check-reminders.js's
// todayStrIST() — shifted manually since this runs on Vercel's UTC server clock.
function todayStrIST(nowUtc) {
  nowUtc = nowUtc || new Date();
  const shifted = new Date(nowUtc.getTime() + IST_OFFSET_MINUTES * 60000);
  if (shifted.getUTCHours() < 5) shifted.setUTCDate(shifted.getUTCDate() - 1);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
// Plain wall-clock HH:MM in IST — separate from the study-day date above since a habit's
// target time is an ordinary clock time (6:00 AM is 6:00 AM regardless of the 5 AM
// study-day-boundary convention used elsewhere for grouping logged hours).
function nowISTHM(nowUtc) {
  nowUtc = nowUtc || new Date();
  const shifted = new Date(nowUtc.getTime() + IST_OFFSET_MINUTES * 60000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}
// 'HH:MM' + minutes -> 'HH:MM', wrapping past midnight if a target time is late enough that
// its window would cross into the next day (e.g. an 11:50 PM habit).
function addMinutesHM(hm, mins) {
  const [h, m] = hm.split(':').map(Number);
  let total = (h * 60 + m + mins) % 1440;
  if (total < 0) total += 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
// True if `hm` falls in [start, end), handling the midnight-wrap case above.
function inWindow(hm, start, end) {
  return start <= end ? (hm >= start && hm < end) : (hm >= start || hm < end);
}

function activeTimeHabits(data, profileId) {
  const list = (data.habits && data.habits[profileId]) || [];
  return list.filter((h) => h.active !== false && h.type === 'time' && h.targetValue);
}
// Mirrors isHabitDoneOn() in index.html for the 'time' type specifically (auto-target habits
// don't apply here — they have no target *time*, only a target *hours* amount).
function isHabitDoneToday(data, profileId, habitId, todayIST) {
  const day = data.habitLog && data.habitLog[profileId] && data.habitLog[profileId][todayIST];
  return !!(day && day[habitId] && day[habitId].completed);
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

  const result = { now: null, sent: [], skipped: [], errors: [] };
  try {
    const todayIST = todayStrIST();
    const nowHM = nowISTHM();
    result.now = `${todayIST} ${nowHM} IST`;

    const accessToken = await getServiceAccountAccessToken('https://www.googleapis.com/auth/drive');
    const fileId = await findDataFileId(accessToken);
    const data = await downloadData(accessToken, fileId);

    if (!data || typeof data !== 'object' || !data.logs || !data.targets) {
      throw new Error('Downloaded file did not look like valid Olympus data — aborting without writing back.');
    }
    if (!data.pushState) data.pushState = {};
    if (!data.pushState.remindedHabitTimeToday) data.pushState.remindedHabitTimeToday = {};
    if (!data.pushSubscriptions) data.pushSubscriptions = {};

    let dirty = false;
    const newlyReminded = []; // {profileId, habitId} pairs to stamp
    const expiredSubProfiles = [];

    for (const profileId of PROFILE_IDS) {
      if (data.pushPrefs && data.pushPrefs[profileId] && data.pushPrefs[profileId].habitReminder === false) {
        result.skipped.push({ profileId, reason: 'habitReminder push type disabled' });
        continue;
      }
      const subscription = data.pushSubscriptions[profileId];
      if (!subscription) {
        result.skipped.push({ profileId, reason: 'not subscribed' });
        continue;
      }
      const alreadyRemindedMap = data.pushState.remindedHabitTimeToday[profileId] || {};

      for (const habit of activeTimeHabits(data, profileId)) {
        const windowEnd = addMinutesHM(habit.targetValue, REMINDER_WINDOW_MINUTES);
        if (!inWindow(nowHM, habit.targetValue, windowEnd)) continue; // not this habit's moment
        if (isHabitDoneToday(data, profileId, habit.id, todayIST)) continue; // already checked off
        if (alreadyRemindedMap[habit.id] === todayIST) continue; // already nagged once today

        const payload = JSON.stringify({
          title: `${habit.icon ? habit.icon + ' ' : ''}${habit.name}`,
          body: `Target was ${habit.targetValue} — tap to check it off if you're up.`,
          data: { url: './' },
        });
        try {
          await webpush.sendNotification(subscription, payload);
          newlyReminded.push({ profileId, habitId: habit.id });
          dirty = true;
          result.sent.push({ profileId, habit: habit.name, target: habit.targetValue });
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            expiredSubProfiles.push(profileId);
            dirty = true;
            result.skipped.push({ profileId, reason: 'subscription expired, cleared' });
          } else {
            result.errors.push({ profileId, habit: habit.name, error: err.message });
          }
        }
      }
    }

    // Re-fetch onto a fresh copy before writing back — same reasoning as check-reminders.js:
    // this endpoint runs every ~10–15 min, right through the exact hours people are logging
    // sessions and checking off habits, so the window for a stale overwrite here is even
    // tighter than the once-a-day evening job's.
    if (dirty) {
      let writeTarget = data;
      try {
        const fresh = await downloadData(accessToken, fileId);
        if (fresh && typeof fresh === 'object' && fresh.logs && fresh.targets) {
          if (!fresh.pushState) fresh.pushState = {};
          if (!fresh.pushState.remindedHabitTimeToday) fresh.pushState.remindedHabitTimeToday = {};
          if (!fresh.pushSubscriptions) fresh.pushSubscriptions = {};
          newlyReminded.forEach(({ profileId, habitId }) => {
            if (!fresh.pushState.remindedHabitTimeToday[profileId]) fresh.pushState.remindedHabitTimeToday[profileId] = {};
            fresh.pushState.remindedHabitTimeToday[profileId][habitId] = todayIST;
          });
          expiredSubProfiles.forEach((profileId) => { delete fresh.pushSubscriptions[profileId]; });
          writeTarget = fresh;
        } else {
          console.warn('Re-fetch before write looked invalid — falling back to the start-of-run snapshot.');
        }
      } catch (err) {
        console.warn('Re-fetch before write failed — falling back to the start-of-run snapshot:', err.message);
      }
      await uploadData(accessToken, fileId, writeTarget);
    }

    res.status(200).json(result);
  } catch (err) {
    console.error('check-habit-time-reminders failed:', err);
    res.status(500).json({ error: err.message, partial: result });
  }
}

async function getServiceAccountAccessToken(scope) {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: email,
    scope,
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
  if (!resp.ok) {
    throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()).access_token;
}

async function findDataFileId(accessToken) {
  const q = encodeURIComponent(
    `'${DRIVE_FOLDER_ID}' in parents and name='${DATA_FILE_NAME}' and trashed=false`
  );
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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

async function uploadData(accessToken, fileId, data) {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }
  );
  if (!resp.ok) throw new Error(`Drive write failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

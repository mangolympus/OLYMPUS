// api/check-morning.js  (v172 -- adds the Road-to-1-May morning push; v139 base)
// Runs from Vercel's own cron (see vercel.json) every morning at ~08:00 IST -- no external scheduler, no extra secret: Vercel sends the
// existing CRON_SECRET itself, exactly like check-reminders.js. It takes over the cron slot the midnight diary reminder used (the free
// plan allows only two daily crons), and covers that job's purpose too:
//   * Monday  -> the weekly review: "last week in numbers, open Statistics" (pref: weeklyReview)
//   * any day -> if YESTERDAY's diary was never closed: "close it to unlock your timer" (pref: diaryReminder). Since v138 an unclosed
//                yesterday blocks starting the timer, so the morning is the moment this matters, rather than midnight.
//   * Road to 1 May (v172) -> ONE push a morning at most, in the person's own pref 'journey': a sprint's first morning, a countdown moment
//                (150/100/75/50/30/14/7/1 days to go), sprint day 5 (check-in) and sprint day 9 ("review tomorrow"). Same stamp-and-skip
//                idempotency as the others (pushState.journeySent).
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


// v159: Challenges (the rebuilt feature in index.html). A trimmed port of chlEval() -- only what a reminder needs. Only ACTIVE challenges that are
// still winnable are returned; one that already lost (too many missed days) or ran out is left for the app to close out on its next open.
// hitOn(d) must say whether the profile met the challenge on study day d; todayHit uses the same rule as the app.
function challengeSnapshot(data, profileId, todayStr, hoursFn, targetToday) {
  const list = (data.challenges && data.challenges[profileId] && data.challenges[profileId].list) || [];
  const logs = (data.logs && data.logs[profileId]) || [];
  const tasks = (data.tasks && data.tasks[profileId]) || [];
  const baseTarget = Number((data.targets && data.targets[profileId]) || 4);
  const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const hitOn = (ch, d) => {
    if (ch.res && ch.res[d]) return true;
    if (ch.kind === 'hours') return hoursFn(d) >= Number(ch.goal || 0) - 0.005;
    if (ch.kind === 'target') return hoursFn(d) >= (d === todayStr ? targetToday : baseTarget) - 0.005;
    if (ch.kind === 'plan') { const ts = tasks.filter((t) => t.date === d); return ts.length > 0 && ts.every((t) => t.done); }
    if (ch.kind === 'sessions') return logs.filter((l) => l.date === d).length >= Number(ch.goal || 1);
    return false; // 'manual' counts only what was ticked (ch.res)
  };
  // v163: Early Bird is time-locked (ch.wake = minutes after midnight, ch.grace = buffer minutes). Once the window has closed the day is lapsed, so it counts as
  // a miss and must not be nudged. IST clock, study day starting at 5 AM -- same as the cron's own todayStr.
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const sinceMin = (((istNow.getUTCHours() * 60 + istNow.getUTCMinutes() - 300) % 1440) + 1440) % 1440;
  const wakeOn = (ch, d) => ch.wake != null && (!ch.wakeFrom || d >= ch.wakeFrom);
  const wakeClosed = (ch) => sinceMin > (ch.wake - 300) + (ch.grace != null ? ch.grace : 10);
  const clock = (m) => { const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const goalText = (ch) => ch.kind === 'hours' ? `Study ${ch.goal}h` : ch.kind === 'target' ? 'Reach your daily target'
    : ch.kind === 'plan' ? 'Finish every planner task' : ch.kind === 'sessions' ? `Log ${ch.goal}+ study sessions` : (ch.wake != null ? `Wake up before ${clock(ch.wake)}` : (ch.blurb || ch.name));
  const out = [];
  list.forEach((ch) => {
    if (!ch || ch.status !== 'active' || !ch.start || !(ch.days > 0)) return;
    let hits = 0, misses = 0, todayHit = false, lapsed = false;
    for (let i = 0; i < ch.days; i++) {
      const d = addDays(ch.start, i);
      if (d > todayStr) break;
      const h = hitOn(ch, d);
      if (d === todayStr) { todayHit = h; if (h) hits++; else if (wakeOn(ch, d) && wakeClosed(ch)) { misses++; lapsed = true; } } else if (h) hits++; else misses++;
    }
    const rest = ch.rest | 0;
    if (misses > rest || todayStr > addDays(ch.start, ch.days - 1) || todayStr < ch.start) return;
    const dayNo = Math.round((new Date(todayStr + 'T00:00:00Z') - new Date(ch.start + 'T00:00:00Z')) / 864e5) + 1;
    out.push({ name: String(ch.name || 'Challenge'), icon: ch.icon || '🏁', goalText: goalText(ch), days: ch.days, dayNo, hits, need: ch.days - rest, todayHit, lapsed,
      atRisk: !todayHit && rest > 0 && misses === rest });
  });
  return out;
}

function buildChallengeMorning(items) {
  if (!items.length) return null;
  const left = (c) => Math.max(0, c.need - c.hits);
  if (items.length === 1) {
    const c = items[0];
    const lead = c.dayNo === 1 ? 'starts today' : `day ${c.dayNo} of ${c.days}`;
    let body = `Today: ${c.goalText.charAt(0).toLowerCase() + c.goalText.slice(1)}. ${left(c) > 0 ? left(c) + ' more to win.' : 'Win secured — finish strong!'}`;
    if (c.atRisk) body += ' ⚠️ No rest days left — a miss today ends the run.';
    return { title: `${c.icon} ${c.name} · ${lead}`, body };
  }
  return { title: `🏁 ${items.length} challenges today`, body: items.map((c) => `• ${c.icon} ${c.name} — day ${c.dayNo}/${c.days}${c.atRisk ? ' ⚠️' : ''}`).join('\n') };
}

// Monday is `today`; the review covers last Monday..Sunday against the week before it.
// ── v172: Road to 1 May ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Mirrors the app's sprint maths: 1 Dec 2026 is day 1; sprints 1-14 are 10 days, sprint 15 runs to the day before the exam.
const JY_START = '2026-12-01';
const JY_COUNTDOWNS = [150, 100, 75, 50, 30, 14, 7, 1];
function dayDiff(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function buildJourneyMorning(data, profileId, today) {
  const exam = data.examDate || '2027-05-01';
  const d = dayDiff(JY_START, today), total = dayDiff(JY_START, exam), left = dayDiff(today, exam);
  if (d < 0 || left < 0) return null;
  const idx = Math.min(14, Math.floor(d / 10)), n = idx + 1, dayIn = d - idx * 10 + 1;
  const start = addDaysStr(JY_START, idx * 10), end = idx === 14 ? addDaysStr(exam, -1) : addDaysStr(start, 9);
  const days = dayDiff(start, end) + 1;
  const j = (data.journey && data.journey[profileId]) || {};
  const goal = j.goals && j.goals[String(n)];
  const target = Number((data.targets && data.targets[profileId]) || 4);
  const hoursGoal = goal && Number(goal.hours) > 0 ? Number(goal.hours) : target * days;
  let hrs = 0;
  for (let k = 0; k < days; k++) { const dd = addDaysStr(start, k); if (dd > today) break; hrs += hoursOn(data, profileId, dd); }
  const bits = [];
  let title = null;
  if (JY_COUNTDOWNS.includes(left)) {
    title = left === 1 ? '⏳ Exam tomorrow' : `⏳ ${left} days to CA Final`;
    bits.push(left === 1 ? 'Rest, revise lightly, trust the work you have done.' : `Sprint ${n} of 15 · day ${d + 1} of ${total}.`);
  }
  if (dayIn === 1) {
    const prev = idx > 0 ? addDaysStr(start, -10) : null;
    let prevH = 0;
    if (prev) for (let k = 0; k < 10; k++) prevH += hoursOn(data, profileId, addDaysStr(prev, k));
    title = title ? `${title} · Sprint ${n} starts` : `🏁 Sprint ${n} starts today`;
    const hasGoals = goal && (Number(goal.hours) > 0 || Object.keys(goal.lec || {}).length || Number(goal.chap) > 0 || Number(goal.rev) > 0 || Number(goal.mock) > 0);
    bits.push(hasGoals ? `Goal: ${fmtH(hoursGoal)}${goal && goal.lec ? Object.keys(goal.lec).length ? ' + lectures' : '' : ''}. ` + (prev ? `Last sprint you logged ${fmtH(prevH)}.` : 'Make day 1 count.')
      : `${days} days to go. Set your goals (Even split does it in one tap) so the sprint has a finish line.`);
  } else if (!title && dayIn === 5) {
    const pace = hoursGoal * 0.5, pct = Math.round(hrs / hoursGoal * 100);
    title = `📍 Sprint ${n} · halfway`;
    bits.push(`${fmtH(hrs)} of ${fmtH(hoursGoal)} (${pct}%). ${hrs >= pace ? 'You are ahead of pace — keep it steady.' : `Half-way pace is ${fmtH(pace)} — a strong day today closes the gap.`}`);
  } else if (!title && dayIn === 9 && !(j.reviews && j.reviews[String(n)])) {
    title = `📝 Sprint ${n} ends tomorrow`;
    bits.push('Take two minutes to write your sprint review in Journey — what worked, what didn\'t, one change.');
  }
  return title ? { title, body: bits.join(' ') } : null;
}
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
      // v159: challenge kick-off -- one push a morning when the profile has a challenge still running (pref: challengeReminder).
      if (pp.challengeReminder !== false) {
        const sentOn = state.challengeMorningSent && state.challengeMorningSent[profileId];
        if (sentOn !== t.studyDay) {
          const target = Number((data.targets && data.targets[profileId]) || 4);
          const msg = buildChallengeMorning(challengeSnapshot(data, profileId, t.studyDay, (d) => hoursOn(data, profileId, d), target));
          if (msg) await send(profileId, 'challenge', 'am', msg.title, msg.body, { go: 'challenges', url: './?go=challenges' });
        }
      }
      // v172: Road to 1 May -- at most one push a morning (pref: journey).
      if (pp.journey !== false) {
        const sentOn = state.journeySent && state.journeySent[profileId];
        if (sentOn !== t.studyDay) {
          const msg = buildJourneyMorning(data, profileId, t.studyDay);
          if (msg) await send(profileId, 'journey', '', msg.title, msg.body, { go: 'journey', url: './?go=journey' });
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
      if (!target.pushState.challengeMorningSent) target.pushState.challengeMorningSent = {};
      if (!target.pushState.journeySent) target.pushState.journeySent = {};
      stamps.forEach(({ profileId, kind }) => {
        if (kind === 'weekly') target.pushState.weeklyReviewSent[profileId] = t.studyDay;
        else if (kind === 'diary') target.pushState.diaryMorningSent[profileId] = t.studyDay;
        else if (kind === 'challenge') target.pushState.challengeMorningSent[profileId] = t.studyDay;
        else if (kind === 'journey') target.pushState.journeySent[profileId] = t.studyDay;
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

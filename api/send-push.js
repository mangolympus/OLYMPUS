// api/send-push.js
// Sends a single Web Push notification via VAPID — the actual delivery mechanism behind
// nudges, "partner started studying," "partner hit target," and new chat message pushes.
// Regenerated in ES module syntax (matching auth.js/sync.js — this repo's package.json has
// "type": "module", so a CommonJS require()/module.exports version would crash the same way
// the earlier auth.js/sync.js versions did).
//
// Required env vars (already present — same ones referenced by the client-side
// subscribeToPush() flow in index.html):
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT     — typically "mailto:you@example.com", identifies who's sending
//
// Needs the `web-push` package in package.json dependencies — check first; if missing,
// add "web-push": "^3.6.7" the same way googleapis was added for sync.js.
//
// Request:  POST { subscription: PushSubscriptionJSON, title: string, body: string, data?: object,
//                  urgency?: 'very-low'|'low'|'normal'|'high', ttl?: seconds }
//   v128: `urgency` and `ttl` are optional and forwarded to the push service. Chat messages ask for urgency 'high' -- with the
//   default ('normal') Android's Doze mode can hold a push back for minutes until the phone next wakes, which showed up as
//   "the chat notification arrived late". Callers that send neither get exactly the old behaviour.
// Success:  200 { ok: true }
// Expired subscription (recipient uninstalled / revoked permission): 200 { ok: false, expired: true }
//   — the frontend's sendPush() specifically checks this `expired` flag to prune the stale
//   subscription from S.shared.pushSubscriptions, so this shape has to match exactly.
// Failure:  500 { error: string }

import webpush from 'web-push';
import { createHmac, timingSafeEqual } from 'crypto';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// v154: this endpoint used to accept ANY request -- no sign-in check at all, although the app already sends its session token with every
// push (and the comments in the other api files say every endpoint requires one). Anyone who found the URL could make the server
// deliver arbitrary notifications to any push address, or make it POST to any address they put in "endpoint". It now needs a valid
// session token, same check as api/sync.js (sign()/verifyToken() are deliberately a copy, like in the other api files).
function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!verifyToken(token)) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }

  const { subscription, title, body, data, urgency, ttl } = req.body || {};
  if (!subscription || !subscription.endpoint || !title) {
    res.status(400).json({ error: 'Missing subscription or title' });
    return;
  }
  // Real push services are always reached over https; refuse anything else (http, internal addresses) so this can't be pointed elsewhere.
  let endpointHost = '';
  try {
    const u = new URL(subscription.endpoint);
    if (u.protocol === 'https:') endpointHost = u.hostname;
  } catch (e) { /* falls through to the 400 below */ }
  if (!endpointHost || endpointHost === 'localhost' || /^[\d.]+$/.test(endpointHost) || endpointHost.includes(':')) {
    res.status(400).json({ error: 'Invalid push endpoint' });
    return;
  }

  // Only values the Web Push protocol defines are passed on; anything else is ignored rather than rejected.
  const options = {};
  if (['very-low', 'low', 'normal', 'high'].includes(urgency)) options.urgency = urgency;
  const ttlNum = Number(ttl);
  if (Number.isFinite(ttlNum) && ttlNum > 0) options.TTL = Math.min(Math.floor(ttlNum), 2419200); // seconds, max 4 weeks

  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body: body || '', data: data || {} }),
      options
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    // 404/410 from the push service means the subscription itself is dead (browser
    // uninstalled, permission revoked, etc.) — not a real failure to log loudly, just a
    // signal for the frontend to stop trying to reach that specific subscription.
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      res.status(200).json({ ok: false, expired: true });
      return;
    }
    console.error('send-push failed:', err);
    res.status(500).json({ error: 'Failed to send push' });
  }
}

// api/ask.js
// Generic AI text proxy — every AI feature in index.html (daily motivation quote, doubt
// solver, AI summary, study chat, AI coach feedback, milestone celebration lines, daily
// plan) goes through this one endpoint via callClaudeAI(). The frontend crafts the full
// prompt itself, including any "return JSON" / "under N words" / tone instructions — this
// endpoint has no per-feature logic, it's a plain pass-through to Google's Gemini API with
// the API key kept server-side (never shipped to the browser).
//
// Required env vars (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY — from Google AI Studio: https://aistudio.google.com/apikey
//   SESSION_SECRET — same one auth.js/sync.js use, for verifying the caller's token
//
// Auth: every request needs `Authorization: Bearer <token>` from a prior /api/auth call —
// same as api/sync.js. This was MISSING entirely until now, which mattered a lot more here
// than it would on a data-only endpoint: every call costs real money against the account
// owner's Gemini API key, and MAX_PROMPT_CHARS below only ever bounded the SIZE of one
// request, never the NUMBER of them — with no login required at all, anyone who found this
// URL (trivially discoverable — it's called from this app's own public, unauthenticated-to-
// view index.html) could script unlimited requests against it indefinitely.
//
// Request:  POST { prompt: string }
// Success:  200  { text: string }
// Failure:  4xx/5xx  { error: string }
//   401 { error: 'Not signed in' } if the Authorization header is missing/invalid/expired.
//
// Model pinned below as a plain constant — swap MODEL if Google retires/replaces it again or
// if you want a different quality/speed/cost tradeoff. 'gemini-2.5-flash' (this file's
// original choice) was retired for new users sometime after this file was first written;
// Gemini's own 404 response named 'gemini-3.6-flash' as the replacement, which is what's
// pinned now. If this starts erroring again with a similar "no longer available" message,
// the error itself will very likely name the correct replacement — same as it did this
// time — so start there before searching docs.
//
// Google's error also suggested moving to something called the "Interactions API" for
// "the latest features and improvements" — that's a newer/different API shape than the
// generateContent REST call this file uses, and I don't have reliable documentation for it
// (it postdates my training data). Left this file on the plain generateContent endpoint,
// just with the corrected model name, since that's the minimal, verifiable fix for the
// actual error reported. Worth revisiting with current docs (or a web search) if Google
// later deprecates generateContent itself the same way it deprecated this model.
const MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Generous ceiling — the longest real prompt from index.html (buildProfileSummaryForAI's
// JSON dump for the AI Coach feature) is well under this. Purely an abuse guard, not a
// realistic limit for any actual feature.
const MAX_PROMPT_CHARS = 8000;

import { createHmac, timingSafeEqual } from 'crypto';

// Duplicated from auth.js/sync.js rather than imported — see auth.js's own comment for why
// (a shared api/_lib/session.js file wasn't reliably bundled by Vercel).
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

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Missing prompt' });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `Prompt too long (max ${MAX_PROMPT_CHARS} characters)` });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Server misconfiguration, not the caller's fault — 500, not 400.
    res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server' });
    return;
  }

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.9,
          // Gemini 3.x models have "thinking" on by default, and — unlike the separate
          // thinking-budget Anthropic uses — Gemini's thinking tokens are billed against
          // and draw from this SAME maxOutputTokens ceiling as the visible answer. With no
          // thinkingConfig set, the model could spend a variable, sometimes large chunk of
          // the budget on invisible reasoning before writing any of the actual answer,
          // leaving an unpredictable remainder — which is exactly why callers were seeing
          // "Unterminated string in JSON" at a different cutoff position every time: the
          // visible JSON was getting cut off mid-string once the shrunken remainder ran
          // out, not because of anything wrong with the prompt or the JSON shape itself.
          // None of this endpoint's callers (a short tutoring answer, a JSON plan, a
          // one-line quote) need multi-step reasoning, so thinking is turned down as low as
          // this model allows, rather than just budgeted — simpler, faster, and removes the
          // variability outright. IMPORTANT: `thinkingBudget` (a raw token count, with 0
          // meaning "off") is a Gemini 2.5-only field — Gemini 3.x models including this one
          // (MODEL above) use `thinkingLevel` instead, an enum of minimal/low/medium/high,
          // and don't support thinkingBudget at all (mixing the two, or sending the wrong
          // one for the model generation, is a documented 400 INVALID_ARGUMENT — exactly
          // what this endpoint was returning until this was corrected). 'minimal' is the
          // lowest level Gemini 3 Flash accepts (there's no true "0/off" the way 2.5 had).
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
        // Google's defaults already block high/medium-severity harmful content; not
        // overriding safetySettings here — no reason for a CA-exam study tool to need
        // anything looser than the default, and loosening it server-side would apply to
        // every feature uniformly, not just the ones that might benefit.
      }),
    });
  } catch (networkErr) {
    res.status(502).json({ error: `Could not reach Gemini: ${networkErr.message}` });
    return;
  }

  let data;
  try {
    data = await geminiRes.json();
  } catch (parseErr) {
    res.status(502).json({ error: 'Gemini returned a non-JSON response' });
    return;
  }

  if (!geminiRes.ok) {
    // Gemini's error shape is { error: { message, status, code } }.
    const rawMsg = data?.error?.message || `Gemini ${geminiRes.status}`;
    // A retired/renamed model (status NOT_FOUND, or a message naming the model itself) is
    // exactly what already happened once with gemini-2.5-flash — see MODEL above. Google's
    // raw message for this ("models/gemini-3.6-flash is not found for API version v1beta...")
    // is accurate but not something a student staring at the Statistics page should have to
    // parse. Still logging the raw message server-side so a real fix (swap MODEL) has the
    // exact detail to go on.
    const isModelGone = data?.error?.status === 'NOT_FOUND' || /model/i.test(rawMsg) && /not found|not supported|deprecated|retired/i.test(rawMsg);
    if (isModelGone) {
      console.error(`ask.js: model '${MODEL}' appears unavailable — ${rawMsg}`);
      res.status(502).json({ error: 'The AI model this app uses was updated by Google and needs a quick fix on the backend — try again shortly, or let Umang know if it keeps happening.' });
      return;
    }
    const msg = rawMsg;
    const status = geminiRes.status >= 400 && geminiRes.status < 600 ? geminiRes.status : 502;
    res.status(status).json({ error: msg });
    return;
  }

  // A response blocked by safety filters (or one that hit MAX_TOKENS before producing any
  // text) still comes back with geminiRes.ok === true, just with no usable text — that's not
  // a network/API failure, so it needs its own explicit check rather than crashing on
  // `.parts[0].text` of something that doesn't exist, or silently returning empty text.
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    res.status(502).json({ error: `Blocked by Gemini's safety filters (${blockReason})` });
    return;
  }
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const reason = candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : '';
    res.status(502).json({ error: `Gemini returned no text${reason}` });
    return;
  }
  // The MAX_TOKENS case above (empty text) was already covered by the check just above —
  // this catches the other, more confusing shape: finishReason === 'MAX_TOKENS' WITH some
  // non-empty text, meaning the response got cut off mid-answer rather than before starting.
  // That partial text is genuinely unusable for anything expecting well-formed JSON or a
  // complete sentence, so it needs to fail loudly here — as a clear, specific error — rather
  // than being forwarded as if it were a normal, complete 200 response, which is exactly what
  // was silently breaking every JSON.parse() caller downstream (parseAiJson() in index.html)
  // with a cryptic "Unterminated string" error instead of an explanable one.
  if (candidate?.finishReason === 'MAX_TOKENS') {
    res.status(502).json({ error: 'Gemini response was cut off (hit the token limit) — try again' });
    return;
  }

  res.status(200).json({ text });
}

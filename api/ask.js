// api/ask.js
// Generic AI text proxy — every AI feature in index.html (daily motivation quote, doubt
// solver, AI summary, study chat, AI coach feedback, milestone celebration lines, daily
// plan) goes through this one endpoint via callClaudeAI(). The frontend crafts the full
// prompt itself, including any "return JSON" / "under N words" / tone instructions — this
// endpoint has no per-feature logic, it's a plain pass-through to Google's Gemini API with
// the API key kept server-side (never shipped to the browser).
//
// Required env var (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY — from Google AI Studio: https://aistudio.google.com/apikey
//
// Request:  POST { prompt: string }
// Success:  200  { text: string }
// Failure:  4xx/5xx  { error: string }
//
// Model pinned below as a plain constant — swap MODEL if Google retires/replaces it or if
// you want a different quality/speed/cost tradeoff. 'gemini-2.5-flash' was current and
// well-established as of this file's writing; if the Gemini API starts rejecting it with a
// "model not found" error, check https://ai.google.dev/gemini-api/docs/models for the
// current fast/cheap model name and update the constant — nothing else needs to change.
const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Generous ceiling — the longest real prompt from index.html (buildProfileSummaryForAI's
// JSON dump for the AI Coach feature) is well under this. Purely an abuse guard, not a
// realistic limit for any actual feature.
const MAX_PROMPT_CHARS = 8000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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
        generationConfig: { maxOutputTokens: 1024, temperature: 0.9 },
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
    const msg = data?.error?.message || `Gemini ${geminiRes.status}`;
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

  res.status(200).json({ text });
}

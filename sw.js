// Olympus service worker — app shell caching + update handling.
//
// Bump CACHE_VERSION on every deploy that changes index.html (or any other cached file).
// The activate handler deletes any cache that doesn't match this string, so bumping it is
// what makes the "new version available" flow in index.html actually pick up the change —
// forgetting to bump it means devices keep serving the old cached copy indefinitely.
//
// Bumped for v115 — fullscreen timer overhaul (8 bugs fixed):
//
// 1. ROTATION DOUBLE-ROTATION BUG (critical): toggleFullscreenOrientation() was applying
//    the fs-rotated CSS class (a 90° software rotation) even when screen.orientation.lock()
//    SUCCEEDED and the screen physically rotated to landscape — meaning content was rotated
//    twice (physically + CSS), appearing completely wrong. fs-rotated is now ONLY applied in
//    the catch branch (API unavailable/denied), never after a successful physical lock.
//
// 2. ORIENTATION STATE TRACKING: The old code used the presence of the fs-rotated CSS class
//    as the orientation-intent signal. Since the success path no longer adds that class, a
//    second Rotate tap couldn't know which direction to go. A new _fsWantsLandscape boolean
//    tracks intent independently of how (API vs CSS) we got there.
//
// 3. FULLSCREEN OVERLAY NOT UPDATING ON STATE CHANGES: timerPause/timerResume/timerStop all
//    call renderApp() but renderFullscreenTimer() was never wired into it, so the overlay's
//    buttons, status text, and subject line stayed permanently stale after the first open.
//    renderApp() now calls renderFullscreenTimer() whenever the fullscreen overlay is open.
//
// 4. NO PAUSE/RESUME/STOP IN FULLSCREEN: The overlay had only "Rotate" and "Exit" — users
//    had to exit fullscreen to pause or resume their session. The overlay now renders full
//    action buttons (Pause while running; Resume + Stop while on break) matching the main
//    timer card, so the session can be managed entirely in fullscreen.
//
// 5. BREAK STATE NOT SHOWN IN FULLSCREEN: During a break the overlay's clock kept showing
//    study elapsed time with no visual indication of the break. Now the primary clock shows
//    break time ("how long have I been resting?"), a secondary "STUDY SO FAR: hh:mm:ss" line
//    shows study progress, and the subject line appends "· On Break".
//
// 6. TICK LOOP SHOWED WRONG TIME IN FULLSCREEN DURING BREAK: The interval that patches
//    #fs-time-display was using the same displayText as the running state (study elapsed),
//    even during a break. It now uses break time when in break mode, matching fix #5.
//
// 7. CSS TRANSITION ONLY WORKED ONE WAY: The transition on the transform was only declared
//    on #fullscreen-timer-root.fs-rotated, so adding the class animated smoothly but
//    removing it snapped back instantly. The transition is now on the base rule so both
//    directions animate (adding and removing fs-rotated).
//
// 8. FONT SIZE WRONG IN CSS-ROTATED MODE: In the software-rotation fallback, the element
//    is physically portrait but visually "landscape" after the CSS 90° transform. The font-
//    size used min(20vw,96px) where vw = portrait width (narrow), but the visual "width"
//    after rotation is the portrait HEIGHT. An fs-rotated-specific rule now uses
//    clamp(40px,18vh,96px) so the clock fills the rotated visual width correctly.
const CACHE_VERSION = 'olympus-v115';

// NOTE: intro.mp4 is deliberately NOT in APP_SHELL below. It is ~1.7 MB and only ever
// played by the "Replay Intro" button in Settings > About, so precaching it would put the
// entire cost straight back into every install and every version bump. The runtime cache in
// the fetch handler still stores it after the first successful play, so offline replay
// keeps working from then on.

// Same-origin, always-available files only. Google Sign-In (accounts.google.com), Google
// Fonts, and any Drive/Gemini API calls are all cross-origin and deliberately never touched
// by this service worker (see the fetch handler below) — caching or intercepting those could
// interfere with login/sync, which is explicitly out of scope for this pass.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// index.html posts this once it's shown the "Updating…" toast and waited out the delay —
// see registerServiceWorker() there for the other half of this handshake.
//
// TIMER_NOTIFY / TIMER_NOTIFY_CLEAR: the persistent "session active" notification for the
// Study Timer. Deliberately NOT live-ticking — checked this first, not just assumed it:
// there is no web-notification equivalent of Android's native chronometer notification
// (Notification.Builder.setUsesChronometer(), which only native apps can use), and updating
// a shown notification every second from here would mean waking this worker every second,
// which Chrome throttles hard in the background — the exact failure mode already flagged in
// the brief. So this shows static status text ("Session Active — Started at 10:00 AM" / "On
// Break") that only changes on real state transitions (start/pause/resume), same tag every
// time so it replaces in place rather than stacking.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data && event.data.type === 'TIMER_NOTIFY') {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body,
      tag: 'olympus-active-timer',
      silent: true,
      requireInteraction: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      actions: [
        { action: 'pause', title: 'Pause' },
        { action: 'stop', title: 'End' },
      ],
    });
  } else if (event.data && event.data.type === 'TIMER_NOTIFY_CLEAR') {
    self.registration.getNotifications({ tag: 'olympus-active-timer' }).then((notifs) => {
      notifs.forEach((n) => n.close());
    });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept cross-origin requests

  // API routes (/api/sync, /api/ask, etc.) are dynamic — sync data, AI responses — and must
  // never go through the cache-first strategy below, which exists for the static app shell
  // (HTML/JS/CSS/icons) so it works offline. Serving these from cache is exactly what broke
  // chat/timer sync: the main /api/sync GET always hits the same URL, so the very first
  // successful poll got cached, and every poll after that — no matter how many times
  // driveSyncLoad() ran, or that it explicitly passed cache:'no-store' — returned that one
  // frozen snapshot straight from here, never touching the network again. Push notifications
  // still worked fine since those go through a separate mechanism (the service worker's own
  // 'push' event, below) that never passes through this fetch handler at all.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Navigations are matched with ignoreSearch, so a query string on the URL still resolves
  // to the cached shell. This is exactly the notificationclick path below: tapping Pause/End
  // when no tab is open calls openWindow('./?timerAction=pause'), and a plain caches.match()
  // treats that as a different URL from './' — so it missed the cache entirely and went to
  // the network, making a notification tap slow on a bad connection and doing nothing at all
  // offline, even though the shell was sitting right there. index.html reads the parameter
  // off location.search (applyPendingTimerActionFromUrl) and the server never varies the
  // response by query string, so the cached shell is always the correct thing to return.
  const isNavigation = req.mode === 'navigate';
  event.respondWith(
    caches.match(req, isNavigation ? { ignoreSearch: true } : undefined).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache same-origin GETs as they're seen, so anything not pre-listed in APP_SHELL
          // still becomes available offline after the first successful load. Navigations are
          // skipped here on purpose — they're already served from the shell entry above, and
          // storing them would add a separate near-duplicate copy of index.html per distinct
          // query string (./?timerAction=pause, ./?timerAction=stop, …) that nothing reads.
          if (res && res.ok && !isNavigation) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached — for a page navigation, fall back to the shell rather
          // than showing the browser's default offline error page.
          if (isNavigation) return caches.match('./index.html');
        });
    })
  );
});

// ── Push notifications ──────────────────────────────────────────
// The payload is whatever /api/send-push passed through to web-push's sendNotification() —
// see sendPush() in index.html: {title, body, data:{url}}.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON payload, ignore */ }
  const title = payload.title || 'Olympus';
  const options = {
    body: payload.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: payload.data || {},
  };
  // Show the notification AND immediately wake any open app window so the chat
  // poll fires right away instead of waiting for the next 3-second tick.
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
        all.forEach((client) => client.postMessage({ type: 'PUSH_RECEIVED', payload }));
      }),
    ])
  );
});

// Focuses an already-open Olympus tab/window if one exists, otherwise opens a new one —
// rather than always opening a fresh tab regardless of what's already running.
self.addEventListener('notificationclick', (event) => {
  // Pause/End tapped on the persistent timer notification — hand off to index.html to run
  // the actual timerPause()/timerStop() so shared state and Drive sync fire exactly as if
  // the button had been tapped in the UI (see the message listener there). Deliberately
  // doesn't close the notification here: index.html updates or clears it once the state
  // change is actually applied, via TIMER_NOTIFY/TIMER_NOTIFY_CLEAR above, so the shade
  // never shows a stale status for the instant before that round-trip completes.
  if (event.notification.tag === 'olympus-active-timer' && (event.action === 'pause' || event.action === 'stop')) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        if (windowClients.length > 0) {
          windowClients.forEach((client) => client.postMessage({ type: 'TIMER_ACTION', action: event.action }));
          return;
        }
        // No open tab to postMessage to — Android had fully killed it, not just backgrounded
        // it, which is common for a PWA tab left alone for a while. Open one instead of
        // silently dropping the tap; index.html checks for ?timerAction= on load and applies
        // it once app state is actually ready, then cleans the URL up.
        if (clients.openWindow) return clients.openWindow(`./?timerAction=${event.action}`);
      })
    );
    return;
  }
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// Olympus service worker — app shell caching + update handling.
//
// Bump CACHE_VERSION on every deploy that changes index.html (or any other cached file).
// The activate handler deletes any cache that doesn't match this string, so bumping it is
// what makes the "new version available" flow in index.html actually pick up the change —
// forgetting to bump it means devices keep serving the old cached copy indefinitely.
//
// Bumped for v117 — comprehensive audit pass (18 bugs fixed):
//
// CRITICAL
//   1. FAB Quick Log logged to the wrong person: openQuickLog() used viewingProfile instead
//      of myProfile. On the Timer page you can be viewing the other person, so tapping the
//      FAB would silently add hours to their record. Fixed to always log for myProfile.
//   2. chaptersFor/lecturesFor/mockScoresFor/stats crashed on migrated data: all four did a
//      raw double-bracket access with no null guard. Converted to optional chaining + ?? [].
//   3. migrateShared created top-level keys but never filled per-profile/per-paper buckets:
//      a device migrating old data got an empty shell that chaptersFor() crashed on. Added a
//      full PROFILES×PAPERS initialisation loop that populates every missing bucket safely.
//   4. viewWorkspace crashed when S.workspacePaper was null/stale: paperById(null) returns
//      undefined, then paper.id throws immediately. Falls back to PAPERS[0].
//
// SERIOUS
//   5. No Escape key handling anywhere: added a global keydown listener that dispatches
//      Escape to whichever lightweight modal is currently open (search, quicklog, AI info,
//      profile picker). Full-screen overlays already handle Escape via history.back().
//   6. search-modal-root shared by Search and Quick Log with no mode tracking: added
//      _activeSearchModal = 'search' | 'quicklog' | null so the Escape handler and close
//      functions always know which modal is active.
//   7. Timer tick interval firing on Chat and Money pages: the stop guard only checked for
//      timer and home views. Extended to stop on all non-timer views (except Strict Countdown
//      which still needs to fire for completion/nag regardless of current page).
//
// MEDIUM
//   8. uid() collision in same millisecond: two addLogEntry() calls in one synchronous block
//      both read the same Date.now(). Added a monotonic _uidSeq counter as a third component.
//   9. plannerDateFilter not reset on profile switch: Umang's Tuesday filter silently carried
//      over to Chetna's planner. setViewingProfile() now resets to todayStr() on change.
//  10. deleteLog archive duplication bug: deleteLog used logsFor() (which returns merged
//      live+archive), then wrote the filtered result back to the live array — pulling all
//      archive entries into live logs while they were still in S.sharedArchive, causing
//      duplication. Fixed to filter only the live array; archive entries handled separately.
//  11. Note link href XSS via javascript: protocol: escChat() escapes HTML but not JS
//      schemes. Added safeUrl() that only passes http/https/mailto through, so a note
//      with content="javascript:..." renders as inert href="#" instead.
//  12. notesFor() null-deref: same raw bracket access as chaptersFor. Fixed with ?. + ?? [].
//      addNote/deleteNote updated to write back to S.shared.notes directly (not the [] copy).
//  13. habitPerfectDayStreak while(true): bounded with a 1095-day (3-year) safety ceiling.
//  14. saveEditLog/addLog form elements: all getElementById calls now use optional chaining.
//  15. mtc-unit-toggle, lec-edit-topic/dur/section, et-priority, et-notes: all form element
//      accesses guarded with optional chaining to prevent crash if form not in DOM.
//  16. migrateShared tasks/logs per-profile init: added PROFILES.forEach bucket creation
//      matching the chapters/lectures fix above.
//
// MINOR
//  17. brand-logo src assignment without null guard: wrapped in if(brandLogo) check.
//  18. alert() → showToast(): replaced all 36 operational alert() calls with showToast()
//      for consistent non-blocking UX. loadShared/loadLocal silent catch blocks now
//      console.warn so data failures are visible during debugging.
//
// Bumped for v116 — performance pass (6 improvements):
//
// 1. NON-BLOCKING GOOGLE FONTS: The @import inside <style> was render-blocking — the
//    browser couldn't discover the font URL until the entire CSS block was parsed and
//    the @import network request completed, holding up the first paint. Replaced with
//    <link rel="preload" as="style" onload="this.rel='stylesheet'"> placed before the
//    <style> block, converting font loading from a blocking serial step to a parallel
//    one. Added a <noscript> fallback for the rare no-JS case.
//
// 2. PRECONNECT HINTS: Added <link rel="preconnect"> for fonts.googleapis.com,
//    fonts.gstatic.com (crossorigin), and cdnjs.cloudflare.com. DNS resolution + TCP
//    handshake + TLS negotiation for all three origins now happens speculatively while
//    HTML is still being parsed, shaving 100–400ms off the first requests to each.
//
// 3. LAZY-LOADED html2canvas + jsPDF (~2 MB combined): Both were <script src> tags
//    that loaded synchronously on every page load for every user — including Chetna,
//    who can never reach the Money module, and sessions that never export a PDF. They
//    are now fetched in parallel only when exportInvoicePdf() is first called, via
//    ensurePdfLibsLoaded() in the money IIFE. The preconnect for cdnjs (change 2)
//    means the first export doesn't pay a full connection-setup cost. Every subsequent
//    export is instant (libraries are already in the page).
//
// 4. CACHED prefersReducedMotion(): The helper was calling matchMedia() on every
//    invocation and it is called ~10 times per render cycle (animateCountUps,
//    triggerChartAnimations, scrollToTimerCard, etc.), each call causing a style
//    recalculation. The result is now cached after the first query and a 'change'
//    listener invalidates the cache if the OS accessibility preference actually changes.
//
// 5. will-change + contain:strict on #bg-canvas: The animated RAF canvas is now
//    promoted to its own GPU compositor layer (will-change:transform) so per-frame
//    repaints don't trigger main-thread document repaint. contain:strict tells the
//    browser the canvas can never affect or be affected by the rest of the document
//    layout — a safe assertion for a purely decorative position:fixed element.
//
// 6. contain:strict on all 8 full-screen overlay roots (#stats-root, #habits-root,
//    #diary-root, #targets-root, #games-root, #daily-challenges-root,
//    #fullscreen-timer-root, and the chat page): They are all position:fixed;inset:0
//    and completely isolated from document flow. Strict containment tells the browser
//    their internal layout/paint/style changes can never affect the main document tree,
//    skipping cross-tree recalculations whenever an overlay opens or closes.
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
// v118: Money top block no longer frozen/mismatched (compact, only search pinned); new Settings → Display
// (Home cards on/off + order, Lecture Completion paper picker).
// v119: Audit (Paper 3) lecture tracker; Targets/Needs Attention cards now show pending lectures/chapters.
// v120: Money page top section (Inflow/Outflow, balances, Dashboard/Invoices, search) fully frozen; bigger Inflow/Outflow; removed balances hint.
// v121: 5 AM study-day audit -- exam countdown, this-month lecture count, planner calendar default month, habit start dates, Money invoice month keys, backup filename.
// v122: partner live-timer visibility -- stays visible until the owner stops it, explicit stop signal, push-triggered refresh,
// verified timer saves (re-writes if the partner's upload clobbered it).
// v123: today's hours / KPIs / Head-to-Head / Home target + weekly bars + comparison / trends / sessions list all read ONE live-aware
// source (logs + the running session, for both profiles) and tick every second; Home timer cards (own + partner) are live, appear/disappear
// on their own and link to the right Timer page; partner KPI card added; partner log changes now redraw; study-day rollover redraw.
// v124: Home motivation rebuilt from scratch -- one partner-voice, uplifting message per profile per study day (no more hold-to-refresh),
// real-numbers context + anti-repeat history, warm offline fallback with quiet AI retries, 'dailyQuote' now single-owner synced, regenerates at 5 AM rollover.
const CACHE_VERSION = 'olympus-v124';

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

// ==UserScript==
// @name         ReelFree
// @description  Instagram without the Reels doom-scroll. An hour of normal Instagram a day; after that, reels only one at a time from a friend's DM or an account you open.
// @version      1.10.1
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @run-at       document-start
// @inject-into  content
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.10.1';

  const CONFIG = {
    dailyReelMinutes: 60,  // minutes of reels a day with Instagram completely normal; then the limits switch on until midnight
    showReelTimer: true,   // show the time left while reels time is being counted
    resumeMinutes: 5,      // reopening Instagram within this many minutes returns to your last page (0 = off)
    hideFeedVideos: true,  // once limited, blank video posts in the home feed too (on Instagram, feed videos are reels)
    showBadge: true,       // flash "ReelFree on" when Instagram loads, so you know the script is running
    fullscreen: true,      // hide the browser's toolbars on your first tap, where the browser allows it (Orion)
  };
  // The iPhone app sets its own values here before this script runs.
  if (typeof window === 'object' && window.__reelfreeConfig) Object.assign(CONFIG, window.__reelfreeConfig);

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const BASE = 'https://www.instagram.com';

  // First path segments that are Instagram pages, never usernames.
  const RESERVED = new Set([
    'about', 'accounts', 'api', 'ar', 'challenge', 'create', 'data', 'developer', 'direct',
    'directory', 'download', 'emails', 'explore', 'fxcal', 'graphql', 'legal', 'lite', 'nametag',
    'notifications', 'oauth', 'p', 'press', 'privacy', 'push', 'qp', 'reel', 'reels', 'session',
    'settings', 'static', 'stories', 'tv', 'web', 'your_activity',
  ]);
  const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

  function classify(pathname) {
    const [a, b, c] = pathname.split('/').filter(Boolean);
    if (!a) return { type: 'home' };
    if (a === 'reels') return b ? { type: 'reel', id: b } : { type: 'reelsFeed' };
    if (a === 'reel' || a === 'tv') return b ? { type: 'reel', id: b } : { type: 'other' };
    if (a === 'direct') return { type: 'dm' };
    if (a === 'explore') {
      if (b === 'search') return { type: 'exploreSearch' };
      if (b === 'tags' || b === 'locations') return { type: 'tagOrLocation' };
      return { type: 'explore' };
    }
    if (a === 'stories') return { type: 'story' };
    if (a === 'p') return { type: 'post' };
    if (RESERVED.has(a) || !USERNAME.test(a)) return { type: 'other' };
    if (b === 'reel' && c) return { type: 'reel', id: c, owner: a };
    if (b === 'p' && c) return { type: 'post' };
    return { type: 'profile', user: a };
  }

  function contextFor(route, path) {
    switch (route.type) {
      case 'dm': return { kind: 'dm', url: path };
      case 'profile': return { kind: 'profile', user: route.user, url: path };
      case 'home': return { kind: 'home', url: '/' };
      default: return { kind: 'other', url: path };
    }
  }

  // ---------------------------------------------------------------------------
  // ReelGuard: once today's reels hour is used up, decides whether a reel may
  // be shown, based on where you came from. Reels are always one at a time:
  //   from a DM thread      -> only that reel, then back to the thread
  //   from an account page  -> only that reel, then back to the account's grid
  //   from a fresh tab      -> only that reel (a link someone sent you)
  //   from anywhere else    -> blocked, back to where you were
  // ---------------------------------------------------------------------------

  const ALLOW = Object.freeze({ action: 'allow' });
  const redirect = (to) => ({ action: 'redirect', to });

  class ReelGuard {
    constructor(saved) {
      this.ctx = (saved && saved.ctx) || null;         // last page that wasn't a reel
      this.session = (saved && saved.session) || null; // { mode, ids, returnUrl } while a reel is open
      this.played = 0;                                 // distinct reels seen playing (URL may not change)
    }

    toJSON() {
      return { ctx: this.ctx, session: this.session };
    }

    onUrl(href) {
      const path = new URL(href, BASE).pathname;
      const route = classify(path);
      if (route.type === 'reel') return this.onReel(route.id);
      this.session = null;
      if (route.type === 'reelsFeed') return redirect('/');
      this.ctx = contextFor(route, path);
      return ALLOW;
    }

    onReelPlayed() {
      if (!this.session) return ALLOW;
      this.played += 1;
      return this.enforce();
    }

    onReel(id) {
      if (this.session) {
        if (!this.session.ids.includes(id)) this.session.ids.push(id);
        return this.enforce();
      }
      const ctx = this.ctx;
      let returnUrl;
      if (!ctx) returnUrl = '/';
      else if (ctx.kind === 'dm') returnUrl = ctx.url;
      else if (ctx.kind === 'profile') returnUrl = `/${ctx.user}/`;
      else return redirect(ctx.url);
      this.session = { mode: 'single', ids: [id], returnUrl };
      this.played = 0;
      return ALLOW;
    }

    enforce() {
      const s = this.session;
      if (Math.max(s.ids.length, this.played) <= 1) return ALLOW;
      this.session = null;
      return redirect(s.returnUrl);
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { CONFIG, classify, ReelGuard };
    return;
  }

  // ---------------------------------------------------------------------------
  // Page cleanup. Selectors use hrefs and aria labels, never Instagram's
  // generated class names, so they survive most redesigns. If something
  // reappears after an Instagram update, this is the place to fix it.
  // Every restriction applies only once today's reels hour is used up
  // (html[data-rf-limit]); before that, Instagram looks exactly as normal.
  // ---------------------------------------------------------------------------

  const RULES = {
    reelsNav: 'a[href="/reels/"], a[href$="instagram.com/reels/"]',
    appPrompts: 'a[href*="apps.apple.com"], a[href*="itunes.apple.com"], a[href^="instagram://"]',
    smartBanner: 'meta[name="apple-itunes-app"]',
    reelLink: 'a[href*="/reel/"]',
    // Anything inside a feed post that means it's a reel or video.
    reelPostHints: 'a[href*="/reel/"], video, svg[aria-label="Reel"], svg[aria-label="Clip"], svg[aria-label*="udio"]',
    dialog: '[role="dialog"]',
    scrollCandidates: 'main div, main section',
  };

  const LIMITED = 'html[data-rf-limit]';
  const OURS = '.rf-tabbar, .rf-badge, .rf-panel, .rf-timer';  // ReelFree's own elements

  // Video posts in the feed (on Instagram these are reels): the video is
  // blanked under a "Reel hidden" cover and paused from JS.
  const FEED_VIDEO_CSS = `
${LIMITED}[data-rf-route="home"] article video { visibility: hidden !important; }
${LIMITED}[data-rf-route="home"] article div:has(> video) { position: relative !important; }
${LIMITED}[data-rf-route="home"] article div:has(> video)::after {
  content: "Reel hidden"; position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center; pointer-events: none;
  background: #121212; color: rgba(255, 255, 255, 0.6);
  font: 600 15px -apple-system, system-ui, sans-serif;
}`;

  // A whole reel post in the feed (creator, caption and buttons included) is
  // made invisible with a "Reel hidden" label in its place. It keeps its size,
  // so the feed never shifts.
  const REEL_POST_CSS = `
${LIMITED}[data-rf-route="home"] article.rf-reel-post { position: relative !important; pointer-events: none !important; }
${LIMITED}[data-rf-route="home"] article.rf-reel-post > * { visibility: hidden !important; }
${LIMITED}[data-rf-route="home"] article.rf-reel-post::after {
  content: "Reel hidden"; position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  color: rgba(142, 142, 142, 0.9); font: 600 15px -apple-system, system-ui, sans-serif;
}`;

  const CSS = `
${RULES.appPrompts} { display: none !important; }
${REEL_POST_CSS}
.rf-hidden { display: none !important; }

/* Reels tab */
${LIMITED} ${RULES.reelsNav}, ${LIMITED} .rf-reels-tab { display: none !important; }

/* Reels in the home feed are blanked where they are, never removed.
   Instagram lays its feed out from the posts' heights, so removing or
   collapsing posts makes it glitch, go blank and jump to the top. */
${LIMITED}[data-rf-route="home"] ${RULES.reelLink} { pointer-events: none !important; }
${LIMITED}[data-rf-route="home"] ${RULES.reelLink} img { visibility: hidden !important; }
${CONFIG.hideFeedVideos ? FEED_VIDEO_CSS : ''}

/* Explore, hashtag and location grids. Search stays. */
${LIMITED}[data-rf-grid="off"] a[href*="/p/"],
${LIMITED}[data-rf-grid="off"] a[href*="/reel/"],
${LIMITED}[data-rf-grid="off"] div:has(> a[href*="/p/"]),
${LIMITED}[data-rf-grid="off"] div:has(> a[href*="/reel/"]) { display: none !important; }

/* One reel at a time: no scrolling on to more */
${LIMITED}[data-rf-single], ${LIMITED}[data-rf-single] body,
${LIMITED} .rf-locked { overflow: hidden !important; overscroll-behavior: none !important; }

.rf-badge {
  position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 72px);
  transform: translateX(-50%); z-index: 2147483647; pointer-events: none; max-width: 86vw;
  background: rgba(0, 0, 0, 0.8); color: #fff; border-radius: 999px; padding: 6px 12px;
  font: 600 13px -apple-system, system-ui, sans-serif; text-align: center;
}
.rf-timer {
  position: fixed; top: calc(env(safe-area-inset-top, 0px) + 8px); left: 50%; transform: translateX(-50%);
  z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity 0.3s;
  background: rgba(0, 0, 0, 0.65); color: #fff; border-radius: 999px; padding: 4px 10px;
  font: 600 12px -apple-system, system-ui, sans-serif; font-variant-numeric: tabular-nums;
}
.rf-timer.rf-timer-on { opacity: 1; }
.rf-panel {
  position: fixed; top: calc(env(safe-area-inset-top, 0px) + 4px); left: 8px; right: 8px;
  z-index: 2147483647; max-height: 45vh; overflow: auto; padding: 8px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.88); color: #7CFC00; white-space: pre-wrap; word-break: break-all;
  font: 11px/1.4 ui-monospace, Menlo, monospace;
}

/* Bottom tab bar in the DM inbox: a copy of Instagram's own bar from another
   page, with its computed styles inlined, so it looks exactly the same. */
.rf-tabbar {
  position: fixed !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
  z-index: 2147483000; margin: 0; padding-bottom: env(safe-area-inset-bottom, 0px);
}
.rf-tabbar a, .rf-tabbar [role="button"] { -webkit-tap-highlight-color: transparent; }
html[data-rf-tabbar] body {
  padding-bottom: calc(var(--rf-tabbar-height, 50px) + env(safe-area-inset-bottom, 0px)) !important;
}
/* Stand-in, only until Instagram's bar has been seen once */
.rf-tabbar-fallback {
  display: flex; align-items: stretch; background: #fff; color: #000;
  border-top: 0.5px solid rgba(0, 0, 0, 0.12);
}
.rf-tabbar-fallback[data-theme="dark"] { background: #000; color: #f5f5f5; border-top-color: rgba(255, 255, 255, 0.15); }
.rf-tabbar-fallback a { flex: 1 1 0; height: 50px; display: flex; align-items: center; justify-content: center; color: inherit !important; }
.rf-tabbar-fallback svg {
  width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
`;

  const STATE_KEY = 'reelfree:state';
  const LAST_KEY = 'reelfree:last';
  const LOOP_KEY = 'reelfree:redirects';
  const DEBUG_KEY = 'reelfree:debug';
  const REEL_TIME_KEY = 'reelfree:reelTime';

  const store = {
    get(area, key) {
      try { return JSON.parse(window[area].getItem(key)); } catch (_) { return null; }
    },
    set(area, key, value) {
      try { window[area].setItem(key, JSON.stringify(value)); } catch (_) { /* storage unavailable */ }
    },
  };

  // --- Error capture, so the status panel can show what went wrong ----------

  // Recent script activity, included in the debug report.
  const events = [];
  function log(type, detail) {
    events.push(`${new Date().toISOString().slice(11, 23)} ${type} ${detail || ''}`);
    if (events.length > 300) events.shift();
  }

  const errors = [];
  function report(err) {
    errors.push(String((err && err.message) || err));
    if (errors.length > 5) errors.shift();
    log('error', String((err && err.stack) || err).slice(0, 300));
  }
  const safe = (fn) => function (...args) {
    try { return fn.apply(this, args); } catch (err) { report(err); return undefined; }
  };

  // Visit instagram.com/#rfdebug to show the status panel; tap the panel to hide it.
  if (location.hash === '#rfdebug') store.set('sessionStorage', DEBUG_KEY, true);
  const debugOn = () => store.get('sessionStorage', DEBUG_KEY) === true;

  const guard = new ReelGuard(store.get('sessionStorage', STATE_KEY));
  const save = () => store.set('sessionStorage', STATE_KEY, guard);

  const style = document.createElement('style');
  style.textContent = CSS;
  const mountStyle = () => {
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  };

  function showToast(text, ms = 3500) {
    if (!document.body) return;
    const toast = document.createElement('div');
    toast.className = 'rf-badge';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
  }

  // --- Daily reels hour ----------------------------------------------------
  // Instagram is completely normal until you've spent CONFIG.dailyReelMinutes
  // watching reels today. Then the limits switch on until midnight. Time counts
  // while a reel page is open or a video is playing on screen, except in DMs
  // and stories.

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function reelSecondsToday() {
    const saved = store.get('localStorage', REEL_TIME_KEY);
    return saved && saved.day === today() ? saved.seconds : 0;
  }

  const reelSecondsLeft = () => Math.max(0, CONFIG.dailyReelMinutes * 60 - reelSecondsToday());

  let limited = false;

  function isOnScreen(el) {
    const r = el.getBoundingClientRect();
    const visibleHeight = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return r.height > 0 && visibleHeight >= r.height * 0.5;
  }

  const videoPlaying = () => [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended && isOnScreen(v));

  // Only the one reel a friend sent you is free. Swiping on from it, whether
  // the address changes or the reel plays in an overlay inside the chat, counts.
  function watchingReels() {
    if (routeType === 'story') return false;
    if (routeType === 'dm') return dmPlays.size > 1 && videoPlaying();
    if (routeType === 'reel' && friendReelId !== null) {
      return classify(location.pathname).id !== friendReelId || reelPlays.size > 1;
    }
    if (routeType === 'reel' || routeType === 'reelsFeed') return true;
    return videoPlaying();
  }

  function tickReelTime() {
    updateLimit();
    if (limited || document.visibilityState !== 'visible' || !watchingReels()) {
      hideReelTimer();
      return;
    }
    const seconds = reelSecondsToday() + 1;
    store.set('localStorage', REEL_TIME_KEY, { day: today(), seconds });
    const left = Math.max(0, CONFIG.dailyReelMinutes * 60 - seconds);
    showReelTimer(left);
    if (left === 5 * 60) showToast('5 minutes of reels left today');
    if (left <= 0) {
      hideReelTimer(true);
      updateLimit();
    }
  }

  // The countdown pill, shown only while time is being counted. Its text is
  // updated in place, so the page-change observer isn't woken every second.
  let timer = null;
  let timerText = null;
  let timerIdleSince = 0;

  function showReelTimer(secondsLeft) {
    if (!CONFIG.showReelTimer || !document.body) return;
    if (!timer) {
      timer = document.createElement('div');
      timer.className = 'rf-timer';
      timerText = document.createTextNode('');
      timer.appendChild(timerText);
    }
    if (!timer.isConnected) document.body.appendChild(timer);
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = String(secondsLeft % 60).padStart(2, '0');
    timerText.data = `Reels ${minutes}:${seconds} left`;
    timer.classList.add('rf-timer-on');
    timerIdleSince = 0;
  }

  // Fades out after 2 seconds of not counting (or straight away with `now`).
  function hideReelTimer(now = false) {
    if (!timer || !timer.classList.contains('rf-timer-on')) return;
    if (!timerIdleSince) timerIdleSince = Date.now();
    if (now || Date.now() - timerIdleSince >= 2000) timer.classList.remove('rf-timer-on');
  }

  // `announce` is false at page load, so the message only shows when the
  // limits switch on while you're using Instagram.
  function updateLimit(announce = true) {
    const now = reelSecondsLeft() === 0;
    if (now === limited) return;
    limited = now;
    const html = document.documentElement;
    if (limited) html.setAttribute('data-rf-limit', '');
    else html.removeAttribute('data-rf-limit');
    log('limit', limited ? "today's reels hour is used up" : 'reels hour available');
    if (limited) {
      if (announce) showToast("That's your hour of reels for today", 5000);
      lastHref = null;  // re-check the page you're on under the limits
      checkUrl();
    } else {
      document.querySelectorAll('.rf-locked').forEach((el) => el.classList.remove('rf-locked'));
    }
  }

  // Guard against redirect loops if Instagram ever bounces us back.
  function tooManyRedirects() {
    const now = Date.now();
    const recent = (store.get('sessionStorage', LOOP_KEY) || []).filter((t) => now - t < 5000);
    recent.push(now);
    store.set('sessionStorage', LOOP_KEY, recent);
    return recent.length > 3;
  }

  function act(decision) {
    if (decision.action !== 'redirect' || decision.to === location.pathname) return;
    if (!limited) return;  // reels hour still running: Instagram as normal
    if (tooManyRedirects()) {
      log('redirect-skipped', `loop guard, wanted ${redactPath(decision.to)}`);
      return;
    }
    log('redirect', redactPath(decision.to));
    location.replace(decision.to);
  }

  // --- "Resume where you left off" when reopening from the Home Screen -------

  const RESUMABLE = new Set(['dm', 'profile', 'post', 'exploreSearch']);

  function rememberLastPage(route) {
    if (RESUMABLE.has(route.type) || route.type === 'home') {
      store.set('localStorage', LAST_KEY, { path: location.pathname + location.search, t: Date.now() });
    }
  }

  function maybeResume() {
    if (!CONFIG.resumeMinutes || location.pathname !== '/' || location.hash) return false;
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (nav && nav.type !== 'navigate') return false; // reload or back/forward
    if (document.referrer.includes('instagram.com')) return false;
    const last = store.get('localStorage', LAST_KEY);
    if (!last || last.path === '/' || Date.now() - last.t > CONFIG.resumeMinutes * 60000) return false;
    location.replace(last.path);
    return true;
  }

  // --- Route tracking ------------------------------------------------------

  let lastHref = null;
  let routeType = null;
  let reelPlays = new Set();  // distinct reels played on a reel page
  let dmPlays = new Set();    // distinct full-screen videos played inside a DM thread
  let friendReelId = null;    // the reel opened from a chat, which doesn't use up reels time
  let lastPath = null;        // the page before this one

  function isSingle() {
    return limited && routeType === 'reel' && guard.session !== null;
  }

  function applyRouteAttrs() {
    const html = document.documentElement;
    if (html.getAttribute('data-rf-route') !== routeType) html.setAttribute('data-rf-route', routeType);
    const gridOff = routeType === 'explore' || routeType === 'exploreSearch' || routeType === 'tagOrLocation';
    if (gridOff && !html.hasAttribute('data-rf-grid')) html.setAttribute('data-rf-grid', 'off');
    if (!gridOff && html.hasAttribute('data-rf-grid')) html.removeAttribute('data-rf-grid');
    if (limited && !html.hasAttribute('data-rf-limit')) html.setAttribute('data-rf-limit', '');
    if (isSingle()) {
      if (!html.hasAttribute('data-rf-single')) html.setAttribute('data-rf-single', '');
    } else if (html.hasAttribute('data-rf-single')) {
      html.removeAttribute('data-rf-single');
      document.querySelectorAll('.rf-locked').forEach((el) => el.classList.remove('rf-locked'));
    }
  }

  function checkUrl() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    const route = classify(location.pathname);
    if (route.type === 'reel' && routeType !== 'reel') reelPlays = new Set();
    // The reel a friend sent: the first one opened from inside a chat. Reels
    // reached from the inbox (like its Reels tab) aren't friends' reels.
    const cameFrom = lastPath || (routeType === null && guard.ctx ? guard.ctx.url : '');
    if (route.type !== 'reel') {
      friendReelId = null;
    } else if (routeType !== 'reel' && cameFrom.startsWith('/direct/t/')) {
      friendReelId = route.id;
    }
    lastPath = location.pathname;
    dmPlays = new Set();
    routeType = route.type;
    const decision = guard.onUrl(href);
    log('page', `${redactPath(location.pathname)} = ${route.type} -> ${decision.action}${limited ? '' : ' (reels hour)'}`);
    save();
    rememberLastPage(route);
    applyRouteAttrs();
    act(decision);
    scheduleTidy();
  }

  // Counts reels by playback too, in case a reel viewer swipes without changing the URL.
  function isFullScreenVideo(video, minHeight) {
    const r = video.getBoundingClientRect();
    const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return r.height > innerHeight * minHeight && visible >= r.height * 0.6;
  }

  function onPlaying(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    checkUrl();
    const key = video.currentSrc || video.src || video;
    if (routeType === 'home' && CONFIG.hideFeedVideos && video.closest('article')) {
      if (!limited) return;
      // Blanked feed reels shouldn't play sound behind their cover.
      video.muted = true;
      video.pause();
      return;
    }
    // Plays are tracked during the reels hour too, so reels time knows when
    // you've swiped past the reel a friend sent.
    if (routeType === 'dm') {
      // A reel opened from a DM as an overlay, without changing the URL:
      // the first one plays, swiping to a second reloads the chat.
      if (!isFullScreenVideo(video, 0.7)) return;
      dmPlays.add(key);
      if (!limited) return;
      log('dm-video', `full-screen video #${dmPlays.size} in a chat`);
      if (dmPlays.size > 1 && !tooManyRedirects()) {
        log('reload', 'second reel swiped to inside a chat');
        location.reload();
      }
      return;
    }
    if (routeType !== 'reel' || !isFullScreenVideo(video, 0.4) || reelPlays.has(key)) return;
    reelPlays.add(key);
    if (!limited) return;
    log('reel-played', `#${reelPlays.size}`);
    const decision = guard.onReelPlayed();
    save();
    act(decision);
  }

  // --- DOM cleanup ---------------------------------------------------------

  // Mark an element together with wrappers that exist only to hold it, so a
  // hidden nav item doesn't leave a gap.
  function markWithWrappers(selector, className) {
    for (const el of document.querySelectorAll(selector)) {
      let node = el;
      for (let i = 0; i < 3; i++) {
        const parent = node.parentElement;
        if (!parent || parent.children.length !== 1 || parent.matches('main, nav, header, footer, body, [role="navigation"]')) break;
        node = parent;
      }
      if (node !== el) node.classList.add(className);
    }
  }

  // Tapping a reel in the home feed does nothing (it would open the reel viewer).
  function blockFeedReelTap(event) {
    if (!limited || routeType !== 'home' || !(event.target instanceof Element)) return;
    if (!event.target.closest(RULES.reelLink)) return;
    event.preventDefault();
    event.stopPropagation();
    log('blocked', 'tap on a feed reel');
  }

  // Which post an article shows: the ID from its permalink, or '' while
  // Instagram hasn't filled it in yet.
  function postKey(article) {
    for (const link of article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const match = /\/(?:p|reel)\/([^/?#]+)/.exec(link.getAttribute('href') || '');
      if (match) return match[1];
    }
    return '';
  }

  // Marks reel posts in the home feed so the CSS above hides all of them. A
  // mark stays even when Instagram unloads the post's video as it scrolls, so
  // the creator never flashes back. It's only removed if Instagram reuses the
  // element for a different post.
  function markReelPosts() {
    const hints = CONFIG.hideFeedVideos ? RULES.reelPostHints : RULES.reelLink;
    for (const article of document.querySelectorAll('article.rf-reel-post')) {
      const saved = article.getAttribute('data-rf-post');
      const key = postKey(article);
      if (saved && key && key !== saved) {
        article.classList.remove('rf-reel-post');
        article.removeAttribute('data-rf-post');
      } else if (key && !saved) {
        article.setAttribute('data-rf-post', key);
      }
    }
    for (const article of document.querySelectorAll('article:not(.rf-reel-post)')) {
      if (!article.querySelector(hints)) continue;
      article.classList.add('rf-reel-post');
      const key = postKey(article);
      if (key) article.setAttribute('data-rf-post', key);
    }
  }

  // A reel tapped on an account opens full screen, one reel at a time (the
  // guard sends you back to the account if you swipe to another).
  function openProfileReelFullScreen(event) {
    if (!limited || routeType !== 'profile' || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    let match = /\/reel\/([^/?#]+)/.exec(href);
    if (!match && link.querySelector('svg[aria-label="Clip"], svg[aria-label="Reel"], svg[aria-label="Reels"]')) {
      match = /\/p\/([^/?#]+)/.exec(href);
    }
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    log('profile-reel', 'opening full screen');
    location.assign(`/reels/${match[1]}/`);
  }

  function lockScrollers() {
    for (const el of document.querySelectorAll(RULES.scrollCandidates)) {
      if (el.classList.contains('rf-locked') || el.closest(RULES.dialog)) continue;
      if (el.scrollHeight - el.clientHeight < 20) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') el.classList.add('rf-locked');
    }
  }

  // --- Tab bar in the DM inbox --------------------------------------------
  // Instagram's mobile site drops its bottom bar in DMs. This puts back an
  // exact copy of the bar from another page: its elements with their computed
  // styles inlined, so colors, sizes and icons match. Tapping a tab switches
  // page inside Instagram, without reloading. Chats keep the message box at
  // the bottom, like the app.

  const NAV_KEY = 'reelfree:navbar2';  // renamed to drop copies saved by older, looser detection
  const USERNAME_PATH = /^\/([A-Za-z0-9._]{1,30})\/$/;
  const NAV_ITEM = 'a, button, [role="button"]';

  const SNAPSHOT_PROPS = [
    'display', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'gap',
    'justify-content', 'align-items', 'align-self', 'box-sizing', 'width', 'height', 'min-width',
    'min-height', 'max-width', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width',
    'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style',
    'border-right-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
    'border-left-width', 'border-left-style', 'border-left-color', 'border-radius', 'background-color',
    'color', 'fill', 'stroke', 'stroke-width', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'overflow', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'opacity',
    'visibility', 'object-fit', 'transform', 'cursor',
  ];

  // Stand-in icons until Instagram's own bar has been seen once.
  const ICONS = {
    home: '<path d="M9 16.5a3 3 0 0 1 6 0V22h7V11.5L12 2 2 11.5V22h7Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="8.5"/><path d="M16.5 16.5 22 22"/>',
    messages: '<path d="M22 3 9.2 10.1M11.7 20.3 22 3H2l7.2 7.1 2.5 10.2Z"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const FALLBACK_BAR = [
    `<a href="/" aria-label="Home">${icon('home')}</a>`,
    `<a href="/explore/search/" aria-label="Search">${icon('search')}</a>`,
    `<a href="/direct/inbox/" aria-label="Messages">${icon('messages')}</a>`,
  ].join('');

  function fragment(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  function fixedAncestor(el) {
    for (let node = el, i = 0; node && i < 10; node = node.parentElement, i++) {
      const position = getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') return node;
    }
    return null;
  }

  const MAX_BAR_HEIGHT = 150;

  // Instagram's bottom bar: the outermost element along the bottom edge that
  // spans the screen, is at most MAX_BAR_HEIGHT tall and holds 3+ tabs. Never
  // a whole page section, whether or not the bar is position: fixed.
  function findInstagramNav() {
    if (typeof document.elementFromPoint === 'function') {
      for (const x of [0.5, 0.3, 0.7]) {
        let found = null;
        for (let el = document.elementFromPoint(innerWidth * x, innerHeight - 4); el && el !== document.body; el = el.parentElement) {
          if (el.closest(OURS)) break;
          const r = el.getBoundingClientRect();
          if (r.height > MAX_BAR_HEIGHT) break;
          if (r.width >= innerWidth * 0.9 && r.bottom >= innerHeight - 2 && navItems(el).length >= 3) found = el;
        }
        if (found) return found;
      }
    }
    // Fallback: the small fixed bar holding your profile picture link.
    for (const img of document.querySelectorAll('a[href] img')) {
      const link = img.closest('a');
      const match = USERNAME_PATH.exec(link.getAttribute('href') || '');
      if (!match || RESERVED.has(match[1]) || link.closest(OURS)) continue;
      if (link.getBoundingClientRect().top < innerHeight - MAX_BAR_HEIGHT) continue;
      const bar = fixedAncestor(link);
      if (bar && bar.getBoundingClientRect().height <= MAX_BAR_HEIGHT) return bar;
    }
    return null;
  }

  function navItems(bar) {
    return [...bar.querySelectorAll(NAV_ITEM)].filter((el) => {
      const outer = el.parentElement && el.parentElement.closest(NAV_ITEM);
      if (outer && bar.contains(outer)) return false;
      return !!el.querySelector('svg, img');
    });
  }

  function navLabel(el) {
    const label = el.querySelector('svg[aria-label]');
    if (label) return label.getAttribute('aria-label');
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    return el.querySelector('img') ? 'Profile' : '';
  }

  // A self-contained copy of Instagram's bar: the same elements, each with its
  // computed style inlined and Instagram's classes removed.
  function snapshotBar(bar) {
    const copy = bar.cloneNode(true);
    const sources = [bar, ...bar.querySelectorAll('*')];
    const targets = [copy, ...copy.querySelectorAll('*')];
    sources.forEach((node, i) => {
      const computed = getComputedStyle(node);
      const target = targets[i];
      target.removeAttribute('class');
      target.removeAttribute('id');
      target.setAttribute('style', SNAPSHOT_PROPS.map((p) => `${p}:${computed.getPropertyValue(p)}`).join(';'));
    });
    // The copy sits inside ReelFree's own fixed container.
    for (const prop of ['top', 'right', 'bottom', 'left', 'transform']) copy.style.setProperty(prop, 'auto');
    copy.style.setProperty('position', 'relative');
    copy.style.setProperty('width', '100%');
    copy.style.setProperty('transform', 'none');
    return copy.outerHTML;
  }

  // Keep a copy of the bar. A copy taken where none of its tabs is the current
  // page (so no icon is drawn as selected) is preferred over others.
  // Pages whose bottom edge is Instagram's tab bar. Story and reel viewers are
  // excluded: their reply box and buttons along the bottom looked like a bar,
  // and a copy of the story viewer ended up in the DM inbox.
  const BAR_PAGES = new Set(['home', 'profile', 'explore', 'exploreSearch', 'tagOrLocation', 'post']);

  let navLearnedFor = null;
  function learnNav() {
    if (!BAR_PAGES.has(routeType) || navLearnedFor === location.pathname) return;
    const bar = findInstagramNav();
    if (!bar) return;
    navLearnedFor = location.pathname;
    const neutral = !navItems(bar).some((el) => el.getAttribute('href') === location.pathname);
    const saved = store.get('localStorage', NAV_KEY);
    if (saved && saved.neutral && !neutral) return;
    store.set('localStorage', NAV_KEY, { html: snapshotBar(bar), background: rgbOf(bar), neutral });
  }

  // A tab that isn't a link (like New post) is opened by going Home and
  // tapping Instagram's own button there.
  let pendingNav = null;
  try {
    if (location.hash.startsWith('#rfnav=')) {
      pendingNav = { label: decodeURIComponent(location.hash.slice(7)), until: Date.now() + 8000 };
    }
  } catch (_) { /* malformed hash */ }

  function runPendingNav() {
    if (!pendingNav) return;
    if (Date.now() > pendingNav.until) {
      pendingNav = null;
      return;
    }
    const bar = findInstagramNav();
    const target = bar && navItems(bar).find((el) => navLabel(el) === pendingNav.label);
    if (!target) return;
    pendingNav = null;
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    target.click();
  }

  // Switch page the way Instagram's own links do, without reloading: change the
  // address and tell Instagram's router. If Instagram doesn't follow within
  // 1.5 seconds, load the page normally.
  function spaNavigate(path, fallback = path) {
    log('tab', redactPath(path));
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate', { state: null }));
    checkUrl();
    setTimeout(safe(() => {
      if (location.pathname !== new URL(path, location.href).pathname) return;
      const followed = findInstagramNav() || !document.querySelector('a[href^="/direct/t/"]');
      if (followed) return;
      log('tab', "Instagram didn't switch pages; loading normally");
      location.assign(fallback);
    }), 1500);
  }

  function onTabbarClick(event) {
    const item = event.target instanceof Element && event.target.closest(NAV_ITEM);
    if (!item || !tabbar || !tabbar.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    const href = item.getAttribute('href');
    if (href) {
      spaNavigate(href);
    } else {
      const label = navLabel(item);
      pendingNav = { label, until: Date.now() + 8000 };
      spaNavigate('/', `/#rfnav=${encodeURIComponent(label)}`);
    }
  }

  function pageIsDark() {
    const color = pageColor();
    if (color) return 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] < 128;
    return !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let tabbar = null;
  let tabbarSource = '';
  function renderTabbar() {
    const html = document.documentElement;
    const show = routeType === 'dm' && !location.pathname.startsWith('/direct/t/');
    if (!show) {
      if (tabbar) tabbar.remove();
      tabbar = null;
      if (html.hasAttribute('data-rf-tabbar')) html.removeAttribute('data-rf-tabbar');
      return;
    }
    if (!document.body) return;
    const saved = store.get('localStorage', NAV_KEY);
    const source = saved && saved.html ? saved.html : 'fallback';
    if (!tabbar || tabbarSource !== source) {
      if (tabbar) tabbar.remove();
      tabbar = document.createElement('div');
      tabbar.className = 'rf-tabbar';
      if (saved && saved.html) {
        tabbar.append(fragment(saved.html));
        if (saved.background) tabbar.style.backgroundColor = `rgb(${saved.background.join(',')})`;
      } else {
        tabbar.classList.add('rf-tabbar-fallback');
        tabbar.append(fragment(FALLBACK_BAR));
      }
      tabbar.addEventListener('click', safe(onTabbarClick), true);
      tabbarSource = source;
    }
    if (!tabbar.isConnected) document.body.appendChild(tabbar);
    if (tabbar.classList.contains('rf-tabbar-fallback')) {
      const theme = pageIsDark() ? 'dark' : 'light';
      if (tabbar.getAttribute('data-theme') !== theme) tabbar.setAttribute('data-theme', theme);
    }
    const height = `${tabbar.offsetHeight || 50}px`;
    if (html.style.getPropertyValue('--rf-tabbar-height') !== height) html.style.setProperty('--rf-tabbar-height', height);
    if (!html.hasAttribute('data-rf-tabbar')) html.setAttribute('data-rf-tabbar', '');
  }

  // --- Full screen ---------------------------------------------------------
  // Browsers only allow full screen from a tap, so this runs on every tap
  // until it's active (and again if something like the keyboard exits it).
  // Safari on iPhone doesn't offer this for pages, so there it does nothing.

  const fullscreenActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function fullscreenRequest() {
    const root = document.documentElement;
    return root.requestFullscreen || root.webkitRequestFullscreen || null;
  }

  function goFullscreen() {
    const request = fullscreenRequest();
    if (!CONFIG.fullscreen || !request || fullscreenActive()) return;
    const result = request.call(document.documentElement);
    if (result && result.catch) result.catch(report);
  }

  // --- Colors for the app ----------------------------------------------------
  // The app paints the strips behind the status bar and the home indicator,
  // and the background shown while swiping back. This tells it the colors of
  // Instagram's own top and bottom bars and page, so they match.

  function rgbOf(el) {
    const rgba = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || []).map(Number);
    return rgba.length >= 3 && (rgba.length < 4 || rgba[3] > 0.5) ? rgba.slice(0, 3).map(Math.round) : null;
  }

  // The page's visible background: the first solid background behind the
  // middle of the screen, skipping posts and media. Instagram paints it on an
  // inner element, so <body> alone can be white while the page looks grey.
  // Only a page-sized container counts (full width, at least half the screen
  // tall), so message bubbles, loading placeholders and other small parts of
  // the page can't be mistaken for the background.
  function pageColor() {
    if (typeof document.elementFromPoint === 'function') {
      for (const y of [0.5, 0.35, 0.65]) {
        let el = document.elementFromPoint(innerWidth / 2, innerHeight * y);
        if (el && el.closest(OURS)) continue;
        for (; el; el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.5) continue;
          const color = rgbOf(el);
          if (color) return color;
        }
      }
    }
    return (document.body && rgbOf(document.body)) || rgbOf(document.documentElement);
  }

  // The color of the fixed bar at this height, or the page background when
  // nothing fixed is there (so scrolling content never changes the color).
  function barColorAt(y) {
    let color = null;
    for (let el = document.elementFromPoint(innerWidth / 2, y); el; el = el.parentElement) {
      color = color || rgbOf(el);
      const position = getComputedStyle(el).position;
      if (position === 'fixed' || position === 'sticky') return color || pageColor();
    }
    return pageColor();
  }

  let lastBarColors = '';
  function reportBarColors() {
    const handlers = window.webkit && window.webkit.messageHandlers;
    const handler = handlers && handlers.reelfreeBars;
    if (!handler || !document.body) return;
    const colors = { top: barColorAt(1), bottom: barColorAt(innerHeight - 1), page: pageColor() };
    const key = JSON.stringify(colors);
    if (key === lastBarColors) return;
    lastBarColors = key;
    handler.postMessage(colors);
  }

  // --- New-message signals (iPhone app) -------------------------------------
  // When the page title, an unread counter or the inbox changes, Instagram has
  // probably received a message over its live connection. The app then checks
  // the inbox right away (only while it's in the background). Nothing about
  // the change itself is sent, only that something changed.

  let lastSignalKey = null;
  let lastSignalCheck = 0;
  let signalFollowUp = null;
  function watchMessageSignals() {
    const handlers = window.webkit && window.webkit.messageHandlers;
    const handler = handlers && handlers.reelfreeInstagramSignal;
    if (!handler) return;
    if (Date.now() - lastSignalCheck < 250) {
      // Look again shortly, so a change right after a look isn't missed.
      if (!signalFollowUp) {
        signalFollowUp = setTimeout(() => {
          signalFollowUp = null;
          safe(watchMessageSignals)();
        }, 300);
      }
      return;
    }
    lastSignalCheck = Date.now();
    const inbox = [...document.querySelectorAll('a[href^="/direct/"]')]
      .filter((a) => !a.closest(OURS))
      .map((a) => `${a.getAttribute('aria-label') || ''}${a.textContent.trim()}`)
      .join('|');
    const key = `${document.title}|${inbox}`;
    if (lastSignalKey !== null && key !== lastSignalKey) handler.postMessage({ reason: 'page changed' });
    lastSignalKey = key;
  }

  // --- Debug report --------------------------------------------------------
  // The app builds this when you shake the phone. It describes the page's
  // layout and what the script did, with no text and no usernames, so problems
  // can be fixed against Instagram's real page.

  function redactPath(path) {
    const parts = String(path).split('/');
    return parts.map((part, i) => {
      if (i === 1 && part && !RESERVED.has(part) && USERNAME.test(part)) return '@user';
      if (i === 2 && parts[1] === 'stories' && part) return '@user';
      return part;
    }).join('/');
  }

  // Sudden jumps back up, and the page suddenly getting much shorter.
  const scrollTops = new WeakMap();
  let fingerDown = false;
  let lastPageHeight = 0;

  function onScroll(event) {
    const target = event.target === document ? (document.scrollingElement || document.documentElement) : event.target;
    if (!(target instanceof Element)) return;
    const top = target.scrollTop;
    const previous = scrollTops.get(target) || 0;
    scrollTops.set(target, top);
    if (previous - top > innerHeight * 1.5) {
      const where = target === document.scrollingElement ? 'page' : target.tagName.toLowerCase();
      log('jump', `${where} ${Math.round(previous)} -> ${Math.round(top)}, height ${target.scrollHeight}${fingerDown ? ', finger down' : ''}`);
    }
  }

  function trackPageHeight() {
    const height = document.documentElement.scrollHeight;
    if (lastPageHeight - height > innerHeight) log('shrink', `page height ${lastPageHeight} -> ${height}`);
    lastPageHeight = height;
  }

  function describeElement(el) {
    const bits = [el.tagName.toLowerCase()];
    const role = el.getAttribute('role');
    if (role) bits.push(`role=${role}`);
    const label = el.getAttribute('aria-label');
    if (label && label.length <= 40 && !label.includes("'s ")) bits.push(`label="${label}"`);
    const href = el.getAttribute('href');
    if (href) bits.push(`href=${redactPath(href.split('?')[0])}`);
    const rect = el.getBoundingClientRect();
    bits.push(`y=${Math.round(rect.top + scrollY)} h=${Math.round(rect.height)}`);
    const computed = getComputedStyle(el);
    if (computed.position !== 'static') bits.push(computed.position);
    if (computed.display === 'none') bits.push('display:none');
    if (computed.visibility === 'hidden') bits.push('hidden');
    if (computed.transform && computed.transform !== 'none') bits.push('transform');
    if (computed.overflowY === 'auto' || computed.overflowY === 'scroll') bits.push(`scroller(${Math.round(el.scrollTop)}/${el.scrollHeight})`);
    const ours = [...el.classList].filter((name) => name.startsWith('rf-'));
    if (ours.length) bits.push(ours.join(' '));
    if (el.children.length > 1) bits.push(`children=${el.children.length}`);
    return bits.join(' ');
  }

  function pageStructure(root) {
    const lines = [];
    const skip = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template']);
    let articles = 0;
    (function walk(el, depth) {
      if (lines.length >= 3000 || depth > 80) return;
      const tag = el.tagName.toLowerCase();
      if (skip.has(tag) || el.classList.contains('rf-panel')) return;
      // Wrappers with a single child are joined onto one line.
      let node = el;
      let line = describeElement(el);
      for (let i = 0; i < 8 && node.children.length === 1 && node.tagName.toLowerCase() !== 'svg'; i++) {
        node = node.children[0];
        line += ' > ' + describeElement(node);
      }
      lines.push('  '.repeat(Math.min(depth, 40)) + line);
      if (node.tagName.toLowerCase() === 'svg') return;
      if (node.tagName.toLowerCase() === 'article' && ++articles > 4) {
        lines.push('  '.repeat(Math.min(depth + 1, 40)) + '(post contents skipped)');
        return;
      }
      for (const child of node.children) walk(child, depth + 1);
    })(root, 0);
    if (lines.length >= 3000) lines.push('(truncated)');
    return lines;
  }

  function reelTimeSummary() {
    const minutes = Math.floor(reelSecondsToday() / 60);
    return limited
      ? `limits on (reels hour used: ${minutes} of ${CONFIG.dailyReelMinutes} min)`
      : `reels hour: ${minutes} of ${CONFIG.dailyReelMinutes} min used today`;
  }

  function buildReport() {
    const s = guard.session;
    return [
      `ReelFree debug report, script ${VERSION}`,
      `page ${redactPath(location.pathname)} (${routeType})`,
      `browser ${navigator.userAgent}`,
      `screen ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)} of ${document.documentElement.scrollHeight}`,
      reelTimeSummary(),
      `came from ${guard.ctx ? guard.ctx.kind : 'nothing'}; reel ${s ? 'open' : 'none open'}`,
      `DM tab bar: ${store.get('localStorage', NAV_KEY) ? 'copied from Instagram' : 'not copied yet (visit Home)'}`,
      `errors ${errors.join(' | ') || 'none'}`,
      '',
      '--- recent activity ---',
      ...events,
      '',
      '--- page structure (no text, usernames removed) ---',
      ...(document.body ? pageStructure(document.body) : ['(no page yet)']),
    ].join('\n');
  }

  window.__reelfreeReport = () => safe(buildReport)() || `Report failed: ${errors.join(' | ')}`;

  // --- Status badge and debug panel ----------------------------------------

  let badgeShown = !CONFIG.showBadge;
  function showBadge() {
    if (badgeShown || !document.body) return;
    badgeShown = true;
    showToast('ReelFree on', 2500);
  }

  let panel = null;
  function renderPanel() {
    if (!debugOn()) {
      if (panel) panel.remove();
      panel = null;
      return;
    }
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'rf-panel';
      panel.addEventListener('click', () => {
        store.set('sessionStorage', DEBUG_KEY, false);
        renderPanel();
      });
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    const count = (selector) => document.querySelectorAll(selector).length;
    const s = guard.session;
    const navLinks = [...new Set([...document.querySelectorAll('a')]
      .filter((a) => a.querySelector('svg') && !a.closest('article'))
      .map((a) => {
        const label = a.querySelector('svg[aria-label]');
        return `${a.getAttribute('href')}${label ? ` (${label.getAttribute('aria-label')})` : ''}`;
      }))].slice(0, 14);
    const text = [
      `ReelFree ${VERSION} is running. Tap to close.`,
      reelTimeSummary(),
      `page: ${location.pathname} = ${routeType}`,
      `came from: ${guard.ctx ? `${guard.ctx.kind} ${guard.ctx.url}` : 'nothing yet'}`,
      `reel: ${s ? `open, exits to ${s.returnUrl}` : 'none open'}`,
      `page has: main ${count('main')}, article ${count('article')}, video ${count('video')}, reel links ${count('a[href*="/reel/"]')}, dialog ${count(RULES.dialog)}`,
      `icon links: ${navLinks.join(', ') || 'none'}`,
      `DM tab bar: ${store.get('localStorage', NAV_KEY) ? 'copied from Instagram' : 'not copied yet (visit Home)'}`,
      `full screen: ${fullscreenRequest() ? (fullscreenActive() ? 'on' : 'available, tap to enter') : 'not supported here'}`,
      `errors: ${errors.length ? errors.join(' | ') : 'none'}`,
    ].join('\n');
    if (panel.textContent !== text) panel.textContent = text;
  }

  function tidy() {
    checkUrl();
    mountStyle();
    applyRouteAttrs();
    showBadge();
    document.querySelectorAll(RULES.smartBanner).forEach((el) => el.remove());
    markWithWrappers(RULES.reelsNav, 'rf-reels-tab');
    markWithWrappers(RULES.appPrompts, 'rf-hidden');
    if (isSingle()) lockScrollers();
    if (limited && routeType === 'home') markReelPosts();
    if (routeType === 'dm' && dmPlays.size) {
      const viewerOpen = [...document.querySelectorAll('video')]
        .some((v) => v.getBoundingClientRect().height > innerHeight * 0.7);
      if (!viewerOpen) dmPlays = new Set();
    }
    if (routeType !== 'dm') {
      learnNav();
      runPendingNav();
    }
    renderTabbar();
    reportBarColors();
    trackPageHeight();
    renderPanel();
  }

  let tidyQueued = false;
  function scheduleTidy() {
    if (tidyQueued) return;
    tidyQueued = true;
    setTimeout(() => {
      tidyQueued = false;
      safe(tidy)();
    }, 120);
  }

  // --- Start ---------------------------------------------------------------

  function start() {
    if (maybeResume()) return;
    mountStyle();
    updateLimit(false);
    checkUrl();
    new MutationObserver(() => {
      scheduleTidy();
      safe(watchMessageSignals)();  // straight away, not after tidy's delay
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('playing', safe(onPlaying), true);
    document.addEventListener('touchend', safe(goFullscreen), true);
    document.addEventListener('click', safe(goFullscreen), true);
    document.addEventListener('click', safe(blockFeedReelTap), true);
    document.addEventListener('click', safe(openProfileReelFullScreen), true);
    addEventListener('scroll', safe(onScroll), { capture: true, passive: true });
    addEventListener('touchstart', () => { fingerDown = true; }, { capture: true, passive: true });
    addEventListener('touchend', () => { fingerDown = false; }, { capture: true, passive: true });
    addEventListener('popstate', safe(checkUrl));
    addEventListener('pageshow', safe(checkUrl));
    setInterval(safe(checkUrl), 100);
    setInterval(safe(tickReelTime), 1000);
    scheduleTidy();
  }

  if (document.documentElement) {
    safe(start)();
  } else {
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      safe(start)();
    }).observe(document, { childList: true });
  }
})();

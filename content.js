"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_SETTINGS = {
  webguardEnabled: true,
  firewallEnabled: true,
  saveDataHint: true,
  blockImages: true,
  blockVideo: true,
  blockAudio: true,
  blockStreamingMedia: false,
  allowSmallIcons: true,
  iconThreshold: 200,
  videoBufferTarget: 5,
  videoBufferControl: true,
  imagePlaceholders: true,
  preserveBlockedSpace: true,
  tapToUnblock: true,
  highlightBlocked: true,
  hideInlineBg: true,
  hideAllBg: false,
  blockFonts: false,
  blockIframes: false,
  blockObjects: false,
  blockWebSockets: false,
  blockThirdPartyScripts: false,
  blockSpaRouteData: false,
  optimizerEnabled: true,
  lazyLoadMedia: true,
  gpuAccelerate: true,
  stealthTracker: false,
  highlightManaged: false,
  triggerMargin: 300,
  killBackdropBlur: false,
  haltInfiniteAnimations: false,
  disableCssAnimations: false,
  throttleJsAnimations: false,
  disableJsAnimations: false,
  stripSvgFilters: false,
  freezeCanvasMesh: false,
  gateOffscreenCanvas: false,
  suspendIdleAudio: false,
  pauseBackgroundTabs: false,
  removePrefetchPreload: false,
  removePreconnect: false,
  firewallExceptions: "",
  optimizerExceptions: "",
  logLevel: "info",
  loggingEnabled: true
};

const UNBLOCK_EVENT = "webguard:unblocked";
const BLOCKED_CLASS = "wg-blocked";
const PRESERVE_CLASS = "wg-preserve";
const HIGHLIGHT_CLASS = "wg-highlight";
const MANAGED_CLASS = "wg-managed";
const TRACKER_CLASS = "wg-tracker";
const CANVAS_HIDDEN_CLASS = "wg-canvas-hidden";
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const CSS_ONLY_KEYS = new Set([
  "highlightBlocked",
  "highlightManaged",
  "hideInlineBg",
  "hideAllBg",
  "killBackdropBlur",
  "haltInfiniteAnimations",
  "disableCssAnimations",
  "stripSvgFilters",
  "preserveBlockedSpace"
]);

const FIREWALL_KEYS = new Set([
  "firewallEnabled",
  "blockImages",
  "blockVideo",
  "blockAudio",
  "allowSmallIcons",
  "iconThreshold",
  "blockFonts",
  "blockIframes",
  "blockObjects",
  "firewallExceptions"
]);

const OPTIMIZER_KEYS = new Set([
  "optimizerEnabled",
  "lazyLoadMedia",
  "gpuAccelerate",
  "stealthTracker",
  "highlightManaged",
  "optimizerExceptions"
]);

let settings = Object.assign({}, DEFAULT_SETTINGS);
let pageHost = "";
let firewallException = false;
let optimizerException = false;

let blockedCount = 0;
let managedCount = 0;
let blockedImages = 0;
let blockedVideos = 0;
let blockedAudio = 0;
const recentBlocked = [];

const allowedUrls = new Set();
const blockedElements = new Set();
const activeMedia = new Set();
const playedMedia = new WeakSet();
const trackedMedia = new WeakSet();
const backgroundCanvases = new WeakSet();
const gatedCanvases = new Set();
const hiddenAnimations = new Set();
const audioContexts = new Set();

let mediaObserver = null;
let activeTriggerMargin = null;
let canvasObserver = null;
let domObserver = null;
let mutationScheduled = false;
let mutationQueue = [];
let badgeTimer = null;
let audioIdleTimer = null;
let lastUserInteraction = Date.now();
let rafThrottleLast = 0;
let originalRequestAnimationFrame = null;
let internalRequestAnimationFrame = null;
let originalAudioContext = null;

const styleElement = document.createElement("style");
styleElement.id = "webguard-styles";
(document.head || document.documentElement).appendChild(styleElement);

internalRequestAnimationFrame = window.requestAnimationFrame.bind(window);

async function applyLoggingSettings() {
  try {
    const stored = await api.storage.local.get(["logLevel", "loggingEnabled"]);
    const level = stored.logLevel;
    const enabled = stored.loggingEnabled;

    WebGuardLogger.setLevel(
      ["debug", "info", "warn", "error"].includes(level) ? level : "info"
    );

    WebGuardLogger.setEnabled(enabled !== false);
  } catch (error) {
    WebGuardLogger.setLevel("info");
    WebGuardLogger.setEnabled(true);
  }
}

function normalizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function hostList(raw) {
  return String(raw || "").split(/\r?\n/).map(normalizeHostname).filter(Boolean);
}

function refreshSiteState() {
  pageHost = normalizeHostname(location.hostname);
  firewallException = hostList(settings.firewallExceptions).includes(pageHost);
  optimizerException = hostList(settings.optimizerExceptions).includes(pageHost);
}

function firewallActive() {
  return settings.webguardEnabled &&
    settings.firewallEnabled &&
    !firewallException;
}

function optimizerActive() {
  return settings.webguardEnabled &&
    settings.optimizerEnabled &&
    !optimizerException;
}

function recordBlocked(kind, url) {
  if (kind === "image") blockedImages++;
  if (kind === "video") blockedVideos++;
  if (kind === "audio") blockedAudio++;

  let host = "";

  try {
    host = new URL(url, location.href).hostname.replace(/^www\./, "");
  } catch (error) {
    host = "";
  }

  recentBlocked.unshift({
    k: kind,
    h: host,
    t: Date.now()
  });

  if (recentBlocked.length > 5) {
    recentBlocked.length = 5;
  }
}

function scheduleBadgeUpdate() {
  if (badgeTimer) {
    return;
  }

  badgeTimer = setTimeout(() => {
    badgeTimer = null;

    try {
      api.runtime.sendMessage({
        type: "wg-badge",
        blocked: blockedCount,
        managed: managedCount,
        images: blockedImages,
        videos: blockedVideos,
        audio: blockedAudio,
        recent: recentBlocked.slice()
      });
    } catch (error) {
      WebGuardLogger.debug("bdgmsg", {});
    }
  }, 150);
}

const rafQueue = [];

function batchDomWork(callback) {
  rafQueue.push(callback);

  if (rafQueue.length > 1) {
    return;
  }

  internalRequestAnimationFrame(() => {
    const work = rafQueue.splice(0, rafQueue.length);

    for (const task of work) {
      try {
        task();
      } catch (error) {
        WebGuardLogger.warn("domerr", {
          message: String(error && error.message ? error.message : error)
        });
      }
    }
  });
}

function elementUrl(el) {
  if (el instanceof HTMLImageElement) {
    return el.getAttribute("src") || el.getAttribute("data-src") || el.currentSrc || "";
  }

  if (el instanceof HTMLSourceElement) {
    return el.getAttribute("src") || el.getAttribute("srcset") || "";
  }

  return el.getAttribute("src") || el.getAttribute("data") || "";
}

function isSmallIcon(el) {
  if (!settings.allowSmallIcons || !(el instanceof HTMLImageElement)) {
    return false;
  }

  const threshold = Number(settings.iconThreshold);
  const safeThreshold = Number.isFinite(threshold) ? threshold : 200;

  const attrWidth = parseInt(el.getAttribute("width") || "0", 10) || 0;
  const attrHeight = parseInt(el.getAttribute("height") || "0", 10) || 0;

  return attrWidth > 0 &&
    attrWidth <= safeThreshold &&
    attrHeight > 0 &&
    attrHeight <= safeThreshold;
}

function firewallKindFor(el) {
  if (el instanceof HTMLImageElement || el instanceof HTMLPictureElement || el instanceof HTMLSourceElement) {
    return settings.blockImages ? "image" : null;
  }

  if (el instanceof HTMLVideoElement) {
    return settings.blockVideo ? "video" : null;
  }

  if (el instanceof HTMLAudioElement) {
    return settings.blockAudio ? "audio" : null;
  }

  if (el instanceof HTMLIFrameElement) {
    return settings.blockIframes ? "iframe" : null;
  }

  if (el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) {
    return settings.blockObjects ? "object" : null;
  }

  return null;
}

function shouldFirewallBlock(el) {
  if (!firewallActive()) {
    return false;
  }

  const kind = firewallKindFor(el);

  if (!kind) {
    return false;
  }

  const url = elementUrl(el);

  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return false;
  }

  if (allowedUrls.has(url)) {
    return false;
  }

  if (isSmallIcon(el)) {
    return false;
  }

  return true;
}

function applyBlockedAppearance(el) {
  el.classList.add(BLOCKED_CLASS);

  if (settings.preserveBlockedSpace) {
    el.classList.add(PRESERVE_CLASS);
  }

  if (settings.highlightBlocked) {
    el.classList.add(HIGHLIGHT_CLASS);
  }

  if (settings.imagePlaceholders) {
    if (el instanceof HTMLImageElement) {
      if (!el.dataset.wgOriginalSrc) {
        el.dataset.wgOriginalSrc = el.getAttribute("src") || "";
      }

      el.setAttribute("src", TRANSPARENT_PIXEL);
      el.removeAttribute("srcset");
    } else if (
      el instanceof HTMLVideoElement ||
      el instanceof HTMLAudioElement ||
      el instanceof HTMLIFrameElement
    ) {
      if (!el.dataset.wgOriginalSrc) {
        el.dataset.wgOriginalSrc = el.getAttribute("src") || "";
      }

      el.removeAttribute("src");

      if (typeof el.pause === "function") {
        el.pause();
      }
    } else if (
      el instanceof HTMLObjectElement ||
      el instanceof HTMLEmbedElement
    ) {
      if (!el.dataset.wgOriginalData) {
        el.dataset.wgOriginalData = el.getAttribute("data") || "";
      }

      el.removeAttribute("data");
    }
  }
}

function blockElement(el) {
  if (el.classList.contains(BLOCKED_CLASS) || trackedMedia.has(el)) {
    return;
  }

  const kind = firewallKindFor(el) || "image";
  const url = elementUrl(el);

  trackedMedia.add(el);
  blockedElements.add(el);
  applyBlockedAppearance(el);

  blockedCount++;
  recordBlocked(kind, url);

  scheduleBadgeUpdate();

  WebGuardLogger.info("blk", {
    kind: el.tagName.toLowerCase()
  });
}

function restoreElementSource(el) {
  if (el instanceof HTMLImageElement && el.dataset.wgOriginalSrc) {
    el.setAttribute("src", el.dataset.wgOriginalSrc);
  } else if (
    (el instanceof HTMLVideoElement ||
      el instanceof HTMLAudioElement ||
      el instanceof HTMLIFrameElement) &&
    el.dataset.wgOriginalSrc
  ) {
    el.setAttribute("src", el.dataset.wgOriginalSrc);
  } else if (
    (el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement) &&
    el.dataset.wgOriginalData
  ) {
    el.setAttribute("data", el.dataset.wgOriginalData);
  }

  delete el.dataset.wgOriginalSrc;
  delete el.dataset.wgOriginalData;
}

async function unblockElement(el) {
  const url = el.dataset.wgOriginalSrc || el.dataset.wgOriginalData || elementUrl(el);

  if (!url) {
    return;
  }

  let allowRuleCreated = false;

  try {
    const response = await api.runtime.sendMessage({
      type: "wg-allow",
      url
    });

    allowRuleCreated = Boolean(response && response.ok);
  } catch (error) {
    await WebGuardLogger.warn("uberr", {
      message: String(error && error.message ? error.message : error)
    });
  }

  allowedUrls.add(url);
  restoreElementSource(el);

  if (
    el instanceof HTMLImageElement ||
    el instanceof HTMLVideoElement ||
    el instanceof HTMLAudioElement ||
    el instanceof HTMLIFrameElement
  ) {
    el.src = url;
  }

  el.classList.remove(BLOCKED_CLASS, PRESERVE_CLASS, HIGHLIGHT_CLASS);
  trackedMedia.delete(el);
  blockedElements.delete(el);

  if (blockedCount > 0) {
    blockedCount--;
  }

  scheduleBadgeUpdate();

  document.dispatchEvent(new CustomEvent(UNBLOCK_EVENT, {
    detail: {
      element: el,
      url,
      restored: true,
      allowRuleCreated
    }
  }));

  optimizeMediaElement(el);

  if (el instanceof HTMLVideoElement) {
    setupVideoBufferControl(el);
  }

  WebGuardLogger.info("ublk", {
    allowRuleCreated
  });
}

async function allowCurrentSite() {
  try {
    const stored = await api.storage.local.get("firewallExceptions");
    const hosts = hostList(stored.firewallExceptions);

    if (!hosts.includes(pageHost)) {
      hosts.push(pageHost);
    }

    await api.storage.local.set({
      firewallExceptions: hosts.join("\n")
    });

    await WebGuardLogger.info("sit", { host: pageHost });
    return true;
  } catch (error) {
    return false;
  }
}

function pruneBlockedElements() {
  for (const el of blockedElements) {
    if (!el.isConnected) {
      blockedElements.delete(el);
      trackedMedia.delete(el);

      if (blockedCount > 0) {
        blockedCount--;
      }
    }
  }
}

function pruneActiveMedia() {
  for (const el of activeMedia) {
    if (!el.isConnected) {
      activeMedia.delete(el);

      if (managedCount > 0) {
        managedCount--;
      }
    }
  }
}

function pruneAudioContexts() {
  for (const context of audioContexts) {
    if (context.state === "closed") {
      audioContexts.delete(context);
    }
  }
}

function restoreBlockedElements() {
  for (const el of blockedElements) {
    if (!el.isConnected) {
      blockedElements.delete(el);
      trackedMedia.delete(el);

      if (blockedCount > 0) {
        blockedCount--;
      }

      continue;
    }

    restoreElementSource(el);
    el.classList.remove(BLOCKED_CLASS, PRESERVE_CLASS, HIGHLIGHT_CLASS);
    trackedMedia.delete(el);
    blockedElements.delete(el);

    if (blockedCount > 0) {
      blockedCount--;
    }
  }

  scheduleBadgeUpdate();
}

function revertOptimizerSettings() {
  if (!settings.highlightManaged) {
    for (const el of document.querySelectorAll("." + MANAGED_CLASS)) {
      el.classList.remove(MANAGED_CLASS);
    }
  }

  if (!settings.stealthTracker) {
    for (const el of document.querySelectorAll("." + TRACKER_CLASS)) {
      el.classList.remove(TRACKER_CLASS);
    }
  }

  if (!settings.gpuAccelerate) {
    for (const el of activeMedia) {
      el.style.willChange = "";
    }
  }

  if (!settings.lazyLoadMedia) {
    for (const img of document.querySelectorAll("img[loading='lazy']")) {
      img.removeAttribute("loading");
    }

    for (const frame of document.querySelectorAll("iframe[loading='lazy']")) {
      frame.removeAttribute("loading");
    }

    for (const media of document.querySelectorAll("video[preload='none'],audio[preload='none']")) {
      if (media.paused) {
        media.removeAttribute("preload");
      }
    }
  }

  if (!settings.freezeCanvasMesh) {
    for (const canvas of document.querySelectorAll("canvas")) {
      if (backgroundCanvases.has(canvas)) {
        canvas.style.pointerEvents = "";
        canvas.style.contain = "";
        canvas.style.willChange = "";
        backgroundCanvases.delete(canvas);
      }
    }
  }
}

function handleDocumentClick(event) {
  if (!settings.tapToUnblock) {
    return;
  }

  const target = event.target;

  if (!target || typeof target.closest !== "function") {
    return;
  }

  const blockedElement = target.closest("." + BLOCKED_CLASS);

  if (blockedElement) {
    event.preventDefault();
    event.stopPropagation();
    unblockElement(blockedElement);
  }
}

async function handleDocumentContextMenu(event) {
  const target = event.target;

  if (!target || typeof target.closest !== "function") {
    return;
  }

  const blockedElement = target.closest("." + BLOCKED_CLASS);

  if (!blockedElement) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const allowed = await allowCurrentSite();

  if (allowed) {
    await unblockElement(blockedElement);
  }
}

function scanFirewall(root) {
  if (!firewallActive()) {
    return;
  }

  const selector = "img, picture, source, video, audio, iframe, object, embed";
  const elements = root.querySelectorAll(selector);

  for (const el of elements) {
    if (shouldFirewallBlock(el)) {
      blockElement(el);
    }
  }

  if (root instanceof Element && shouldFirewallBlock(root)) {
    blockElement(root);
  }
}

function optimizeMediaElement(el) {
  if (!optimizerActive()) {
    return;
  }

  if (el.classList.contains(BLOCKED_CLASS) || trackedMedia.has(el)) {
    return;
  }

  trackedMedia.add(el);

  if (settings.lazyLoadMedia) {
    if (el instanceof HTMLImageElement) {
      el.setAttribute("loading", "lazy");
      el.setAttribute("decoding", "async");
    } else if (el instanceof HTMLIFrameElement) {
      el.setAttribute("loading", "lazy");
    } else if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
      if (!playedMedia.has(el) && !el.autoplay) {
        el.setAttribute("preload", "none");
      }
    }
  }

  if (settings.highlightManaged) {
    el.classList.add(MANAGED_CLASS);
  }

  const observable =
    el instanceof HTMLImageElement ||
    el instanceof HTMLVideoElement ||
    el instanceof HTMLAudioElement ||
    el instanceof HTMLIFrameElement;

  if (mediaObserver && observable) {
    mediaObserver.observe(el);
  }
}

function scanOptimizer(root) {
  if (!optimizerActive()) {
    return;
  }

  const selector = "img, iframe, video, audio, embed, object, canvas";
  const elements = root.querySelectorAll(selector);

  for (const el of elements) {
    if (el instanceof HTMLCanvasElement) {
      processCanvas(el);
      continue;
    }

    optimizeMediaElement(el);
  }

  if (root instanceof Element && !(root instanceof HTMLCanvasElement)) {
    optimizeMediaElement(root);
  }
}

function setupMediaObserver() {
  const margin = Math.max(0, Number(settings.triggerMargin) || 300);

  if (mediaObserver && activeTriggerMargin === margin) {
    return;
  }

  if (mediaObserver) {
    mediaObserver.disconnect();
    mediaObserver = null;
  }

  activeTriggerMargin = margin;

  if (!optimizerActive()) {
    return;
  }

  if (!settings.lazyLoadMedia && !settings.gpuAccelerate) {
    return;
  }

  mediaObserver = new IntersectionObserver(entries => {
    pruneActiveMedia();

    for (const entry of entries) {
      const el = entry.target;

      if (el.classList.contains(BLOCKED_CLASS)) {
        if (activeMedia.has(el)) {
          activeMedia.delete(el);

          if (managedCount > 0) {
            managedCount--;
          }

          scheduleBadgeUpdate();
        }

        el.style.willChange = "";
        continue;
      }

      if (entry.isIntersecting) {
        if (!activeMedia.has(el)) {
          activeMedia.add(el);
          managedCount++;
          scheduleBadgeUpdate();

          WebGuardLogger.debug("act", {
            kind: el.tagName.toLowerCase()
          });
        }

        if (settings.gpuAccelerate) {
          el.style.willChange = "transform, opacity";
        }
      } else {
        if (activeMedia.has(el)) {
          activeMedia.delete(el);

          if (managedCount > 0) {
            managedCount--;
          }

          scheduleBadgeUpdate();

          WebGuardLogger.debug("dea", {
            kind: el.tagName.toLowerCase()
          });
        }

        el.style.willChange = "";

        if (settings.lazyLoadMedia) {
          if (
            (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) &&
            !playedMedia.has(el)
          ) {
            el.setAttribute("preload", "none");
            el.removeAttribute("autoplay");
          }
        }
      }
    }
  }, {
    rootMargin: margin + "px"
  });
}

function disconnectMediaObserver() {
  if (mediaObserver) {
    mediaObserver.disconnect();
    mediaObserver = null;
  }

  activeTriggerMargin = null;

  for (const el of activeMedia) {
    el.style.willChange = "";
  }

  activeMedia.clear();
  managedCount = 0;
  scheduleBadgeUpdate();
}

function processCanvas(canvas) {
  if (!optimizerActive() || canvas.classList.contains(BLOCKED_CLASS)) {
    return;
  }

  const style = getComputedStyle(canvas);
  const isPositioned = style.position === "fixed" || style.position === "absolute";
  const isLarge = canvas.width >= 300 || canvas.height >= 300;

  if (settings.freezeCanvasMesh && (isPositioned || isLarge)) {
    backgroundCanvases.add(canvas);
    gatedCanvases.delete(canvas);
    canvas.style.pointerEvents = "none";
    canvas.style.contain = "strict";
    canvas.style.willChange = "auto";
    canvas.classList.remove(CANVAS_HIDDEN_CLASS);

    WebGuardLogger.debug("cfrz", {});
    return;
  }

  backgroundCanvases.delete(canvas);

  if (settings.gateOffscreenCanvas) {
    if (!canvasObserver) {
      canvasObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const canvasEl = entry.target;

          if (backgroundCanvases.has(canvasEl)) {
            continue;
          }

          if (entry.isIntersecting) {
            canvasEl.classList.remove(CANVAS_HIDDEN_CLASS);
          } else {
            canvasEl.classList.add(CANVAS_HIDDEN_CLASS);
          }
        }
      });
    }

    if (!gatedCanvases.has(canvas)) {
      gatedCanvases.add(canvas);
      canvasObserver.observe(canvas);
    }
  }
}

function disconnectCanvasObserver() {
  if (canvasObserver) {
    canvasObserver.disconnect();
    canvasObserver = null;
  }

  for (const canvas of document.querySelectorAll("canvas")) {
    canvas.classList.remove(CANVAS_HIDDEN_CLASS);
  }

  gatedCanvases.clear();
}

function updateRenderStyles() {
  const css = [];

  css.push(`.${BLOCKED_CLASS}{position:relative;background:#222 !important;}`);
  css.push(`.${BLOCKED_CLASS}::after{content:"⛔ BLOCKED";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 11px system-ui,sans-serif;color:#fff;background:rgba(183,28,28,.75);text-align:center;}`);
  css.push(`.${PRESERVE_CLASS}{min-height:80px;min-width:80px;}`);
  css.push(`.${HIGHLIGHT_CLASS}{outline:2px solid #ff1744 !important;outline-offset:-2px;}`);
  css.push(`.${MANAGED_CLASS}{outline:2px dashed #2979ff !important;outline-offset:-2px;}`);
  css.push(`.${TRACKER_CLASS}{display:none !important;}`);
  css.push(`.${CANVAS_HIDDEN_CLASS}{display:none !important;}`);

  if (settings.hideAllBg) {
    css.push(`*{background-image:none !important;}`);
  } else if (settings.hideInlineBg) {
    css.push(`[style*="background-image"]{background-image:none !important;}`);
  }

  if (settings.killBackdropBlur) {
    css.push(`*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`);
    css.push(`[class*="glass"],[class*="blur"],[class*="frosted"]{background:#121212 !important;}`);
  }

  if (settings.haltInfiniteAnimations) {
    css.push(`*{animation-iteration-count:1 !important;}`);
  }

  if (settings.disableCssAnimations) {
    css.push(`*{animation:none !important;transition:none !important;}`);
  }

  if (settings.stripSvgFilters) {
    css.push(`svg,[class*="glow"],[class*="shadow"]{filter:none !important;box-shadow:none !important;text-shadow:none !important;}`);
  }

  styleElement.textContent = css.join("\n");
}

function patchJsAnimations() {
  if (originalRequestAnimationFrame) {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    originalRequestAnimationFrame = null;
  }

  if (!settings.throttleJsAnimations && !settings.disableJsAnimations) {
    return;
  }

  originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);

  window.requestAnimationFrame = callback => {
    if (settings.disableJsAnimations) {
      return 0;
    }

    const now = Date.now();

    if (now - rafThrottleLast < 100) {
      return 0;
    }

    rafThrottleLast = now;
    return originalRequestAnimationFrame(callback);
  };

  WebGuardLogger.debug("raf", {
    disabled: settings.disableJsAnimations,
    throttled: settings.throttleJsAnimations
  });
}

function patchAudioContexts() {
  if (originalAudioContext || !window.AudioContext) {
    return;
  }

  if (!settings.suspendIdleAudio) {
    return;
  }

  originalAudioContext = window.AudioContext;

  function PatchedAudioContext(...args) {
    const context = new originalAudioContext(...args);
    audioContexts.add(context);

    if (context.addEventListener) {
      context.addEventListener("statechange", () => {
        if (context.state === "closed") {
          audioContexts.delete(context);
        }
      });
    }

    scheduleAudioIdleCheck();

    return context;
  }

  PatchedAudioContext.prototype = originalAudioContext.prototype;

  window.AudioContext = PatchedAudioContext;
}

function scheduleAudioIdleCheck() {
  if (!settings.suspendIdleAudio) {
    return;
  }

  if (audioIdleTimer) {
    clearTimeout(audioIdleTimer);
  }

  audioIdleTimer = setTimeout(() => {
    audioIdleTimer = null;

    if (!settings.suspendIdleAudio) {
      return;
    }

    pruneAudioContexts();

    if (Date.now() - lastUserInteraction < 30000) {
      scheduleAudioIdleCheck();
      return;
    }

    suspendTrackedAudioContexts();
    scheduleAudioIdleCheck();
  }, 30000);
}

function suspendTrackedAudioContexts() {
  for (const context of audioContexts) {
    if (context.state === "running") {
      context.suspend().catch(() => {});
    }
  }
}

function resumeTrackedAudioContexts() {
  for (const context of audioContexts) {
    if (context.state === "suspended") {
      context.resume().catch(() => {});
    }
  }
}

function pauseBackgroundTab() {
  if (!settings.pauseBackgroundTabs || document.visibilityState !== "hidden") {
    return;
  }

  for (const media of document.querySelectorAll("video, audio")) {
    if (!media.paused) {
      hiddenAnimations.add(media);
      media.pause();
    }
  }

  for (const svg of document.querySelectorAll("svg")) {
    if (typeof svg.pauseAnimations === "function") {
      svg.pauseAnimations();
    }
  }

  if (document.getAnimations) {
    for (const animation of document.getAnimations()) {
      if (animation.playState === "running") {
        hiddenAnimations.add(animation);
        animation.pause();
      }
    }
  }

  suspendTrackedAudioContexts();
  WebGuardLogger.info("bpau", {});
}

function resumeBackgroundTab() {
  if (!settings.pauseBackgroundTabs || document.visibilityState !== "visible") {
    return;
  }

  for (const item of hiddenAnimations) {
    try {
      if (typeof item.play === "function") {
        item.play();
      } else if (typeof item.unpauseAnimations === "function") {
        item.unpauseAnimations();
      }
    } catch (error) {
      // Ignore removed media or finished animations.
    }
  }

  hiddenAnimations.clear();
  resumeTrackedAudioContexts();
  WebGuardLogger.info("bres", {});
}

function removePrefetchLinks() {
  if (settings.removePrefetchPreload) {
    const links = document.querySelectorAll(
      'link[rel~="preload"],link[rel~="prefetch"],link[rel~="modulepreload"]'
    );

    for (const link of links) {
      link.remove();
    }
  }

  if (settings.removePreconnect) {
    const links = document.querySelectorAll(
      'link[rel~="dns-prefetch"],link[rel~="preconnect"]'
    );

    for (const link of links) {
      link.remove();
    }
  }
}

function handleMutations(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      mutationQueue.push(node);
    }
  }

  if (mutationScheduled || !mutationQueue.length) {
    return;
  }

  mutationScheduled = true;

  batchDomWork(() => {
    const nodes = mutationQueue.splice(0, mutationQueue.length);
    mutationScheduled = false;

    pruneBlockedElements();
    pruneActiveMedia();
    pruneAudioContexts();

    for (const node of nodes) {
      if (!node.isConnected) {
        continue;
      }

      if (node instanceof HTMLLinkElement) {
        const rel = node.getAttribute("rel") || "";

        if (
          settings.removePrefetchPreload &&
          /\b(preload|prefetch|modulepreload)\b/.test(rel)
        ) {
          node.remove();
          continue;
        }

        if (
          settings.removePreconnect &&
          /\b(dns-prefetch|preconnect)\b/.test(rel)
        ) {
          node.remove();
          continue;
        }
      }

      scanFirewall(node);
      scanOptimizer(node);
    }
  });
}

function setupDomObserver() {
  if (domObserver) {
    return;
  }

  domObserver = new MutationObserver(handleMutations);
  domObserver.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });
}

function disconnectDomObserver() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
}

function setupVideoBufferControl(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  if (!settings.videoBufferControl) {
    return;
  }

  if (video.dataset.wgBufferManaged === "1") {
    return;
  }

  video.dataset.wgBufferManaged = "1";

  video.addEventListener("progress", () => {
    if (!settings.webguardEnabled || !settings.firewallEnabled || !settings.videoBufferControl) {
      return;
    }

    const target = Math.min(120, Math.max(1, Number(settings.videoBufferTarget) || 5));

    if (video.buffered.length && !video.paused) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const ahead = bufferedEnd - video.currentTime;

      if (ahead > target) {
        video.pause();
      }
    }
  }, { passive: true });

  video.addEventListener("waiting", () => {
    if (!settings.videoBufferControl) {
      return;
    }

    const target = Math.min(120, Math.max(1, Number(settings.videoBufferTarget) || 5));

    if (video.buffered.length) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const ahead = bufferedEnd - video.currentTime;

      if (ahead <= target) {
        video.play().catch(() => {});
      }
    }
  }, { passive: true });

  video.addEventListener("play", () => {
    playedMedia.add(video);
  }, { passive: true });
}

function handleMediaLoad(event) {
  const el = event.target;

  if (!(el instanceof HTMLImageElement)) {
    return;
  }

  if (
    settings.stealthTracker &&
    !el.classList.contains(BLOCKED_CLASS) &&
    (el.naturalWidth <= 1 || el.naturalHeight <= 1)
  ) {
    el.classList.add(TRACKER_CLASS);
    WebGuardLogger.info("trk", {});
  }
}

function handleUserInteraction() {
  lastUserInteraction = Date.now();
  resumeTrackedAudioContexts();
}

async function loadSettings() {
  try {
    const stored = await api.storage.local.get(null);
    settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    refreshSiteState();

    await WebGuardLogger.debug("cfg", {
      firewall: firewallActive(),
      optimizer: optimizerActive()
    });

    return true;
  } catch (error) {
    await WebGuardLogger.error("lderr", {
      message: String(error && error.message ? error.message : error)
    });
    return false;
  }
}

function updateWorkForChanges(changes) {
  const work = {
    css: false,
    firewall: false,
    optimizer: false,
    observer: false,
    prefetch: false,
    full: false
  };

  for (const key of Object.keys(changes)) {
    if (key === "webguardEnabled") {
      work.full = true;
    }

    if (CSS_ONLY_KEYS.has(key)) {
      work.css = true;
    }

    if (FIREWALL_KEYS.has(key)) {
      work.firewall = true;
    }

    if (OPTIMIZER_KEYS.has(key)) {
      work.optimizer = true;
    }

    if (key === "triggerMargin") {
      work.observer = true;
      work.optimizer = true;
    }

    if (key === "removePrefetchPreload" || key === "removePreconnect") {
      work.prefetch = true;
    }
  }

  return work;
}

async function applySelective(changes) {
  refreshSiteState();

  const work = updateWorkForChanges(changes);

  if (work.full) {
    await applyAll();
    return;
  }

  if (work.css) {
    updateRenderStyles();
  }

  if (work.prefetch) {
    removePrefetchLinks();
  }

  if (work.firewall) {
    restoreBlockedElements();

    if (firewallActive()) {
      scanFirewall(document);
    }
  }

  if (work.optimizer || work.observer) {
    setupMediaObserver();

    if (work.observer || !mediaObserver) {
      disconnectMediaObserver();
      setupMediaObserver();
    }

    if (optimizerActive()) {
      scanOptimizer(document);
    } else {
      disconnectMediaObserver();
      disconnectCanvasObserver();
    }
  }

  scheduleBadgeUpdate();
}

async function applyAll() {
  refreshSiteState();
  updateRenderStyles();
  revertOptimizerSettings();
  patchJsAnimations();
  patchAudioContexts();
  removePrefetchLinks();

  if (settings.suspendIdleAudio) {
    scheduleAudioIdleCheck();
  } else if (audioIdleTimer) {
    clearTimeout(audioIdleTimer);
    audioIdleTimer = null;
  }

  restoreBlockedElements();

  if (firewallActive()) {
    scanFirewall(document);
  }

  if (optimizerActive()) {
    setupMediaObserver();
    scanOptimizer(document);
  } else {
    disconnectMediaObserver();
    disconnectCanvasObserver();
  }

  if (
    settings.removePrefetchPreload ||
    settings.removePreconnect ||
    firewallActive() ||
    optimizerActive()
  ) {
    setupDomObserver();
  } else {
    disconnectDomObserver();
  }

  scheduleBadgeUpdate();
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  if (changes.logLevel || changes.loggingEnabled) {
    applyLoggingSettings();
  }

  const relevantChanges = Object.entries(changes).filter(([key, change]) => {
    return key in DEFAULT_SETTINGS &&
      JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
  });

  if (!relevantChanges.length) {
    return;
  }

  const changeMap = {};

  for (const [key, change] of relevantChanges) {
    changeMap[key] = change.newValue;
  }

  loadSettings().then(() => applySelective(changeMap));
});

document.addEventListener("click", handleDocumentClick, true);
document.addEventListener("contextmenu", handleDocumentContextMenu, true);
document.addEventListener("load", handleMediaLoad, true);
document.addEventListener("pointerdown", handleUserInteraction, { passive: true });
document.addEventListener("keydown", handleUserInteraction, { passive: true });

document.addEventListener("visibilitychange", () => {
  pauseBackgroundTab();
  resumeBackgroundTab();
}, { passive: true });

window.addEventListener("pagehide", () => {
  if (mediaObserver) mediaObserver.disconnect();
  if (canvasObserver) canvasObserver.disconnect();
  if (domObserver) domObserver.disconnect();

  if (badgeTimer) clearTimeout(badgeTimer);
  if (audioIdleTimer) clearTimeout(audioIdleTimer);

  mediaObserver = null;
  canvasObserver = null;
  domObserver = null;
  badgeTimer = null;
  audioIdleTimer = null;

  allowedUrls.clear();
}, { once: true });

applyLoggingSettings().then(() => {
  return loadSettings();
}).then(async () => {
  await WebGuardLogger.info("rdy", {
    firewall: firewallActive(),
    optimizer: optimizerActive()
  });

  blockedCount = 0;
  managedCount = 0;
  blockedImages = 0;
  blockedVideos = 0;
  blockedAudio = 0;
  recentBlocked.length = 0;
  scheduleBadgeUpdate();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyAll, { once: true });
  } else {
    applyAll();
  }
});
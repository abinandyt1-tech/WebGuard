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

const DNR_RULE_IDS = {
  SAVE_DATA: 1,
  IMAGES: 2,
  MEDIA: 3,
  STREAMING: 4,
  FONTS: 5,
  IFRAMES: 6,
  OBJECTS: 7,
  WEBSOCKETS: 8,
  THIRD_PARTY_SCRIPTS: 9,
  SPA_ROUTE_DATA: 10
};

const ALL_KNOWN_RULE_IDS = Object.values(DNR_RULE_IDS);

const FIREWALL_RELEVANT_KEYS = new Set([
  "webguardEnabled",
  "firewallEnabled",
  "saveDataHint",
  "blockImages",
  "blockVideo",
  "blockAudio",
  "blockStreamingMedia",
  "blockFonts",
  "blockIframes",
  "blockObjects",
  "blockWebSockets",
  "blockThirdPartyScripts",
  "blockSpaRouteData",
  "firewallExceptions"
]);

const ALLOW_RULE_START_ID = 1000;
const MAX_ALLOW_RULES = 30;
const RECENT_BLOCKED_LIMIT = 5;
const CONTENT_STALE_MS = 12000;

let nextAllowRuleId = ALLOW_RULE_START_ID;
let allowIdInitialized = false;
let ruleUpdateQueue = Promise.resolve();

const allowRulesByTab = new Map();
const allowRuleCreated = new Map();
const tabActivity = new Map();
let dnrAvailable = true;
let activeRuleCount = 0;

function normalizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function exceptionHosts(raw) {
  return String(raw || "").split(/\r?\n/).map(normalizeHostname).filter(Boolean);
}

function mergeSettings(saved) {
  return Object.assign({}, DEFAULT_SETTINGS, saved || {});
}

function baseCondition(exceptions) {
  const condition = {};
  const hosts = exceptionHosts(exceptions);

  if (hosts.length) {
    condition.excludedInitiatorDomains = hosts;
  }

  return condition;
}

function buildDynamicRules(settings) {
  const rules = [];

  if (settings.saveDataHint) {
    rules.push({
      id: DNR_RULE_IDS.SAVE_DATA,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Save-Data", operation: "set", value: "on" }]
      },
      condition: baseCondition(settings.firewallExceptions)
    });
  }

  if (settings.blockImages) {
    rules.push({
      id: DNR_RULE_IDS.IMAGES,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["image", "imageset"]
      })
    });
  }

  if (settings.blockVideo || settings.blockAudio) {
    rules.push({
      id: DNR_RULE_IDS.MEDIA,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["media"]
      })
    });
  }

  if (settings.blockStreamingMedia) {
    rules.push({
      id: DNR_RULE_IDS.STREAMING,
      priority: 3,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        regexFilter: "\\.(m3u8|mpd|ts|m4s)([?#]|$)",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      })
    });
  }

  if (settings.blockFonts) {
    rules.push({
      id: DNR_RULE_IDS.FONTS,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["font"]
      })
    });
  }

  if (settings.blockIframes) {
    rules.push({
      id: DNR_RULE_IDS.IFRAMES,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["sub_frame"]
      })
    });
  }

  if (settings.blockObjects) {
    rules.push({
      id: DNR_RULE_IDS.OBJECTS,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["object"]
      })
    });
  }

  if (settings.blockWebSockets) {
    rules.push({
      id: DNR_RULE_IDS.WEBSOCKETS,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["websocket"]
      })
    });
  }

  if (settings.blockThirdPartyScripts) {
    rules.push({
      id: DNR_RULE_IDS.THIRD_PARTY_SCRIPTS,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        resourceTypes: ["script"],
        domainType: "thirdParty"
      })
    });
  }

  if (settings.blockSpaRouteData) {
    rules.push({
      id: DNR_RULE_IDS.SPA_ROUTE_DATA,
      priority: 2,
      action: { type: "block" },
      condition: Object.assign({}, baseCondition(settings.firewallExceptions), {
        regexFilter: "(_next/data|__data\\.json)",
        resourceTypes: ["xmlhttprequest", "script", "other"]
      })
    });
  }

  return rules;
}

async function applyLogLevel() {
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

async function removeAllKnownRules() {
  const existing = await api.declarativeNetRequest.getDynamicRules();
  const existingIds = existing.map(rule => rule.id);

  const removeRuleIds = Array.from(new Set([
    ...ALL_KNOWN_RULE_IDS,
    ...existingIds
  ]));

  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: []
  });

  return removeRuleIds.length;
}

async function updateFirewallRules() {
  if (!api.declarativeNetRequest || !api.declarativeNetRequest.updateDynamicRules) {
    dnrAvailable = false;
    activeRuleCount = 0;

    await WebGuardLogger.error("nodnr", {
      message: "declarativeNetRequest is unavailable; DOM fallback remains active."
    });

    return;
  }

  try {
    const stored = await api.storage.local.get(null);
    const settings = mergeSettings(stored);

    if (!settings.webguardEnabled || !settings.firewallEnabled) {
      const removed = await removeAllKnownRules();

      dnrAvailable = true;
      activeRuleCount = 0;

      await WebGuardLogger.info("fwoff", { count: removed });
      return;
    }

    const addRules = buildDynamicRules(settings);

    try {
      await removeAllKnownRules();

      await api.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [],
        addRules
      });
    } catch (firstError) {
      const message = String(
        firstError && firstError.message ? firstError.message : firstError
      );

      if (/duplicate rule id/i.test(message)) {
        await removeAllKnownRules();

        await api.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [],
          addRules
        });
      } else {
        throw firstError;
      }
    }

    dnrAvailable = true;
    activeRuleCount = addRules.length;

    await WebGuardLogger.info("fwup", {
      activeRules: addRules.length
    });
  } catch (error) {
    dnrAvailable = false;
    activeRuleCount = 0;

    await WebGuardLogger.error("fwerr", {
      message: String(error && error.message ? error.message : error)
    });
  }
}

function applyFirewallRules() {
  ruleUpdateQueue = ruleUpdateQueue
    .then(updateFirewallRules)
    .catch(error => {
      WebGuardLogger.error("fwerr", {
        message: String(error && error.message ? error.message : error)
      });
    });

  return ruleUpdateQueue;
}

async function ensureAllowRuleId() {
  if (allowIdInitialized) return;

  const rules = await api.declarativeNetRequest.getSessionRules();
  const maxId = rules.reduce((max, rule) => Math.max(max, rule.id), 999);

  nextAllowRuleId = maxId + 1;
  allowIdInitialized = true;
}

async function evictOldestAllowRuleIfNeeded() {
  const rules = await api.declarativeNetRequest.getSessionRules();

  if (rules.length < MAX_ALLOW_RULES) {
    return;
  }

  let oldestId = null;
  let oldestTime = Infinity;

  for (const rule of rules) {
    const created = allowRuleCreated.get(rule.id) || 0;

    if (created < oldestTime) {
      oldestTime = created;
      oldestId = rule.id;
    }
  }

  if (oldestId !== null) {
    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [oldestId],
      addRules: []
    });

    allowRuleCreated.delete(oldestId);

    for (const ruleIds of allowRulesByTab.values()) {
      ruleIds.delete(oldestId);
    }
  }
}

async function createTemporaryAllowRule(tabId, url) {
  if (!api.declarativeNetRequest || !api.declarativeNetRequest.updateSessionRules) {
    await WebGuardLogger.warn("noalw", {});
    return { ok: false, dnrAvailable };
  }

  try {
    await ensureAllowRuleId();
    await evictOldestAllowRuleIfNeeded();

    const ruleId = nextAllowRuleId++;

    const escaped = String(url)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const rule = {
      id: ruleId,
      priority: 1000,
      action: { type: "allow" },
      condition: {
        regexFilter: "^" + escaped + "$",
        resourceTypes: ["image", "imageset", "media", "sub_frame", "object"]
      }
    };

    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule]
    });

    allowRuleCreated.set(ruleId, Date.now());

    if (!allowRulesByTab.has(tabId)) {
      allowRulesByTab.set(tabId, new Set());
    }

    allowRulesByTab.get(tabId).add(ruleId);

    await WebGuardLogger.info("alw", {
      tabId,
      resourceTypes: rule.condition.resourceTypes.length
    });

    return { ok: true, dnrAvailable: true };
  } catch (error) {
    await WebGuardLogger.error("alwerr", {
      message: String(error && error.message ? error.message : error)
    });

    return { ok: false, dnrAvailable };
  }
}

async function removeTabAllowRules(tabId) {
  const ruleIds = allowRulesByTab.get(tabId);

  if (!ruleIds || !ruleIds.size) {
    return;
  }

  try {
    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: Array.from(ruleIds),
      addRules: []
    });

    for (const ruleId of ruleIds) {
      allowRuleCreated.delete(ruleId);
    }

    allowRulesByTab.delete(tabId);
    await WebGuardLogger.info("alwx", { count: ruleIds.size });
  } catch (error) {
    await WebGuardLogger.error("clnerr", {
      message: String(error && error.message ? error.message : error)
    });
  }
}

function countText(count) {
  if (!count || count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

function getActivity(tabId) {
  return tabActivity.get(tabId) || {
    blocked: 0,
    managed: 0,
    images: 0,
    videos: 0,
    audio: 0,
    recent: [],
    lastSeen: 0
  };
}

async function updateBadge(tabId, data) {
  const firewallCount = Number(data.blocked) || 0;
  const optimizerCount = Number(data.managed) || 0;

  const previous = getActivity(tabId);

  tabActivity.set(tabId, {
    blocked: firewallCount,
    managed: optimizerCount,
    images: Number(data.images) || 0,
    videos: Number(data.videos) || 0,
    audio: Number(data.audio) || 0,
    recent: Array.isArray(data.recent) ? data.recent.slice(0, RECENT_BLOCKED_LIMIT) : [],
    lastSeen: Date.now()
  });

  await WebGuardLogger.debug("cnt", {
    tabId,
    blocked: firewallCount,
    managed: optimizerCount
  });

  try {
    if (!api.action || !api.action.setBadgeText) {
      await WebGuardLogger.debug("nobdg", { tabId });
      return;
    }

    try {
      await api.tabs.get(tabId);
    } catch (tabError) {
      tabActivity.delete(tabId);
      return;
    }

    const useFirewall = firewallCount > 0;
    const count = useFirewall ? firewallCount : optimizerCount;
    const text = countText(count);

    await api.action.setBadgeText({ tabId, text });

    if (api.action.setBadgeBackgroundColor) {
      await api.action.setBadgeBackgroundColor({
        tabId,
        color: useFirewall ? "#d32f2f" : "#1976d2"
      });
    }

    await WebGuardLogger.debug("bdg", {
      tabId,
      blocked: firewallCount,
      managed: optimizerCount,
      badgeText: text
    });
  } catch (error) {
    await WebGuardLogger.debug("bdgerr", {
      tabId,
      message: String(error && error.message ? error.message : error)
    });
  }
}

async function clearBadge(tabId) {
  try {
    tabActivity.set(tabId, {
      blocked: 0,
      managed: 0,
      images: 0,
      videos: 0,
      audio: 0,
      recent: [],
      lastSeen: Date.now()
    });

    if (api.action && api.action.setBadgeText) {
      await api.action.setBadgeText({ tabId, text: "" });
    }

    await WebGuardLogger.debug("bdgx", { tabId });
  } catch (error) {
    await WebGuardLogger.debug("bdgerr", {
      tabId,
      message: String(error && error.message ? error.message : error)
    });
  }
}

api.runtime.onInstalled.addListener(async details => {
  await WebGuardLogger.info("inst", {
    reason: details && details.reason ? details.reason : "unknown"
  });

  if (details && details.reason === "update") {
    await api.storage.local.set({ updateRecommended: true });
  }

  await applyFirewallRules();
});

api.runtime.onStartup.addListener(async () => {
  await WebGuardLogger.info("strt", {});
  allowRulesByTab.clear();
  allowRuleCreated.clear();
  await applyFirewallRules();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.logLevel || changes.loggingEnabled) {
    applyLogLevel();
  }

  const relevantChanges = Object.entries(changes).filter(([key, change]) => {
    return key in DEFAULT_SETTINGS &&
      JSON.stringify(change.oldValue) !== JSON.stringify(change.newValue);
  });

  const firewallRelevant = relevantChanges.some(([key]) =>
    FIREWALL_RELEVANT_KEYS.has(key)
  );

  if (firewallRelevant) {
    applyFirewallRules();
  }
});

api.tabs.onRemoved.addListener(tabId => {
  tabActivity.delete(tabId);
  removeTabAllowRules(tabId);
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearBadge(tabId);
    removeTabAllowRules(tabId);
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "wg-allow") {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number"
      ? sender.tab.id
      : null;

    if (tabId === null) {
      sendResponse({ ok: false, dnrAvailable });
      return false;
    }

    createTemporaryAllowRule(tabId, message.url)
      .then(result => sendResponse(result))
      .catch(async error => {
        await WebGuardLogger.error("msgerr", {
          message: String(error && error.message ? error.message : error)
        });
        sendResponse({ ok: false, dnrAvailable });
      });

    return true;
  }

  if (message.type === "wg-badge") {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number"
      ? sender.tab.id
      : null;

    if (tabId !== null) {
      updateBadge(tabId, message)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    } else {
      sendResponse({ ok: false });
    }

    return true;
  }

  if (message.type === "wg-dnr-status") {
    sendResponse({ dnrAvailable, activeRuleCount });
    return false;
  }

  if (message.type === "wg-get-activity") {
    const tabId = Number(message.tabId);
    const activity = Number.isFinite(tabId) ? getActivity(tabId) : getActivity(null);

    sendResponse({
      blocked: activity.blocked || 0,
      managed: activity.managed || 0,
      images: activity.images || 0,
      videos: activity.videos || 0,
      audio: activity.audio || 0,
      recent: activity.recent || [],
      connected: Date.now() - (activity.lastSeen || 0) < CONTENT_STALE_MS,
      dnrAvailable,
      activeRuleCount
    });

    return false;
  }

  if (message.type === "wg-repair") {
    const tabId = Number(message.tabId);

    applyFirewallRules()
      .then(async () => {
        await api.storage.local.set({ updateRecommended: false });
        await WebGuardLogger.info("repd", { tabId });

        if (Number.isFinite(tabId)) {
          await api.tabs.reload(tabId);
        }

        sendResponse({ ok: true });
      })
      .catch(async error => {
        await WebGuardLogger.error("fwerr", {
          message: String(error && error.message ? error.message : error)
        });
        sendResponse({ ok: false });
      });

    return true;
  }

  return false;
});

try {
  applyLogLevel()
    .then(() => WebGuardLogger.info("brdy", { dnrAvailable }))
    .then(() => applyFirewallRules())
    .catch(error => {
      console.error("WebGuard background startup failed:", error);
      WebGuardLogger.error("berr", {
        message: String(error && error.message ? error.message : error)
      });
    });
} catch (error) {
  console.error("WebGuard background initialization failed:", error);
}
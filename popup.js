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

const TOGGLES = [
  "wgMaster", "fwMaster", "saveDataHint", "blockImages", "blockVideo",
  "blockAudio", "blockStreamingMedia", "allowSmallIcons", "videoBufferControl",
  "imagePlaceholders", "preserveBlockedSpace", "tapToUnblock", "highlightBlocked",
  "hideInlineBg", "hideAllBg", "blockFonts", "blockIframes", "blockObjects",
  "blockWebSockets", "blockThirdPartyScripts", "blockSpaRouteData", "optMaster",
  "lazyLoadMedia", "gpuAccelerate", "stealthTracker", "highlightManaged",
  "killBackdropBlur", "haltInfiniteAnimations", "disableCssAnimations",
  "throttleJsAnimations", "disableJsAnimations", "stripSvgFilters",
  "freezeCanvasMesh", "gateOffscreenCanvas", "suspendIdleAudio",
  "pauseBackgroundTabs", "removePrefetchPreload", "removePreconnect",
  "loggingEnabled"
];

const TOGGLE_KEYS = {
  wgMaster: "webguardEnabled",
  fwMaster: "firewallEnabled",
  optMaster: "optimizerEnabled"
};

const SLIDERS = ["iconThreshold", "videoBufferTarget", "triggerMargin"];

const SLIDER_LABELS = {
  iconThreshold: "iconThresholdValue",
  videoBufferTarget: "videoBufferValue",
  triggerMargin: "triggerMarginValue"
};

const TEXTAREAS = ["firewallExceptions", "optimizerExceptions"];

const statusMsg = document.getElementById("statusMsg");
const importFile = document.getElementById("importFile");
const blockedCountEl = document.getElementById("blockedCount");
const imagesCountEl = document.getElementById("imagesCount");
const videosCountEl = document.getElementById("videosCount");
const audioCountEl = document.getElementById("audioCount");
const managedCountEl = document.getElementById("managedCount");
const recentListEl = document.getElementById("recentList");
const badgePreviewEl = document.getElementById("badgePreview");
const contentStatusEl = document.getElementById("contentStatus");
const logLevelSelect = document.getElementById("logLevel");
const firewallSiteToggle = document.getElementById("firewallSiteToggle");
const optimizerSiteToggle = document.getElementById("optimizerSiteToggle");
const firewallSiteHost = document.getElementById("firewallSiteHost");
const optimizerSiteHost = document.getElementById("optimizerSiteHost");
const repairBtn = document.getElementById("repairBtn");

let activityTimer = null;
let sliderSaveTimer = null;
let currentTabId = null;
let currentHostname = "";

function showMessage(text, isError) {
  statusMsg.textContent = text || "";
  statusMsg.style.color = isError ? "#ef5350" : "#f9a825";
}

function mergeSettings(saved) {
  return Object.assign({}, DEFAULT_SETTINGS, saved || {});
}

function keyForControl(id) {
  return TOGGLE_KEYS[id] || id;
}

function setToggle(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(value);
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  const pill = document.getElementById(SLIDER_LABELS[id]);

  if (el) el.value = value;

  if (pill) {
    pill.textContent = id === "videoBufferTarget"
      ? value + " s"
      : value + " px";
  }
}

function applyLoggingSettings(settings) {
  const safeLevel = ["debug", "info", "warn", "error"].includes(settings.logLevel)
    ? settings.logLevel
    : "info";

  WebGuardLogger.setLevel(safeLevel);
  WebGuardLogger.setEnabled(settings.loggingEnabled !== false);

  logLevelSelect.value = safeLevel;
}

function updateMasterUi(settings, dnrStatus, activity) {
  const master = document.getElementById("wgMaster");
  const statusPill = document.getElementById("statusPill");
  const dataStatus = document.getElementById("dataStatus");

  const active = Boolean(settings.webguardEnabled);

  statusPill.textContent = active ? "Active" : "Off";
  statusPill.classList.toggle("on", active);
  statusPill.classList.toggle("off", !active);

  const firewallOn = active && settings.firewallEnabled;
  const rulesActive = dnrStatus && dnrStatus.dnrAvailable && dnrStatus.activeRuleCount > 0;

  dataStatus.textContent = rulesActive
    ? "Network blocking active"
    : firewallOn
      ? "Firewall on — DNR unverified"
      : "Firewall off";

  dataStatus.classList.toggle("on", rulesActive);
  dataStatus.classList.toggle("off", !rulesActive);

  master.checked = active;

  const connected = Boolean(activity && activity.connected);

  contentStatusEl.textContent = connected ? "Connected" : "Not reporting";
  contentStatusEl.classList.toggle("on", connected);
  contentStatusEl.classList.toggle("off", !connected);
}

function updateSiteUi(settings) {
  const label = currentHostname || "this site";

  firewallSiteHost.textContent = "Turn off Data Saver on " + label + ".";
  optimizerSiteHost.textContent = "Turn off Web Optimizer on " + label + ".";

  firewallSiteToggle.checked =
    currentHostname &&
    hostList(settings.firewallExceptions).includes(currentHostname);

  optimizerSiteToggle.checked =
    currentHostname &&
    hostList(settings.optimizerExceptions).includes(currentHostname);

  firewallSiteToggle.disabled = !currentHostname;
  optimizerSiteToggle.disabled = !currentHostname;
}

function renderRecent(recent) {
  recentListEl.textContent = "";

  const items = Array.isArray(recent) ? recent : [];

  if (!items.length) {
    const empty = document.createElement("li");
    empty.textContent = "No blocked items yet.";
    recentListEl.appendChild(empty);
    return;
  }

  for (const item of items.slice(0, 5)) {
    const li = document.createElement("li");

    const type = document.createElement("span");
    type.className = "type";
    type.textContent = item.k || "item";

    const host = document.createElement("span");
    host.className = "host";
    host.textContent = item.h || "unknown host";

    li.appendChild(type);
    li.appendChild(host);
    recentListEl.appendChild(li);
  }
}

async function getActiveTabInfo() {
  const tabs = await api.tabs.query({
    active: true,
    currentWindow: true
  });

  const tab = tabs && tabs[0];

  if (!tab || !tab.url) {
    return null;
  }

  try {
    const url = new URL(tab.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return {
      tabId: tab.id,
      hostname: url.hostname.replace(/^www\./, "").toLowerCase()
    };
  } catch (error) {
    return null;
  }
}

function hostList(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map(value => value.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

async function refreshActivity() {
  try {
    const info = await getActiveTabInfo();

    if (!info) {
      currentTabId = null;
      currentHostname = "";

      blockedCountEl.textContent = "0";
      imagesCountEl.textContent = "0";
      videosCountEl.textContent = "0";
      audioCountEl.textContent = "0";
      managedCountEl.textContent = "0";
      badgePreviewEl.textContent = "—";
      renderRecent([]);

      contentStatusEl.textContent = "No site";
      contentStatusEl.classList.remove("on");
      contentStatusEl.classList.add("off");

      return null;
    }

    currentTabId = info.tabId;
    currentHostname = info.hostname;

    const response = await api.runtime.sendMessage({
      type: "wg-get-activity",
      tabId: info.tabId
    });

    const blocked = response && Number(response.blocked) || 0;
    const managed = response && Number(response.managed) || 0;

    blockedCountEl.textContent = String(blocked);
    imagesCountEl.textContent = String(response && Number(response.images) || 0);
    videosCountEl.textContent = String(response && Number(response.videos) || 0);
    audioCountEl.textContent = String(response && Number(response.audio) || 0);
    managedCountEl.textContent = String(managed);

    renderRecent(response && response.recent);

    const badgeValue = blocked > 0
      ? (blocked > 99 ? "99+" : String(blocked))
      : managed > 0
        ? (managed > 99 ? "99+" : String(managed))
        : "";

    badgePreviewEl.textContent = badgeValue || "—";
    badgePreviewEl.style.color = blocked > 0
      ? "#ef5350"
      : managed > 0
        ? "#64b5f6"
        : "#a7b0b8";

    return response;
  } catch (error) {
    blockedCountEl.textContent = "0";
    imagesCountEl.textContent = "0";
    videosCountEl.textContent = "0";
    audioCountEl.textContent = "0";
    managedCountEl.textContent = "0";
    badgePreviewEl.textContent = "—";
    renderRecent([]);

    return null;
  }
}

async function loadPopup() {
  try {
    const stored = await api.storage.local.get(null);
    const settings = mergeSettings(stored);

    for (const id of TOGGLES) {
      setToggle(id, settings[keyForControl(id)]);
    }

    for (const id of SLIDERS) {
      setSlider(id, settings[id]);
    }

    for (const id of TEXTAREAS) {
      document.getElementById(id).value = settings[id] || "";
    }

    let dnrStatus = null;

    try {
      dnrStatus = await api.runtime.sendMessage({ type: "wg-dnr-status" });

      if (dnrStatus && dnrStatus.dnrAvailable === false) {
        showMessage("Warning: network-level blocking is unavailable. DOM media blocking remains active.", true);
      }
    } catch (error) {
      showMessage("Warning: could not verify network firewall availability.", true);
    }

    const activity = await refreshActivity();

    updateMasterUi(settings, dnrStatus, activity);
    applyLoggingSettings(settings);
    updateSiteUi(settings);

    if (stored.updateRecommended) {
      showMessage("WebGuard was updated. Use Repair to rebuild rules and reload this page.", true);
    }
  } catch (error) {
    showMessage("Settings load error: " + (error && error.message ? error.message : error), true);
  }
}

async function saveSetting(key, value) {
  try {
    await api.storage.local.set({ [key]: value });
    await WebGuardLogger.info("set", { key });

    const stored = await api.storage.local.get(null);
    const settings = mergeSettings(stored);

    let dnrStatus = null;

    try {
      dnrStatus = await api.runtime.sendMessage({ type: "wg-dnr-status" });
    } catch (error) {
      dnrStatus = null;
    }

    const activity = await refreshActivity();

    updateMasterUi(settings, dnrStatus, activity);
    updateSiteUi(settings);
    showMessage("");
  } catch (error) {
    showMessage("Save error: " + (error && error.message ? error.message : error), true);
  }
}

function debounceSave(key, value) {
  clearTimeout(sliderSaveTimer);

  sliderSaveTimer = setTimeout(() => {
    saveSetting(key, value);
  }, 300);
}

for (const id of TOGGLES) {
  const el = document.getElementById(id);

  el.addEventListener("change", () => {
    saveSetting(keyForControl(id), el.checked);
  });
}

for (const id of SLIDERS) {
  const el = document.getElementById(id);
  const pill = document.getElementById(SLIDER_LABELS[id]);

  el.addEventListener("input", () => {
    const value = Number(el.value);

    pill.textContent = id === "videoBufferTarget"
      ? value + " s"
      : value + " px";
  });

  el.addEventListener("change", () => {
    debounceSave(id, Number(el.value));
  });
}

for (const id of TEXTAREAS) {
  const el = document.getElementById(id);

  el.addEventListener("change", () => {
    saveSetting(id, el.value);
  });
}

logLevelSelect.addEventListener("change", () => {
  applyLoggingSettings({
    logLevel: logLevelSelect.value,
    loggingEnabled: document.getElementById("loggingEnabled").checked
  });

  saveSetting("logLevel", logLevelSelect.value);
});

firewallSiteToggle.addEventListener("change", () => {
  toggleSiteForFeature("firewallExceptions", firewallSiteToggle.checked);
});

optimizerSiteToggle.addEventListener("change", () => {
  toggleSiteForFeature("optimizerExceptions", optimizerSiteToggle.checked);
});

repairBtn.addEventListener("click", async () => {
  if (currentTabId === null) {
    showMessage("No supported page is active.", true);
    return;
  }

  repairBtn.disabled = true;

  try {
    const response = await api.runtime.sendMessage({
      type: "wg-repair",
      tabId: currentTabId
    });

    if (response && response.ok) {
      showMessage("WebGuard repaired. Page reloading.");
    } else {
      showMessage("Repair failed.", true);
    }
  } catch (error) {
    showMessage("Repair error: " + (error && error.message ? error.message : error), true);
  } finally {
    repairBtn.disabled = false;
  }
});

document.getElementById("exportBtn").addEventListener("click", async () => {
  try {
    const stored = await api.storage.local.get(null);
    const settings = mergeSettings(stored);

    const exportData = {
      extension: "WebGuard",
      exportedAt: new Date().toISOString(),
      settings
    };

    const blob = new Blob([JSON.stringify(exportData)], {
      type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "webguard-settings.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showMessage("Settings exported.");
  } catch (error) {
    showMessage("Export error: " + (error && error.message ? error.message : error), true);
  }
});

document.getElementById("importBtn").addEventListener("click", () => {
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files && importFile.files[0];

  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incoming = parsed && parsed.settings ? parsed.settings : parsed;

    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new Error("Invalid WebGuard settings file.");
    }

    const settings = mergeSettings(incoming);

    settings.iconThreshold = Math.min(500, Math.max(0, Number(settings.iconThreshold) || 200));
    settings.videoBufferTarget = Math.min(120, Math.max(1, Number(settings.videoBufferTarget) || 5));
    settings.triggerMargin = Math.min(2000, Math.max(0, Number(settings.triggerMargin) || 300));

    for (const key of ["firewallExceptions", "optimizerExceptions"]) {
      if (typeof settings[key] !== "string") {
        settings[key] = "";
      }
    }

    await api.storage.local.set(settings);

    await loadPopup();
    await WebGuardLogger.info("imp", {});
    showMessage("Settings imported.");
  } catch (error) {
    showMessage("Import error: " + (error && error.message ? error.message : error), true);
  } finally {
    importFile.value = "";
  }
});

document.getElementById("logsBtn").addEventListener("click", async () => {
  try {
    await WebGuardLogger.flush();

    const stored = await api.storage.local.get("diagnosticLogs");

    const exportData = {
      extension: "WebGuard",
      exportedAt: new Date().toISOString(),
      diagnosticLogs: Array.isArray(stored.diagnosticLogs) ? stored.diagnosticLogs : []
    };

    const blob = new Blob([JSON.stringify(exportData)], {
      type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "webguard-debug-logs.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showMessage("Diagnostic logs exported.");
  } catch (error) {
    showMessage("Logs error: " + (error && error.message ? error.message : error), true);
  }
});

function startActivityRefresh() {
  if (activityTimer) clearInterval(activityTimer);

  activityTimer = setInterval(refreshActivity, 1500);
}

function stopActivityRefresh() {
  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshActivity();
    startActivityRefresh();
  } else {
    stopActivityRefresh();
  }
});

loadPopup();
startActivityRefresh();
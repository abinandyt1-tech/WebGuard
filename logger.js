"use strict";

const WebGuardLogger = (() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const LEVELS = { D: 10, I: 20, W: 30, E: 40 };
  const NAMES = { debug: "D", info: "I", warn: "W", error: "E" };

  const EVENTS = {
    element_blocked: "blk",
    element_unblocked: "ublk",
    media_activated: "act",
    media_deactivated: "dea",
    setting_changed: "set",
    settings_imported: "imp",
    settings_load_failed: "lderr",
    content_settings_loaded: "cfg",
    webguard_content_ready: "rdy",
    background_ready: "brdy",
    background_startup_failed: "berr",
    webguard_installed: "inst",
    webguard_startup: "strt",
    firewall_rules_updated: "fwup",
    firewall_rules_failed: "fwerr",
    firewall_disabled_rules_removed: "fwoff",
    dnr_unavailable: "nodnr",
    temporary_allow_rule_created: "alw",
    temporary_allow_rules_removed: "alwx",
    allow_rule_creation_failed: "alwerr",
    allow_message_failed: "msgerr",
    unblock_background_unreachable: "uberr",
    tracker_image_hidden: "trk",
    background_tab_paused: "bpau",
    background_tab_resumed: "bres",
    background_canvas_frozen: "cfrz",
    js_animation_mode_applied: "raf",
    activity_count_received: "cnt",
    badge_updated: "bdg",
    badge_cleared: "bdgx",
    badge_api_unavailable: "nobdg",
    badge_update_failed: "bdgerr",
    badge_message_failed: "bdgmsg",
    dom_batch_failed: "domerr",
    allow_rule_cleanup_failed: "clnerr",
    allow_rule_unavailable: "noalw",
    site_disabled: "soff",
    site_enabled: "son",
    site_allow_added: "sit",
    repair_requested: "rep",
    repair_completed: "repd"
  };

  const DETAIL_KEYS = {
    tabId: "t",
    blocked: "b",
    managed: "m",
    images: "img",
    videos: "vid",
    audio: "aud",
    badgeText: "x",
    activeRules: "n",
    removedRules: "rm",
    resourceTypes: "rt",
    kind: "k",
    host: "h",
    message: "msg",
    key: "k",
    reason: "r",
    count: "n",
    allowRuleCreated: "alw",
    feature: "f",
    firewall: "fw",
    optimizer: "opt",
    dnrAvailable: "dnr",
    disabled: "off",
    throttled: "thr"
  };

  let currentLevel = LEVELS.I;
  let enabled = true;
  let baseTime = Date.now();

  let pendingEntries = [];
  let flushTimer = null;

  function shouldLog(level) {
    return enabled && (LEVELS[level] || LEVELS.I) >= currentLevel;
  }

  function shortTime() {
    const seconds = Math.max(0, Math.round((Date.now() - baseTime) / 1000));
    return "+" + seconds + "s";
  }

  function shortValue(value) {
    if (value === true) return "1";
    if (value === false) return "0";

    if (typeof value === "number") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return String(value.length);
    }

    if (typeof value === "string") {
      return value.length > 60 ? value.slice(0, 57) + "..." : value;
    }

    if (value && typeof value === "object") {
      return compactDetail(value);
    }

    return "";
  }

  function compactDetail(detail) {
    if (detail === undefined || detail === null) {
      return "";
    }

    if (
      typeof detail === "string" ||
      typeof detail === "number" ||
      typeof detail === "boolean"
    ) {
      return shortValue(detail);
    }

    const parts = [];

    for (const [key, value] of Object.entries(detail)) {
      const shortKey = DETAIL_KEYS[key] || key;
      const shortVal = shortValue(value);

      if (shortVal !== "") {
        parts.push(shortKey + ":" + shortVal);
      }
    }

    return parts.join(" ");
  }

  async function flush() {
    const batch = pendingEntries;
    pendingEntries = [];
    flushTimer = null;

    if (!batch.length) return;

    try {
      const stored = await api.storage.local.get("diagnosticLogs");
      const logs = Array.isArray(stored.diagnosticLogs) ? stored.diagnosticLogs : [];

      logs.push(...batch);

      await api.storage.local.set({ diagnosticLogs: logs });
    } catch (error) {
      // Logging must never break WebGuard.
    }
  }

  function queue(entry) {
    pendingEntries.push(entry);

    if (!flushTimer) {
      flushTimer = setTimeout(flush, 1000);
    }
  }

  async function write(level, event, detail) {
    if (!shouldLog(level)) return;

    const shortLevel = NAMES[level] || "I";
    const code = EVENTS[event] || event;
    const detailText = compactDetail(detail);

    const entry = detailText
      ? shortTime() + " " + shortLevel + " " + code + " " + detailText
      : shortTime() + " " + shortLevel + " " + code;

    queue(entry);
  }

  return {
    setEnabled(value) {
      enabled = Boolean(value);
    },

    isEnabled() {
      return enabled;
    },

    setLevel(level) {
      const short = NAMES[level];
      if (short && LEVELS[short]) currentLevel = LEVELS[short];
    },

    getLevel() {
      if (currentLevel === LEVELS.D) return "debug";
      if (currentLevel === LEVELS.W) return "warn";
      if (currentLevel === LEVELS.E) return "error";
      return "info";
    },

    async flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      await flush();
    },

    log(level, event, detail) {
      return write(NAMES[level] || "I", event, detail);
    },

    debug(event, detail) {
      return write("D", event, detail);
    },

    info(event, detail) {
      return write("I", event, detail);
    },

    warn(event, detail) {
      return write("W", event, detail);
    },

    error(event, detail) {
      return write("E", event, detail);
    }
  };
})();

if (typeof self !== "undefined") {
  self.WebGuardLogger = WebGuardLogger;
}

if (typeof globalThis !== "undefined") {
  globalThis.WebGuardLogger = WebGuardLogger;
}
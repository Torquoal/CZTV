/**
 * Shared between wall (index.html) and researcher control (control.html).
 * Same origin + BroadcastChannel keeps tabs in sync without a backend session store.
 */
(function () {
  const CZTV_CHANNEL = "cztv-control";
  const CZTV_STORAGE_KEY = "cztv_state_v5";

  /** Defaults for wall interaction / researcher UI (overridable in control panel). */
  const WALL_DEFAULTS = {
    showCoderHud: false,
    /** Keep browser fullscreen + top-edge shield (incl. engagement screen). */
    lockFullscreen: true,
    /** Emergency stop.png overlay; pauses interaction / webcam. */
    emergencyStop: false,
    /**
     * When true: maximized view exits only via top-right X button (rest of screen ignores taps).
     * When false: traditional tap-anywhere-to-return-to-wall.
     */
    closeButtonExit: false,
    tapCooldownMs: 2000,
    edgeDeadZonePx: 36,
    idleResetMs: 5 * 60 * 1000,
  };

  /**
   * Semantic views (what content is shown). Screen slot order is counterbalanced
   * across sessions (all 24 = 4! permutations), not random.
   * Default order (counterbalance off): top-left → live1, top-right → live2,
   * bottom-left → familiar, bottom-right → unfamiliar.
   */
  const VIEW_IDS = ["live1", "live2", "familiar", "unfamiliar"];
  const DEFAULT_LAYOUT_ORDER = VIEW_IDS.slice();
  const LAYOUT_PERM_INDEX_KEY = "cztv_layout_perm_index_v1";
  const LAYOUT_PERM_COUNT = 24; // 4!

  /** Human-readable content names written to CSV `view` (position goes in `tile`/`slot`). */
  const VIEW_LABELS = {
    live1: "live 1 BRU",
    live2: "live 2 enclosure",
    unfamiliar: "video 1 unfamiliar",
    familiar: "video 2 familiar",
  };

  /**
   * Fallback playlists if /api/video-sets is unavailable.
   * Preferred source: drop clips in web/media/familiar/ and web/media/unfamiliar/
   * (discovered automatically by the server).
   * @type {Record<string, string[]>}
   */
  const VIDEO_SETS = {
    familiar: [],
    unfamiliar: [],
  };

  /**
   * Coding hotkeys → participant IDs (P1–P14).
   * Plain key: toggle presence in area.
   * Shift+key: set active user (chimp touching the screen / PID).
   */
  const PID_HOTKEYS = {
    q: "P1",
    w: "P2",
    e: "P3",
    r: "P4",
    t: "P5",
    y: "P6",
    u: "P7",
    i: "P8",
    o: "P9",
    p: "P10",
    a: "P11",
    s: "P12",
    d: "P13",
    f: "P14",
  };

  const PARTICIPANT_IDS = Object.values(PID_HOTKEYS);

  /**
   * Live camera config (script-side source of truth).
   * The wall POSTs this to /api/cameras on start so the Python/ffmpeg bridge
   * can open RTSP. Edit hosts / credentials here.
   *
   * Note: anything in this file is visible in the browser. Fine for a local
   * offline kiosk LAN; do not expose this page on the public internet.
   */
  const LIVE_CAMERAS = [
    {
      id: "cam1",
      label: "live 1 BRU",
      host: "192.168.50.174",
      path: "/stream1",
      username: "Shaun1",
      password: "futurefauna1",
    },
    {
      id: "cam2",
      label: "live 2 enclosure",
      host: "192.168.50.140",
      path: "/stream1",
      username: "Shaun1",
      password: "futurefauna1",
    },
  ];

  function pidSortKey(id) {
    const m = /^P(\d+)$/i.exec(String(id || ""));
    return m ? Number(m[1]) : 999;
  }

  function normalizePresentIds(ids) {
    const allowed = new Set(PARTICIPANT_IDS);
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw || "").trim().toUpperCase();
      if (!allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort((a, b) => pidSortKey(a) - pidSortKey(b));
    return out;
  }

  function normalizeParticipantId(id) {
    const s = String(id || "").trim().toUpperCase();
    if (PARTICIPANT_IDS.includes(s)) return s;
    return String(id || "").trim();
  }

  function permutationsOf(items) {
    if (items.length <= 1) return [items.slice()];
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const p of permutationsOf(rest)) {
        out.push([items[i]].concat(p));
      }
    }
    return out;
  }

  /** Fixed list of all 24 view placements (lexicographic from DEFAULT_LAYOUT_ORDER). */
  const ALL_LAYOUT_PERMUTATIONS = permutationsOf(DEFAULT_LAYOUT_ORDER);

  function normalizeLayoutOrder(order) {
    const allowed = new Set(VIEW_IDS);
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(order) ? order : []) {
      const id = String(raw || "").trim();
      if (!allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    for (const id of VIEW_IDS) {
      if (!seen.has(id)) out.push(id);
    }
    return out.slice(0, 4);
  }

  function readLayoutPermIndex() {
    try {
      const n = Number(localStorage.getItem(LAYOUT_PERM_INDEX_KEY));
      if (!Number.isFinite(n)) return 0;
      return ((Math.trunc(n) % LAYOUT_PERM_COUNT) + LAYOUT_PERM_COUNT) % LAYOUT_PERM_COUNT;
    } catch {
      return 0;
    }
  }

  function writeLayoutPermIndex(idx) {
    const n = ((Math.trunc(idx) % LAYOUT_PERM_COUNT) + LAYOUT_PERM_COUNT) % LAYOUT_PERM_COUNT;
    try {
      localStorage.setItem(LAYOUT_PERM_INDEX_KEY, String(n));
    } catch {
      /* ignore */
    }
    return n;
  }

  /**
   * Pick this session's layout.
   * counterbalance=true → next of the 24 permutations (advances for next session).
   * counterbalance=false → fixed default order (layoutIndex = -1).
   * @returns {{ order: string[], layoutIndex: number }}
   */
  function takeSessionLayout(counterbalance) {
    if (!counterbalance) {
      return { order: DEFAULT_LAYOUT_ORDER.slice(), layoutIndex: -1 };
    }
    const layoutIndex = readLayoutPermIndex();
    const order = (ALL_LAYOUT_PERMUTATIONS[layoutIndex] || DEFAULT_LAYOUT_ORDER).slice();
    writeLayoutPermIndex(layoutIndex + 1);
    return { order: normalizeLayoutOrder(order), layoutIndex };
  }

  /** @deprecated use takeSessionLayout — kept for older callers */
  function buildLayoutOrder(counterbalance) {
    return takeSessionLayout(counterbalance).order;
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function defaultState() {
    return {
      participantId: "PX",
      presentIds: [],
      // When true: cycle through all 24 placements across sessions (counterbalance).
      // When false: always use DEFAULT_LAYOUT_ORDER.
      randomizeLayout: true,
      showCoderHud: WALL_DEFAULTS.showCoderHud,
      lockFullscreen: WALL_DEFAULTS.lockFullscreen,
      emergencyStop: WALL_DEFAULTS.emergencyStop,
      closeButtonExit: WALL_DEFAULTS.closeButtonExit,
      tapCooldownMs: WALL_DEFAULTS.tapCooldownMs,
      edgeDeadZonePx: WALL_DEFAULTS.edgeDeadZonePx,
      idleResetMs: WALL_DEFAULTS.idleResetMs,
    };
  }

  function readState() {
    try {
      const raw = localStorage.getItem(CZTV_STORAGE_KEY);
      if (!raw) return defaultState();
      const o = JSON.parse(raw);
      const d = defaultState();
      return {
        participantId: normalizeParticipantId(o.participantId) || "PX",
        presentIds: normalizePresentIds(o.presentIds),
        randomizeLayout: o.randomizeLayout !== false,
        showCoderHud: o.showCoderHud === true,
        // Default ON when missing (older saved state).
        lockFullscreen: o.lockFullscreen !== false,
        emergencyStop: o.emergencyStop === true,
        closeButtonExit: o.closeButtonExit === true,
        tapCooldownMs: clampInt(o.tapCooldownMs, 0, 30000, d.tapCooldownMs),
        edgeDeadZonePx: clampInt(o.edgeDeadZonePx, 0, 400, d.edgeDeadZonePx),
        idleResetMs: clampInt(o.idleResetMs, 60000, 3600000, d.idleResetMs),
      };
    } catch {
      return defaultState();
    }
  }

  function writeState(state) {
    const d = defaultState();
    const next = {
      participantId: normalizeParticipantId(state.participantId) || "PX",
      presentIds: normalizePresentIds(state.presentIds),
      randomizeLayout: state.randomizeLayout !== false,
      showCoderHud: state.showCoderHud === true,
      lockFullscreen: state.lockFullscreen !== false,
      emergencyStop: state.emergencyStop === true,
      closeButtonExit: state.closeButtonExit === true,
      tapCooldownMs: clampInt(state.tapCooldownMs, 0, 30000, d.tapCooldownMs),
      edgeDeadZonePx: clampInt(state.edgeDeadZonePx, 0, 400, d.edgeDeadZonePx),
      idleResetMs: clampInt(state.idleResetMs, 60000, 3600000, d.idleResetMs),
    };
    localStorage.setItem(CZTV_STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  /** Ensure active user is also listed as present (does not remove anyone). */
  function ensurePresentIncludes(presentIds, participantId) {
    const pid = normalizeParticipantId(participantId);
    const list = normalizePresentIds(presentIds);
    if (!pid || list.includes(pid)) return list;
    return normalizePresentIds([...list, pid]);
  }

  /** Session id from local day + wall start time, e.g. 2026-10-23_162700 */
  function makeSessionId(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${y}-${m}-${d}_${hh}${mm}${ss}`;
  }

  function liveCamerasPayload() {
    const cameras = LIVE_CAMERAS.map((c, i) => ({
      id: c.id || `cam${i + 1}`,
      label: c.label || `Camera ${i + 1}`,
      host: (c.host || "").trim(),
      path: c.path || "/stream1",
      username: c.username || "",
      password: c.password || "",
    }));
    while (cameras.length < 4) {
      cameras.push({
        id: `cam${cameras.length + 1}`,
        label: `Camera ${cameras.length + 1}`,
        host: "",
        path: "/stream1",
        username: "",
        password: "",
      });
    }
    return { cameras, tileMap: [0, 1, 2, 3] };
  }

  function resolvePidHotkey(event) {
    if (!event || event.altKey || event.ctrlKey || event.metaKey) return null;
    if (event.repeat) return null;
    const key = String(event.key || "").toLowerCase();
    const pid = PID_HOTKEYS[key];
    if (!pid) return null;
    return { pid, shift: Boolean(event.shiftKey), key };
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return Boolean(target.closest("[contenteditable='true']"));
  }

  window.CZTV = {
    CHANNEL: CZTV_CHANNEL,
    STORAGE_KEY: CZTV_STORAGE_KEY,
    WALL_DEFAULTS,
    VIEW_IDS,
    DEFAULT_LAYOUT_ORDER,
    ALL_LAYOUT_PERMUTATIONS,
    LAYOUT_PERM_COUNT,
    VIEW_LABELS,
    VIDEO_SETS,
    LIVE_CAMERAS,
    PID_HOTKEYS,
    PARTICIPANT_IDS,
    liveCamerasPayload,
    normalizePresentIds,
    normalizeParticipantId,
    ensurePresentIncludes,
    normalizeLayoutOrder,
    readLayoutPermIndex,
    writeLayoutPermIndex,
    takeSessionLayout,
    buildLayoutOrder,
    makeSessionId,
    resolvePidHotkey,
    isTypingTarget,
    defaultState,
    readState,
    writeState,
  };
})();

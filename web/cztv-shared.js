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
    tapCooldownMs: 2000,
    edgeDeadZonePx: 48,
    idleResetMs: 5 * 60 * 1000,
  };

  /**
   * Semantic views (what content is shown). Screen slot order may be shuffled.
   * Default order (randomize off): top-left → live1, top-right → live2,
   * bottom-left → familiar, bottom-right → unfamiliar.
   */
  const VIEW_IDS = ["live1", "live2", "familiar", "unfamiliar"];
  const DEFAULT_LAYOUT_ORDER = VIEW_IDS.slice();

  /** Human-readable content names written to CSV `view` (position goes in `tile`/`slot`). */
  const VIEW_LABELS = {
    live1: "live 1 BRU",
    live2: "live 2 enclosure",
    unfamiliar: "video 1 unfamiliar",
    familiar: "video 2 familiar",
  };

  /** @type {Record<string, string[]>} setId -> playlist URLs for video views */
  const VIDEO_SETS = {
    familiar: ["/media/chimpvid.mp4", "/media/chimps2vid.mp4"],
    unfamiliar: ["/media/jungle.mp4", "/media/crossing.mp4"],
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

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

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

  function buildLayoutOrder(randomize) {
    const order = DEFAULT_LAYOUT_ORDER.slice();
    if (randomize) shuffleInPlace(order);
    return order;
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function defaultState() {
    return {
      participantId: "",
      presentIds: [],
      randomizeLayout: true,
      showCoderHud: WALL_DEFAULTS.showCoderHud,
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
        participantId: normalizeParticipantId(o.participantId),
        presentIds: normalizePresentIds(o.presentIds),
        randomizeLayout: o.randomizeLayout !== false,
        showCoderHud: o.showCoderHud === true,
        tapCooldownMs: clampInt(o.tapCooldownMs, 0, 30000, d.tapCooldownMs),
        edgeDeadZonePx: clampInt(o.edgeDeadZonePx, 0, 400, d.edgeDeadZonePx),
        idleResetMs: clampInt(o.idleResetMs, 10000, 3600000, d.idleResetMs),
      };
    } catch {
      return defaultState();
    }
  }

  function writeState(state) {
    const d = defaultState();
    const next = {
      participantId: normalizeParticipantId(state.participantId),
      presentIds: normalizePresentIds(state.presentIds),
      randomizeLayout: state.randomizeLayout !== false,
      showCoderHud: state.showCoderHud === true,
      tapCooldownMs: clampInt(state.tapCooldownMs, 0, 30000, d.tapCooldownMs),
      edgeDeadZonePx: clampInt(state.edgeDeadZonePx, 0, 400, d.edgeDeadZonePx),
      idleResetMs: clampInt(state.idleResetMs, 10000, 3600000, d.idleResetMs),
    };
    localStorage.setItem(CZTV_STORAGE_KEY, JSON.stringify(next));
    return next;
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
    VIEW_LABELS,
    VIDEO_SETS,
    LIVE_CAMERAS,
    PID_HOTKEYS,
    PARTICIPANT_IDS,
    liveCamerasPayload,
    normalizePresentIds,
    normalizeParticipantId,
    normalizeLayoutOrder,
    buildLayoutOrder,
    makeSessionId,
    resolvePidHotkey,
    isTypingTarget,
    defaultState,
    readState,
    writeState,
  };
})();

/**
 * Shared between wall (index.html) and researcher control (control.html).
 * Same origin + BroadcastChannel keeps tabs in sync without a backend session store.
 */
(function () {
  const CZTV_CHANNEL = "cztv-control";
  const CZTV_STORAGE_KEY = "cztv_state_v1";

  /** @type {Record<string, string[]>} presetId -> four URLs for tiles 1–4 */
  const PRESETS = {
    default: [
      "/media/jungle.mp4",
      "/media/chimpvid.mp4",
      "/media/crossing.mp4",
      "/media/chimps2vid.mp4",
    ],
    alt_order: [
      "/media/chimpvid.mp4",
      "/media/jungle.mp4",
      "/media/chimps2vid.mp4",
      "/media/crossing.mp4",
    ],
  };

  function defaultState() {
    return {
      participantId: "",
      mode: "live",
      preset: "default",
    };
  }

  function readState() {
    try {
      const raw = localStorage.getItem(CZTV_STORAGE_KEY);
      if (!raw) return defaultState();
      const o = JSON.parse(raw);
      return {
        participantId: typeof o.participantId === "string" ? o.participantId : "",
        mode: o.mode === "recorded" ? "recorded" : "live",
        preset: typeof o.preset === "string" && PRESETS[o.preset] ? o.preset : "default",
      };
    } catch {
      return defaultState();
    }
  }

  function writeState(state) {
    const next = {
      participantId: String(state.participantId ?? ""),
      mode: state.mode === "recorded" ? "recorded" : "live",
      preset: typeof state.preset === "string" && PRESETS[state.preset] ? state.preset : "default",
    };
    localStorage.setItem(CZTV_STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  window.CZTV = {
    CHANNEL: CZTV_CHANNEL,
    STORAGE_KEY: CZTV_STORAGE_KEY,
    PRESETS,
    defaultState,
    readState,
    writeState,
  };
})();

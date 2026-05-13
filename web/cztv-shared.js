/**
 * Shared between wall (index.html) and researcher control (control.html).
 * Same origin + BroadcastChannel keeps tabs in sync without a backend session store.
 */
(function () {
  const CZTV_CHANNEL = "cztv-control";
  const CZTV_STORAGE_KEY = "cztv_state_v1";

  /**
   * Placeholder URLs for four IP cameras (one per tile). Replace with your LAN gateway
   * (e.g. HLS .m3u8 from go2rtc/MediaMTX/ffmpeg); browsers cannot play Tapo RTSP directly.
   * @type {string[]}
   */
  const NETWORK_STREAM_STUBS = [
    "http://192.168.1.201:8888/cam1/index.m3u8",
    "http://192.168.1.202:8888/cam2/index.m3u8",
    "http://192.168.1.203:8888/cam3/index.m3u8",
    "http://192.168.1.204:8888/cam4/index.m3u8",
  ];

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
      const mode =
        o.mode === "recorded" ? "recorded" : o.mode === "network" ? "network" : "live";
      return {
        participantId: typeof o.participantId === "string" ? o.participantId : "",
        mode,
        preset: typeof o.preset === "string" && PRESETS[o.preset] ? o.preset : "default",
      };
    } catch {
      return defaultState();
    }
  }

  function writeState(state) {
    const mode =
      state.mode === "recorded" ? "recorded" : state.mode === "network" ? "network" : "live";
    const next = {
      participantId: String(state.participantId ?? ""),
      mode,
      preset: typeof state.preset === "string" && PRESETS[state.preset] ? state.preset : "default",
    };
    localStorage.setItem(CZTV_STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  window.CZTV = {
    CHANNEL: CZTV_CHANNEL,
    STORAGE_KEY: CZTV_STORAGE_KEY,
    PRESETS,
    NETWORK_STREAM_STUBS,
    defaultState,
    readState,
    writeState,
  };
})();

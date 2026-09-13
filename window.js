const STORAGE_KEY = "settings";
const CHANNEL_NAME = "echo-plugin:desktop-lyric-styler:settings";
const LYRIC_LOOKAHEAD_MS = 90;
const CLOCK_INTERVAL_MS = 120;
const SETTINGS_POLL_MS = 500;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoOpen: true,
  alwaysOnTop: true,
  fontFamily: "",
  fontSize: 22,
  playedColor: "#ffffff",
  unplayedColor: "#8a8a8a",
  showTranslation: true,
  align: "center",
  boldCurrent: true,
  lineHeight: 1.7,
  backgroundOpacity: 22,
  backgroundBlur: 18,
  clickThrough: false,
};

const ALIGNS = ["center", "left"];

const FONT_SIZES = [12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const normalizeSettings = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const align = ALIGNS.includes(source.align)
    ? source.align
    : DEFAULT_SETTINGS.align;
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    enabled: source.enabled ?? DEFAULT_SETTINGS.enabled,
    autoOpen: source.autoOpen ?? DEFAULT_SETTINGS.autoOpen,
    alwaysOnTop: source.alwaysOnTop ?? DEFAULT_SETTINGS.alwaysOnTop,
    fontFamily:
      typeof source.fontFamily === "string"
        ? source.fontFamily
        : DEFAULT_SETTINGS.fontFamily,
    fontSize: clamp(source.fontSize ?? DEFAULT_SETTINGS.fontSize, 12, 72),
    playedColor:
      typeof source.playedColor === "string"
        ? source.playedColor
        : DEFAULT_SETTINGS.playedColor,
    unplayedColor:
      typeof source.unplayedColor === "string"
        ? source.unplayedColor
        : DEFAULT_SETTINGS.unplayedColor,
    showTranslation: source.showTranslation ?? DEFAULT_SETTINGS.showTranslation,
    align,
    boldCurrent: source.boldCurrent ?? DEFAULT_SETTINGS.boldCurrent,
    lineHeight: clamp(source.lineHeight ?? DEFAULT_SETTINGS.lineHeight, 1, 3),
    backgroundOpacity: clamp(
      source.backgroundOpacity ?? DEFAULT_SETTINGS.backgroundOpacity,
      0,
      100,
    ),
    backgroundBlur: clamp(
      source.backgroundBlur ?? DEFAULT_SETTINGS.backgroundBlur,
      0,
      40,
    ),
    clickThrough: source.clickThrough ?? DEFAULT_SETTINGS.clickThrough,
  };
};

const getEstimatedPlaybackMs = (playback) => {
  if (!playback) return 0;
  const baseMs = Math.max(0, Number(playback.currentTime || 0) * 1000);
  if (!playback.isPlaying) return baseMs;
  const updatedAt = Number(playback.updatedAt || Date.now());
  const playbackRate = Math.max(0.1, Number(playback.playbackRate || 1));
  const elapsedMs = Math.max(0, Date.now() - updatedAt) * playbackRate;
  const durationMs = Math.max(0, Number(playback.duration || 0) * 1000);
  const seekMs = baseMs + elapsedMs;
  return durationMs > 0 ? Math.min(seekMs, durationMs) : seekMs;
};

const getLineStartMs = (line) => {
  const charStart = line?.characters?.[0]?.startTime;
  if (Number.isFinite(charStart)) return charStart;
  return Math.round((Number(line?.time) || 0) * 1000);
};

const calculateLineIndex = (lines, seekMs) => {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  let index = -1;
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (seekMs >= getLineStartMs(lines[mid])) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return index;
};

const getActiveLineIndex = (snapshot) => {
  const lyric = snapshot?.lyric;
  const playback = snapshot?.playback;
  const lines = lyric?.lines ?? [];
  if (!lyric || lines.length === 0) return -1;

  const canEstimate =
    playback?.trackId && (!lyric.trackId || lyric.trackId === playback.trackId);
  if (canEstimate) {
    const seekMs =
      getEstimatedPlaybackMs(playback) +
      Number(lyric.timeOffset || 0) +
      LYRIC_LOOKAHEAD_MS;
    const index = calculateLineIndex(lines, seekMs);
    if (index >= 0) return index;
  }
  const fallbackIndex = Number(lyric.currentIndex);
  return Number.isFinite(fallbackIndex) ? fallbackIndex : -1;
};

const getFontFamily = (ctx, settings, snapshot) => {
  if (settings.fontFamily) {
    try {
      const family = ctx.fonts.buildFamily(settings.fontFamily);
      if (family) return family;
    } catch {
      /* 忽略，回退到系统字体 */
    }
  }
  return (
    snapshot?.appearance?.fontFamily ||
    'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
  );
};

export function activateWindow(ctx) {
  const { computed, createApp, h, nextTick, onBeforeUnmount, onMounted, ref, watch } =
    ctx.vue;

  const App = {
    name: "DesktopLyricStylerWindow",
    setup() {
      const snapshot = ref(null);
      const clock = ref(Date.now());
      const settings = ref(normalizeSettings(DEFAULT_SETTINGS));
      const scrollEl = ref(null);
      const toolbarEl = ref(null);
      let disposeSnapshot = null;
      let disposeDrag = null;
      let clockTimer = 0;
      let settingsTimer = 0;
      let scrollFrame = 0;
      let channel = null;
      let applyingRemote = false;

      const saveSettings = async (values, options = {}) => {
        const next = normalizeSettings(values);
        settings.value = next;
        if (options.broadcast !== false) {
          try {
            await ctx.storage.set(STORAGE_KEY, next);
          } catch (error) {
            console.warn("[desktop-lyric-styler] 写入设置失败", error);
          }
          if (channel && !applyingRemote) {
            try {
              channel.postMessage({ type: "settings", settings: next });
            } catch {
              /* 忽略 */
            }
          }
        }
      };

      const applyRemoteSettings = (value) => {
        applyingRemote = true;
        settings.value = normalizeSettings(value);
        applyingRemote = false;
      };

      const lyric = computed(() => snapshot.value?.lyric ?? null);
      const playback = computed(() => snapshot.value?.playback ?? null);
      const appearance = computed(
        () =>
          snapshot.value?.appearance ?? {
            isDark: true,
            accentColor: "#31cfa1",
            fontFamily: "",
          },
      );
      const lines = computed(() => lyric.value?.lines ?? []);
      const activeIndex = computed(() => {
        void clock.value;
        return getActiveLineIndex(snapshot.value);
      });
      const hasLyric = computed(() => lines.value.length > 0);
      const fontFamily = computed(() =>
        getFontFamily(ctx, settings.value, snapshot.value),
      );

      const trackTitle = computed(() => {
        const title = String(playback.value?.title || "").trim();
        const artist = String(playback.value?.artist || "").trim();
        const displayTitle = title || "EchoMusic";
        if (!artist || artist === displayTitle) return displayTitle;
        return `${displayTitle} - ${artist}`;
      });

      const translationFor = (line) =>
        settings.value.showTranslation
          ? String(line?.translated || line?.romanized || "").trim()
          : "";

      const scrollActiveIntoView = () => {
        if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
        scrollFrame = window.requestAnimationFrame(() => {
          scrollFrame = 0;
          const container = scrollEl.value;
          if (!container) return;
          const current = container.querySelector(".di-line.is-current");
          if (!current) return;
          const top =
            current.offsetTop -
            container.clientHeight / 2 +
            current.clientHeight / 2;
          container.scrollTo({ top, behavior: "smooth" });
        });
      };

      const svgIcon = (name) => {
        const common = {
          class: "di-icon",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "2.2",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "aria-hidden": "true",
        };
        const path = (d) => h("path", { d });
        if (name === "minus") return h("svg", common, [path("M5 12h14")]);
        if (name === "plus") return h("svg", common, [path("M12 5v14"), path("M5 12h14")]);
        if (name === "translate")
          return h("svg", common, [
            path("M4 6h11"),
            path("M8 4l3 2-3 2"),
            path("M13 14l4 4 4-4"),
            path("M17 12v6"),
          ]);
        if (name === "pin")
          return h("svg", common, [
            path("M12 16v5"),
            path("M7 16h10"),
            path("M9 4h6l1 6 2 2v2H6v-2l2-2 1-6Z"),
          ]);
        if (name === "close") return h("svg", common, [path("M6 6l12 12"), path("M18 6L6 18")]);
        return h("svg", common, [path("M12 5v14"), path("M5 12h14")]);
      };

      const iconButton = (title, icon, onClick, options = {}) =>
        h(
          "button",
          {
            class: [
              "di-btn",
              options.active ? "is-active" : "",
              options.danger ? "is-danger" : "",
            ],
            type: "button",
            title,
            onClick: (event) => {
              event.stopPropagation();
              onClick(event);
            },
          },
          [svgIcon(icon)],
        );

      // 按预设档位跳档，与设置页下拉菜单保持一致
      const stepFontSize = (direction) => {
        const current = clamp(
          Number(settings.value.fontSize) || DEFAULT_SETTINGS.fontSize,
          12,
          72,
        );
        let index = 0;
        let best = Number.POSITIVE_INFINITY;
        FONT_SIZES.forEach((size, i) => {
          const diff = Math.abs(size - current);
          if (diff < best) {
            best = diff;
            index = i;
          }
        });
        const nextIndex = Math.min(
          Math.max(index + direction, 0),
          FONT_SIZES.length - 1,
        );
        return saveSettings({
          ...settings.value,
          fontSize: FONT_SIZES[nextIndex],
        });
      };

      const toggleTranslation = () =>
        saveSettings({
          ...settings.value,
          showTranslation: !settings.value.showTranslation,
        });

      const togglePin = async () => {
        const next = !settings.value.alwaysOnTop;
        await saveSettings({ ...settings.value, alwaysOnTop: next });
        await ctx.window.setAlwaysOnTop(next).catch(() => undefined);
      };

      const lineClass = (index) => {
        const classes = ["di-line"];
        if (index <= activeIndex.value) classes.push("is-played");
        if (index === activeIndex.value && settings.value.boldCurrent)
          classes.push("is-current");
        return classes;
      };

      const rootStyle = computed(() => ({
        "--played": settings.value.playedColor,
        "--unplayed": settings.value.unplayedColor,
        "--font-size": `${settings.value.fontSize}px`,
        "--line-height": String(settings.value.lineHeight),
        "--align": settings.value.align,
        "--bg-opacity": String(settings.value.backgroundOpacity / 100),
        "--bg-blur": `${settings.value.backgroundBlur}px`,
        "--font-family": fontFamily.value,
      }));

      onMounted(async () => {
        try {
          snapshot.value = await ctx.nowPlaying.getSnapshot();
        } catch (error) {
          console.warn("[desktop-lyric-styler] 读取播放快照失败", error);
        }
        disposeSnapshot = ctx.nowPlaying.onSnapshot((next) => {
          snapshot.value = next;
        });

        clockTimer = window.setInterval(() => {
          clock.value = Date.now();
        }, CLOCK_INTERVAL_MS);

        settingsTimer = window.setInterval(() => {
          if (applyingRemote) return;
          ctx.storage
            .get(STORAGE_KEY)
            .then((value) => {
              if (value) applyRemoteSettings(value);
            })
            .catch(() => undefined);
        }, SETTINGS_POLL_MS);

        if (typeof BroadcastChannel === "function") {
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.onmessage = (event) => {
            const payload = event.data;
            if (payload?.type === "settings") applyRemoteSettings(payload.settings);
          };
        }

        if (toolbarEl.value && ctx.window.drag?.bind) {
          try {
            disposeDrag = ctx.window.drag.bind(toolbarEl.value);
          } catch (error) {
            console.warn("[desktop-lyric-styler] 绑定拖动失败", error);
          }
        }

        await ctx.window
          .setAlwaysOnTop(settings.value.alwaysOnTop)
          .catch(() => undefined);
        await ctx.window
          .setIgnoreMouseEvents(Boolean(settings.value.clickThrough))
          .catch(() => undefined);
      });

      onBeforeUnmount(() => {
        disposeSnapshot?.();
        disposeDrag?.();
        if (clockTimer) window.clearInterval(clockTimer);
        if (settingsTimer) window.clearInterval(settingsTimer);
        if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
        channel?.close();
      });

      watch(activeIndex, () => scrollActiveIntoView());
      watch(
        () => settings.value.alwaysOnTop,
        (value) =>
          ctx.window.setAlwaysOnTop(value).catch(() => undefined),
      );
      watch(
        () => settings.value.clickThrough,
        (value) =>
          ctx.window.setIgnoreMouseEvents(Boolean(value)).catch(() => undefined),
      );

      return () => {
        void clock.value;
        const root = h(
          "div",
          { class: "di-root", style: rootStyle.value },
          [
            h("div", { class: "di-toolbar", ref: toolbarEl }, [
              iconButton("减小字号", "minus", () => stepFontSize(-1)),
              iconButton("增大字号", "plus", () => stepFontSize(1)),
              iconButton(
                "翻译开关",
                "translate",
                toggleTranslation,
                { active: settings.value.showTranslation },
              ),
              iconButton(
                "窗口置顶",
                "pin",
                () => void togglePin().catch(() => undefined),
                { active: settings.value.alwaysOnTop },
              ),
              h("span", { class: "di-divider" }),
              iconButton(
                "隐藏浮窗",
                "close",
                () => ctx.window.hide().catch(() => undefined),
                { danger: true },
              ),
            ]),
            hasLyric.value
              ? h(
                  "div",
                  { class: "di-scroll", ref: scrollEl },
                  lines.value.map((line, index) =>
                    h("div", { key: index }, [
                      h(
                        "p",
                        { class: lineClass(index) },
                        String(line.text || "").trim() || "♪",
                      ),
                      translationFor(line)
                        ? h("p", { class: "di-translation" }, translationFor(line))
                        : null,
                    ]),
                  ),
                )
              : h("div", { class: "di-empty" }, [
                  h(
                    "div",
                    { class: "di-empty-title" },
                    lyric.value?.isLoading ? "歌词加载中…" : trackTitle.value,
                  ),
                  h(
                    "div",
                    { class: "di-empty-sub" },
                    lyric.value?.isLoading
                      ? "等待歌词数据"
                      : playback.value?.isPlaying
                        ? "当前歌曲暂无歌词"
                        : "播放后这里显示桌面歌词",
                  ),
                ]),
          ],
        );
        return root;
      };
    },
  };

  const app = createApp(App);
  app.mount(ctx.container);
  ctx.dispose(() => app.unmount());
}

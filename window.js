const STORAGE_KEY = "settings";
const CHANNEL_NAME = "echo-plugin:desktop-lyric-styler:settings";
const LYRIC_LOOKAHEAD_MS = 90;
const CLOCK_INTERVAL_MS = 50;
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
  locked: false,
  karaoke: true,
  karaokeColor: "#31cfa1",
};

const ALIGNS = ["center", "left"];

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
    locked: source.locked ?? DEFAULT_SETTINGS.locked,
    karaoke: source.karaoke ?? DEFAULT_SETTINGS.karaoke,
    karaokeColor:
      typeof source.karaokeColor === "string"
        ? source.karaokeColor
        : DEFAULT_SETTINGS.karaokeColor,
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

// 当前歌词进度（毫秒），无法推算时返回 -1。
// 注意：只在「明确是不同曲目」时才放弃推算——若用严格 !== 比较，
// number/string 类型差异会导致误判，逐词高亮会整条失效
// （行高亮因有 lyric.currentIndex 兜底而不受影响，所以问题不易察觉）。
const getLyricSeekMs = (snapshot) => {
  const lyric = snapshot?.lyric;
  const playback = snapshot?.playback;
  if (!lyric || !playback) return -1;
  if (
    playback.trackId != null &&
    lyric.trackId != null &&
    String(playback.trackId) !== String(lyric.trackId)
  ) {
    return -1;
  }
  return (
    getEstimatedPlaybackMs(playback) +
    Number(lyric.timeOffset || 0) +
    LYRIC_LOOKAHEAD_MS
  );
};

const getActiveLineIndex = (snapshot) => {
  const lyric = snapshot?.lyric;
  const lines = lyric?.lines ?? [];
  if (!lyric || lines.length === 0) return -1;

  const seekMs = getLyricSeekMs(snapshot);
  if (seekMs >= 0) {
    const index = calculateLineIndex(lines, seekMs);
    if (index >= 0) return index;
  }
  const fallbackIndex = Number(lyric.currentIndex);
  return Number.isFinite(fallbackIndex) ? fallbackIndex : -1;
};

// 逐字单元：优先使用歌词自带的 characters（含 text / startTime / endTime，毫秒，
// 与宿主桌面歌词同源），仅在能完整还原该行文本时才采用；否则按文本兜底切分：
// 含空格按词分、无空格按字分（中文逐字），时间按片段长度加权均分。
const getLineSegments = (line, nextLine) => {
  const plain = String(line?.text || "").trim();
  const characters = Array.isArray(line?.characters) ? line.characters : null;

  if (characters && characters.length > 0) {
    const items = characters.map((item) => ({
      text: String(item?.text ?? ""),
      start: Number(item?.startTime),
    }));
    const joined = items
      .map((item) => item.text)
      .join("")
      .replace(/\s/g, "");
    const matchesLine =
      joined.length > 0 && joined === plain.replace(/\s/g, "");
    const hasTiming = items.every(
      (item) => Number.isFinite(item.start) && item.start >= 0,
    );
    if (matchesLine && hasTiming) {
      return items.filter((item) => item.text.length > 0);
    }
  }

  if (!plain) return [];
  const parts = /\s/.test(plain)
    ? plain.split(/(\s+)/).filter((part) => part.length > 0)
    : Array.from(plain);
  if (parts.length === 0) return [];

  const lineStart = getLineStartMs(line);
  const nextStart = nextLine ? getLineStartMs(nextLine) : -1;
  const durationMs =
    nextStart > lineStart ? nextStart - lineStart : Math.max(1200, parts.length * 260);
  const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;

  let acc = 0;
  return parts.map((part) => {
    const start = lineStart + (durationMs * acc) / total;
    acc += part.length;
    return { text: part, start };
  });
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
      const contentEl = ref(null);
      let disposeSnapshot = null;
      let disposeDrag = null;
      let clockTimer = 0;
      let settingsTimer = 0;
      let scrollFrame = 0;
      let channel = null;
      let applyingRemote = false;
      // 兜底行内计时锚点：播放进度不可用时，用当前行切换的墙钟时间近似
      let lineAnchorAt = Date.now();

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
      const currentSeekMs = computed(() => {
        void clock.value;
        const seek = getLyricSeekMs(snapshot.value);
        if (seek >= 0) return seek;
        // 兜底：播放进度推算不可用时，用当前行切换的墙钟时间近似行内进度，
        // 保证逐词染色始终能推进（行高亮本身还有 currentIndex 兜底）。
        const line = lines.value[activeIndex.value];
        if (!line) return -1;
        return getLineStartMs(line) + (Date.now() - lineAnchorAt);
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
        if (name === "lock")
          return h("svg", common, [
            path("M8 10V7a4 4 0 0 1 8 0v3"),
            path("M6 10h12v10H6z"),
          ]);
        if (name === "unlock")
          return h("svg", common, [
            path("M8 10V7a4 4 0 0 1 7.6-1.7"),
            path("M6 10h12v10H6z"),
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

      const toggleLock = () =>
        saveSettings({ ...settings.value, locked: !settings.value.locked });

      // 注意：宿主的 drag.bind 会在 pointerdown 上调用 setPointerCapture + preventDefault，
      // 被绑定元素的**子元素**将收不到 click。因此拖拽绑定到歌词内容区，
      // 按钮所在的工具条是它的兄弟节点，不受影响。
      const bindDrag = () => {
        if (settings.value.locked) return;
        if (disposeDrag || !contentEl.value || !ctx.window.drag?.bind) return;
        try {
          disposeDrag = ctx.window.drag.bind(contentEl.value);
        } catch (error) {
          console.warn("[desktop-lyric-styler] 绑定拖动失败", error);
        }
      };

      const unbindDrag = () => {
        disposeDrag?.();
        disposeDrag = null;
      };

      // 歌词区与空状态是两个不同元素，切换时需重新绑定拖拽
      const setScrollEl = (el) => {
        scrollEl.value = el;
        contentEl.value = el;
      };
      const setContentEl = (el) => {
        contentEl.value = el;
      };

      // 当前行按逐字单元渲染，已唱到的单元染成高亮色（从左到右覆盖）
      const renderLineText = (line, index) => {
        const plain = String(line?.text || "").trim() || "♪";
        if (index !== activeIndex.value || !settings.value.karaoke) return plain;
        const segments = getLineSegments(line, lines.value[index + 1]);
        if (segments.length === 0) return plain;
        const seek = currentSeekMs.value;
        return segments.map((segment, i) =>
          h(
            "span",
            {
              key: i,
              class: [
                "di-seg",
                seek >= 0 && seek >= segment.start ? "is-sung" : "",
              ],
            },
            segment.text,
          ),
        );
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
        "--karaoke": settings.value.karaokeColor,
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

        bindDrag();

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

      watch(activeIndex, () => {
        lineAnchorAt = Date.now();
        scrollActiveIntoView();
      });
      watch(
        () => settings.value.alwaysOnTop,
        (value) =>
          ctx.window.setAlwaysOnTop(value).catch(() => undefined),
      );
      watch(
        () => settings.value.locked,
        (locked) => {
          if (locked) unbindDrag();
          else bindDrag();
        },
      );
      watch(contentEl, () => {
        unbindDrag();
        bindDrag();
      });
      watch(
        () => settings.value.clickThrough,
        (value) =>
          ctx.window.setIgnoreMouseEvents(Boolean(value)).catch(() => undefined),
      );

      return () => {
        void clock.value;
        const root = h(
          "div",
          {
            class: ["di-root", settings.value.locked ? "is-locked" : ""],
            style: rootStyle.value,
          },
          [
            h("div", { class: "di-toolbar" }, [
              iconButton(
                settings.value.locked ? "窗口已锁定，点击解锁" : "锁定窗口位置",
                settings.value.locked ? "lock" : "unlock",
                () => void toggleLock().catch(() => undefined),
                { active: settings.value.locked },
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
                  { class: "di-scroll", ref: setScrollEl },
                  lines.value.map((line, index) =>
                    h("div", { key: index }, [
                      h("p", { class: lineClass(index) }, renderLineText(line, index)),
                      translationFor(line)
                        ? h("p", { class: "di-translation" }, translationFor(line))
                        : null,
                    ]),
                  ),
                )
              : h("div", { class: "di-empty", ref: setContentEl }, [
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

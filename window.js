const STORAGE_KEY = "settings";
const CHANNEL_NAME = "echo-plugin:desktop-lyric-styler:settings";
const LYRIC_LOOKAHEAD_MS = 90;
const SETTINGS_POLL_MS = 500;

const DEFAULT_SETTINGS = {
  enabled: true,
  autoOpen: true,
  alwaysOnTop: true,
  // 布局：echo = 宿主桌面歌词风格（当前行 + 一行副歌词）；scroll = 整段歌词滚动列表
  layoutMode: "echo",
  fontFamily: "",
  fontSize: 40,
  playedColor: "#31cfa1",
  unplayedColor: "#7a7a7a",
  showTranslation: true,
  showNextLinePreview: true,
  align: "both",
  boldCurrent: false,
  lineHeight: 1.24,
  backgroundOpacity: 0,
  backgroundBlur: 0,
  clickThrough: false,
  locked: false,
  karaoke: true,
  karaokeColor: "#31cfa1",
};

const LAYOUT_MODES = ["echo", "scroll"];
const ALIGNS = ["center", "left", "right", "both"];

// 宿主 DesktopLyricView.vue 的排版常量，用于 echo 布局
const ECHO_LINE_HEIGHT = 1.24;
const ECHO_SECONDARY_SCALE = 0.72;
const ECHO_NEXT_SCALE = 0.8;
const ECHO_LINE_PADDING = 4;

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
    layoutMode: LAYOUT_MODES.includes(source.layoutMode)
      ? source.layoutMode
      : DEFAULT_SETTINGS.layoutMode,
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
    showNextLinePreview:
      source.showNextLinePreview ?? DEFAULT_SETTINGS.showNextLinePreview,
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

// 一行的结束时间：优先取下一行起点（自然给出本行时长），
// 其次取最后一个逐字单元的 endTime，最后兜底 +2s。
const getLineEndMs = (line, nextLine) => {
  const nextStart = nextLine ? getLineStartMs(nextLine) : -1;
  if (Number.isFinite(nextStart) && nextStart > 0) return nextStart;

  const characters = Array.isArray(line?.characters) ? line.characters : null;
  const lastEnd =
    characters && characters.length > 0
      ? Number(characters[characters.length - 1]?.endTime)
      : Number.NaN;
  if (Number.isFinite(lastEnd) && lastEnd > 0) return lastEnd;

  return getLineStartMs(line) + 2000;
};

// 补齐每个单元的结束时间：缺失时顺延到下一单元起点，最后一段用行结束时间
const fillSegmentEnds = (segments, lineEnd) => {
  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i];
    if (!(Number.isFinite(current.end) && current.end > current.start)) {
      const nextStart = segments[i + 1]?.start;
      current.end =
        Number.isFinite(nextStart) && nextStart > current.start
          ? nextStart
          : lineEnd;
    }
    if (!(current.end > current.start)) current.end = current.start + 200;
  }
  return segments;
};

// 逐字单元：优先使用歌词自带的 characters（含 text / startTime / endTime，毫秒，
// 与宿主桌面歌词同源），仅在能完整还原该行文本时才采用；否则按文本兜底切分：
// 含空格按词分、无空格按字分（中文逐字），时间按片段长度加权均分。
// 每个单元都带 start / end，供平滑填充逐帧计算进度。
const getLineSegments = (line, nextLine) => {
  const plain = String(line?.text || "").trim();
  const lineEnd = getLineEndMs(line, nextLine);
  const characters = Array.isArray(line?.characters) ? line.characters : null;

  if (characters && characters.length > 0) {
    const items = characters
      .map((item) => ({
        text: String(item?.text ?? ""),
        start: Number(item?.startTime),
        end: Number(item?.endTime),
      }))
      .filter((item) => item.text.length > 0);
    const joined = items
      .map((item) => item.text)
      .join("")
      .replace(/\s/g, "");
    const matchesLine =
      joined.length > 0 && joined === plain.replace(/\s/g, "");
    const hasTiming = items.every(
      (item) => Number.isFinite(item.start) && item.start >= 0,
    );
    if (matchesLine && hasTiming) return fillSegmentEnds(items, lineEnd);
  }

  if (!plain) return [];
  const parts = /\s/.test(plain)
    ? plain.split(/(\s+)/).filter((part) => part.length > 0)
    : Array.from(plain);
  if (parts.length === 0) return [];

  const lineStart = getLineStartMs(line);
  const durationMs =
    lineEnd > lineStart ? lineEnd - lineStart : Math.max(1200, parts.length * 260);
  const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;

  let acc = 0;
  return parts.map((part) => {
    const start = lineStart + (durationMs * acc) / total;
    acc += part.length;
    const end = lineStart + (durationMs * acc) / total;
    return { text: part, start, end: end > start ? end : start + 120 };
  });
};

// 单元填充进度 0→1（与宿主 useLyricTimeline 的 computeLyricCharProgress 一致）
const computeCharProgress = (start, end, timelineMs) => {
  if (timelineMs >= end) return 1;
  if (timelineMs <= start) return 0;
  const duration = end - start;
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, (timelineMs - start) / duration));
};

// background-position-x：100% = 全未唱，0% = 全唱过。
// 配合 200% 宽的「已唱色 50% / 未唱色 50%」渐变 + background-clip: text，
// 位置从 100% 走到 0% 即形成从左到右的平滑覆盖（宿主桌面歌词同款做法）。
const charBackgroundPosition = (start, end, timelineMs) =>
  `${100 - computeCharProgress(start, end, timelineMs) * 100}%`;

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
  const {
    computed,
    createApp,
    h,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
  } = ctx.vue;

  const App = {
    name: "DesktopLyricStylerWindow",
    setup() {
      const snapshot = ref(null);
      const settings = ref(normalizeSettings(DEFAULT_SETTINGS));
      const scrollEl = ref(null);
      const contentEl = ref(null);
      // 当前行用 ref 承载：只有行号真正变化时才触发重渲染，
      // 逐字填充则由 rAF 直接改 background-position，不再每帧重绘整段歌词。
      const activeIndex = ref(-1);
      let disposeSnapshot = null;
      let disposeDrag = null;
      let settingsTimer = 0;
      let scrollFrame = 0;
      let fillFrame = 0;
      let channel = null;
      let applyingRemote = false;
      // 当前行逐字单元的 DOM 与时间区间，用于每帧更新填充位置
      let charEls = [];
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

      // 当前播放进度（毫秒）。与渲染解耦的普通函数，便于 rAF 里每帧读取：
      // 优先用播放快照推算；不可用时退化为「当前行开始 + 墙钟经过」，保证填充始终推进。
      const readSeekMs = () => {
        const seek = getLyricSeekMs(snapshot.value);
        if (seek >= 0) return seek;
        const line = lines.value[activeIndex.value];
        if (!line) return -1;
        return getLineStartMs(line) + (Date.now() - lineAnchorAt);
      };
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

      const isEchoLayout = computed(() => settings.value.layoutMode === "echo");

      // ── echo 布局（宿主桌面歌词风格）─────────────────────────────
      // 字号比例：当前行 1em、翻译行 0.72em、下一行 0.8em（与宿主一致）
      const echoLineScale = (role) => {
        if (role === "secondary") return ECHO_SECONDARY_SCALE;
        if (role === "next") return ECHO_NEXT_SCALE;
        return 1;
      };

      const echoLineHeight = (role) =>
        settings.value.fontSize * echoLineScale(role) * ECHO_LINE_HEIGHT +
        ECHO_LINE_PADDING * 2;

      // 行间距：宿主为 clamp(round(fontSize * 0.1), 3, 8)
      const echoLineGap = () =>
        Math.min(8, Math.max(3, Math.round(settings.value.fontSize * 0.1)));

      // 只显示「当前行 + 一行副歌词」：有翻译优先显示翻译，否则显示下一行
      const echoSlots = computed(() => {
        if (!isEchoLayout.value) return [];
        const all = lines.value;
        const index = activeIndex.value;
        const current = all[index];
        if (!current) {
          return [
            {
              key: "placeholder",
              role: "placeholder",
              index: 0,
              text: trackTitle.value,
            },
          ];
        }
        const slots = [{ key: `l${index}`, role: "primary", index, line: current }];
        const translation = settings.value.showTranslation
          ? String(current.translated || current.romanized || "").trim()
          : "";
        if (translation) {
          slots.push({
            key: `s${index}`,
            role: "secondary",
            index,
            text: translation,
          });
          return slots;
        }
        if (settings.value.showNextLinePreview) {
          const next = all[index + 1];
          if (next) {
            slots.push({
              key: `l${index + 1}`,
              role: "next",
              index: index + 1,
              line: next,
            });
          }
        }
        return slots;
      });

      const echoStackHeight = computed(() => {
        const slots = echoSlots.value;
        if (slots.length === 0) return 0;
        const total = slots.reduce((sum, slot) => sum + echoLineHeight(slot.role), 0);
        return total + echoLineGap() * (slots.length - 1);
      });

      // 按行块高度自上而下堆叠（宿主 getLineTop 的做法）
      const echoLineTop = (slotIndex, slots) => {
        let top = 0;
        for (let i = 0; i < slotIndex; i += 1) {
          top += echoLineHeight(slots[i].role) + echoLineGap();
        }
        return `${Math.round(top)}px`;
      };

      // both = 按歌词行号奇偶左右交错（宿主默认对齐方式）
      const echoAlignClass = (slot) => {
        if (settings.value.align !== "both") return "";
        if (slot.role === "placeholder") return "";
        return slot.index % 2 === 0 ? "align-left" : "align-right";
      };

      const echoFontSize = (role) =>
        `${Math.round(settings.value.fontSize * echoLineScale(role))}px`;

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
          // 用 is-active 定位当前行（is-current 依赖「加粗当前行」设置，可能不存在）
          const current = container.querySelector(".di-line.is-active");
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

      // 收集当前行的逐字单元（只有当前行会拆成 .di-char），供每帧直接更新填充位置
      const collectCharEls = () => {
        charEls = [];
        const container = contentEl.value;
        if (!container || !settings.value.karaoke) return;
        const nodes = container.querySelectorAll(".di-char");
        nodes.forEach((el) => {
          charEls.push({
            el,
            start: Number(el.dataset.start) || 0,
            end: Number(el.dataset.end) || 0,
          });
        });
      };

      // 每帧按进度更新 background-position-x（100% 未唱 → 0% 唱过）
      const updateCharFill = () => {
        if (charEls.length === 0) return;
        const seek = readSeekMs();
        if (!(seek >= 0)) return;
        for (let i = 0; i < charEls.length; i += 1) {
          const item = charEls[i];
          item.el.style.backgroundPositionX = charBackgroundPosition(
            item.start,
            item.end,
            seek,
          );
        }
      };

      // rAF 主循环：行号变化才触发重渲染；填充位置每帧直接改样式
      const tick = () => {
        fillFrame = window.requestAnimationFrame(tick);
        const nextIndex = getActiveLineIndex(snapshot.value);
        if (nextIndex !== activeIndex.value) activeIndex.value = nextIndex;
        updateCharFill();
      };

      // 当前行拆成逐字单元，用渐变 + background-clip: text 做从左到右的平滑填充
      // （与宿主桌面歌词同款：200% 渐变的 background-position-x 从 100% 走到 0%）
      const renderLineText = (line, index) => {
        const plain = String(line?.text || "").trim() || "♪";
        if (index !== activeIndex.value || !settings.value.karaoke) return plain;
        const segments = getLineSegments(line, lines.value[index + 1]);
        if (segments.length === 0) return plain;
        return segments.map((segment, i) =>
          h(
            "span",
            {
              key: i,
              class: "di-char",
              "data-start": String(segment.start),
              "data-end": String(segment.end),
              style: {
                // 未唱部分用未播放色、唱过部分用高亮色（宿主即 playedColor / unplayedColor）
                backgroundImage:
                  "linear-gradient(to right, var(--karaoke) 50%, var(--unplayed) 50%)",
                backgroundSize: "200% 100%",
                backgroundRepeat: "no-repeat",
                backgroundPositionX: "100%",
              },
            },
            segment.text,
          ),
        );
      };

      // echo 布局每行的内容：当前行做逐字填充，其余直接输出文本
      const renderEchoContent = (slot) => {
        if (slot.role === "primary") return renderLineText(slot.line, slot.index);
        return String(slot.text ?? slot.line?.text ?? "").trim() || "♪";
      };

      const lineClass = (index) => {
        const classes = ["di-line"];
        if (index <= activeIndex.value) classes.push("is-played");
        if (index === activeIndex.value) {
          // is-active 恒加：作为定位当前行的稳定标记（不受加粗设置影响）
          classes.push("is-active");
          if (settings.value.boldCurrent) classes.push("is-current");
        }
        if (settings.value.align === "both") {
          classes.push(index % 2 === 0 ? "align-left" : "align-right");
        }
        return classes;
      };

      const rootStyle = computed(() => ({
        "--played": settings.value.playedColor,
        "--unplayed": settings.value.unplayedColor,
        "--karaoke": settings.value.karaokeColor,
        "--font-size": `${settings.value.fontSize}px`,
        "--line-height": String(settings.value.lineHeight),
        "--align":
          settings.value.align === "both" ? "center" : settings.value.align,
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

        // 启动 rAF 主循环（行号检测 + 逐字填充），替代原来的定时器 tick
        fillFrame = window.requestAnimationFrame(tick);
        await nextTick();
        collectCharEls();

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
        if (fillFrame) window.cancelAnimationFrame(fillFrame);
        if (settingsTimer) window.clearInterval(settingsTimer);
        if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
        channel?.close();
      });

      watch(activeIndex, () => {
        lineAnchorAt = Date.now();
        scrollActiveIntoView();
        void nextTick(collectCharEls);
      });
      // 开关或歌词内容变化会重建逐字元素，需重新收集
      watch(
        () => settings.value.karaoke,
        () => void nextTick(collectCharEls),
      );
      watch(lines, () => void nextTick(collectCharEls));
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
        const echo = isEchoLayout.value;
        const slots = echo ? echoSlots.value : [];
        const alignClass = `di-align-${settings.value.align}`;

        const body = !hasLyric.value
          ? h("div", { class: ["di-empty", alignClass], ref: setContentEl }, [
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
            ])
          : echo
            ? // 宿主风格：当前行 + 一行副歌词，绝对定位堆叠，切行时由 CSS 过渡滑动
              h(
                "div",
                { class: ["di-echo", alignClass], ref: setContentEl },
                [
                  h(
                    "div",
                    {
                      class: "di-echo-stack",
                      style: {
                        height: `${Math.round(echoStackHeight.value)}px`,
                      },
                    },
                    slots.map((slot, i) =>
                      h(
                        "div",
                        {
                          key: slot.key,
                          class: [
                            "di-echo-line",
                            `is-${slot.role}`,
                            echoAlignClass(slot),
                          ],
                          style: {
                            top: echoLineTop(i, slots),
                            fontSize: echoFontSize(slot.role),
                            fontWeight:
                              settings.value.boldCurrent &&
                              slot.role === "primary"
                                ? 700
                                : 400,
                          },
                        },
                        renderEchoContent(slot),
                      ),
                    ),
                  ),
                ],
              )
            : h(
                "div",
                { class: ["di-scroll", alignClass], ref: setScrollEl },
                lines.value.map((line, index) =>
                  h("div", { key: index }, [
                    h("p", { class: lineClass(index) }, renderLineText(line, index)),
                    translationFor(line)
                      ? h("p", { class: "di-translation" }, translationFor(line))
                      : null,
                  ]),
                ),
              );

        const root = h(
          "div",
          {
            class: [
              "di-root",
              echo ? "is-echo" : "is-scroll",
              settings.value.locked ? "is-locked" : "",
            ],
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
            body,
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

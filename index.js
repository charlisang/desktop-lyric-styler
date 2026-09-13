const WINDOW_ID = "lyric";
const STORAGE_KEY = "settings";
const CHANNEL_NAME = "echo-plugin:desktop-lyric-styler:settings";

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

const LAYOUT_MODES = [
  { label: "EchoMusic 风格（当前行 + 下一行）", value: "echo" },
  { label: "整段歌词滚动列表", value: "scroll" },
];

const ALIGNS = [
  { label: "居中", value: "center" },
  { label: "居左", value: "left" },
  { label: "居右", value: "right" },
  { label: "左右交错（EchoMusic 默认）", value: "both" },
];

const FONT_SIZES = [12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];

const FONT_SIZE_OPTIONS = FONT_SIZES.map((size) => ({
  label: `${size} px`,
  value: size,
}));

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const normalizeSettings = (value) => {
  const source = value && typeof value === "object" ? value : {};
  const align = ALIGNS.some((item) => item.value === source.align)
    ? source.align
    : DEFAULT_SETTINGS.align;

  return {
    ...DEFAULT_SETTINGS,
    ...source,
    enabled: source.enabled ?? DEFAULT_SETTINGS.enabled,
    autoOpen: source.autoOpen ?? DEFAULT_SETTINGS.autoOpen,
    alwaysOnTop: source.alwaysOnTop ?? DEFAULT_SETTINGS.alwaysOnTop,
    layoutMode: LAYOUT_MODES.some((item) => item.value === source.layoutMode)
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

let state = null;
let settingsDispose = null;
let settingsStyleDispose = null;
let channel = null;
let applyingRemoteSettings = false;

const broadcastSettings = () => {
  if (!channel || applyingRemoteSettings || !state) return;
  try {
    channel.postMessage({
      type: "settings",
      settings: normalizeSettings({ ...state.settings }),
    });
  } catch (error) {
    console.warn("[desktop-lyric-styler] 设置同步失败", error);
  }
};

const showLyric = async (ctx, settings = state?.settings) => {
  const next = normalizeSettings(settings);
  if (!next.enabled) return;
  await ctx.windows
    .show(WINDOW_ID, { alwaysOnTop: next.alwaysOnTop })
    .catch((error) => {
      console.warn("[desktop-lyric-styler] 打开浮窗失败", error);
    });
};

const saveSettings = async (ctx, values, options = {}) => {
  const next = normalizeSettings(values);
  if (!state) return next;
  state.settings = next;
  await ctx.storage.set(STORAGE_KEY, next).catch(() => undefined);
  if (options.syncWindow !== false) {
    await showLyric(ctx, next).catch(() => undefined);
  }
  if (options.broadcast !== false) broadcastSettings();
  return next;
};

const setupSettingsChannel = (ctx) => {
  if (typeof BroadcastChannel !== "function") return;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => {
    const payload = event.data;
    if (!payload || payload.type !== "settings") return;
    applyingRemoteSettings = true;
    void saveSettings(ctx, payload.settings, {
      broadcast: false,
      syncWindow: true,
    }).finally(() => {
      applyingRemoteSettings = false;
    });
  };
};

const SETTINGS_CSS = `
.dls-settings {
  display: grid;
  gap: 14px;
  color: var(--color-text-main, #f8fafc);
}
.dls-preview,
.dls-panel {
  display: grid;
  gap: 12px;
  border: 1px solid color-mix(in srgb, var(--color-text-main, #f8fafc) 12%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-elevated-base, #111827) 72%, transparent);
  padding: 14px;
}
.dls-preview {
  display: grid;
  gap: 6px;
  text-align: center;
  backdrop-filter: blur(14px);
}
.dls-preview-title {
  font-size: 1.15em;
  font-weight: 700;
  color: var(--dls-played, #fff);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.58);
}
.dls-preview-unplayed {
  font-size: 0.82em;
  color: var(--dls-unplayed, #8a8a8a);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.58);
}
.dls-panel h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
}
.dls-row,
.dls-field {
  display: grid;
  gap: 8px;
}
.dls-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
}
.dls-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.dls-copy span,
.dls-field > span {
  font-size: 13px;
  font-weight: 600;
}
.dls-copy small,
.dls-hint {
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  font-size: 12px;
  line-height: 1.45;
}
.dls-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.dls-color {
  width: 42px;
  height: 28px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.dls-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
@media (max-width: 640px) {
  .dls-grid {
    grid-template-columns: 1fr;
  }
}
`;

const createSettingsComponent = (ctx) =>
  ctx.vue.defineComponent({
    name: "DesktopLyricStylerSettings",
    setup() {
      const { computed, defineAsyncComponent, h } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Select = defineAsyncComponent(ctx.ui.components.Select);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);

      const settings = computed(() => normalizeSettings(state?.settings));
      const fontOptions = computed(() => {
        try {
          const options = ctx.fonts.getOptions({ includeFollow: true }) || [];
          return options.map((item) => ({
            label: item.label,
            value: item.value,
          }));
        } catch {
          return [{ label: "跟随系统", value: "" }];
        }
      });

      const fontSizeOptions = computed(() => {
        const current = clamp(
          Number(settings.value.fontSize) || DEFAULT_SETTINGS.fontSize,
          12,
          72,
        );
        if (FONT_SIZE_OPTIONS.some((item) => item.value === current)) {
          return FONT_SIZE_OPTIONS;
        }
        return [
          ...FONT_SIZE_OPTIONS,
          { label: `${current} px（自定义）`, value: current },
        ].sort((a, b) => a.value - b.value);
      });

      const patch = (value) => {
        void saveSettings(ctx, { ...settings.value, ...value }).catch(
          (error) => {
            const message =
              error instanceof Error ? error.message : "桌面歌词设置保存失败";
            ctx.toast.warning(message);
          },
        );
      };

      const row = (label, key, hint = "") =>
        h("div", { class: "dls-row" }, [
          h("div", { class: "dls-copy" }, [
            h("span", label),
            hint ? h("small", hint) : null,
          ]),
          h(Switch, {
            modelValue: Boolean(settings.value[key]),
            "onUpdate:modelValue": (value) => patch({ [key]: Boolean(value) }),
          }),
        ]);

      const field = (label, control) =>
        h("label", { class: "dls-field" }, [h("span", label), control]);

      const select = (key, options) =>
        h(Select, {
          modelValue: settings.value[key],
          options,
          "onUpdate:modelValue": (value) => patch({ [key]: value }),
        });

      const fontSizeSelect = () =>
        h(Select, {
          modelValue: Number(settings.value.fontSize),
          options: fontSizeOptions.value,
          "onUpdate:modelValue": (value) =>
            patch({
              fontSize:
                Number(value) || DEFAULT_SETTINGS.fontSize,
            }),
        });

      const slider = (key, min, max, step, suffix = "") =>
        h(Slider, {
          modelValue: Number(settings.value[key]),
          min,
          max,
          step,
          showValue: true,
          valueSuffix: suffix,
          "onUpdate:modelValue": (value) => patch({ [key]: Number(value) }),
        });

      const color = (key, label) =>
        h("label", { class: "dls-row" }, [
          h("div", { class: "dls-copy" }, [h("span", label)]),
          h("input", {
            class: "dls-color",
            type: "color",
            value: settings.value[key],
            onInput: (event) => patch({ [key]: event.target.value }),
          }),
        ]);

      const panel = (title, children) =>
        h("section", { class: "dls-panel" }, [h("h3", title), ...children]);

      return () =>
        h("div", { class: "dls-settings" }, [
          h("section", { class: "dls-preview" }, {
            style: {
              "--dls-played": settings.value.playedColor,
              "--dls-unplayed": settings.value.unplayedColor,
              fontSize: `${Math.min(28, settings.value.fontSize)}px`,
            },
          }, [
            h("div", { class: "dls-preview-title" }, "当前歌词（已播放色）"),
            h(
              "div",
              { class: "dls-preview-unplayed" },
              settings.value.showTranslation
                ? "译文 / 下一行（未播放色）"
                : "下一行歌词（未播放色）",
            ),
          ]),
          panel("启用", [
            row("启用桌面歌词浮窗", "enabled"),
            row("插件启用时自动打开", "autoOpen"),
            row("窗口始终置顶", "alwaysOnTop", "取消后浮窗可被其他窗口遮挡。"),
            row(
              "鼠标穿透",
              "clickThrough",
              "开启后浮窗不接收鼠标，适合纯展示；此时无法拖动。",
            ),
            row(
              "锁定窗口位置",
              "locked",
              "开启后浮窗无法拖动，避免误操作移位；浮窗按钮也可切换。",
            ),
          ]),
          panel("布局", [
            field(
              "显示方式",
              select("layoutMode", LAYOUT_MODES),
            ),
            h(
              "div",
              { class: "dls-hint" },
              "EchoMusic 风格：只显示当前行（大号）与一行副歌词（小号），与主程序桌面歌词一致；整段列表：居中滚动显示全部歌词。",
            ),
            field("对齐方式", select("align", ALIGNS)),
            field("行距（列表布局）", slider("lineHeight", 1, 3, 0.1)),
          ]),
          panel("文字", [
            field(
              "字体",
              select("fontFamily", [
                { label: "跟随系统", value: "" },
                ...fontOptions.value,
              ]),
            ),
            field("字号", fontSizeSelect()),
            color("playedColor", "已播放歌词颜色"),
            color("unplayedColor", "未播放歌词颜色"),
            row(
              "逐词高亮（卡拉 OK）",
              "karaoke",
              "当前行按字词从左到右平滑填充。",
            ),
            color("karaokeColor", "逐词高亮颜色"),
            row("当前行加粗强调", "boldCurrent"),
          ]),
          panel("翻译", [
            row("显示翻译", "showTranslation", "在歌词下方显示译文（如有）。"),
            row(
              "无翻译时显示下一行",
              "showNextLinePreview",
              "仅 EchoMusic 风格布局生效。",
            ),
          ]),
          panel("外观", [
            field("背景不透明度", slider("backgroundOpacity", 0, 100, 1, "%")),
            field("背景模糊", slider("backgroundBlur", 0, 40, 1, "px")),
          ]),
          h("div", { class: "dls-actions" }, [
            h(
              Button,
              { variant: "primary", size: "xs", onClick: () => showLyric(ctx, settings.value) },
              { default: () => "打开浮窗" },
            ),
            h(
              Button,
              { variant: "outline", size: "xs", onClick: () => ctx.windows.hide(WINDOW_ID) },
              { default: () => "隐藏浮窗" },
            ),
            h(
              Button,
              { variant: "ghost", size: "xs", onClick: () => patch(DEFAULT_SETTINGS) },
              { default: () => "恢复 EchoMusic 默认样式" },
            ),
          ]),
        ]);
    },
  });

const registerSettings = (ctx) => {
  settingsDispose?.();
  settingsDispose = ctx.ui.settings.define({
    title: "桌面歌词浮窗",
    description:
      "复刻主程序桌面歌词样式的浮窗：当前行大号 + 一行副歌词，逐词高亮、颜色与翻译均可调。",
    component: createSettingsComponent(ctx),
  });
};

export async function activate(ctx) {
  state = ctx.vue.reactive({
    settings: normalizeSettings(await ctx.storage.get(STORAGE_KEY)),
  });

  setupSettingsChannel(ctx);
  settingsStyleDispose = ctx.css.inject(SETTINGS_CSS, {
    id: "desktop-lyric-styler-settings",
  });
  registerSettings(ctx);

  ctx.commands.register("show", () => showLyric(ctx), {
    title: "打开桌面歌词浮窗",
  });
  ctx.commands.register("hide", () => ctx.windows.hide(WINDOW_ID), {
    title: "隐藏桌面歌词浮窗",
  });

  if (state.settings.enabled && state.settings.autoOpen) {
    await showLyric(ctx, state.settings).catch((error) => {
      console.warn("[desktop-lyric-styler] 自动打开浮窗失败", error);
    });
  }
}

export async function deactivate(ctx) {
  settingsDispose?.();
  settingsDispose = null;
  settingsStyleDispose?.();
  settingsStyleDispose = null;
  channel?.close();
  channel = null;
  await ctx?.windows?.close?.(WINDOW_ID).catch(() => undefined);
  state = null;
}

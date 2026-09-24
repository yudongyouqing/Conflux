/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /** 品牌文字色：蓝黑，呼应图拓扑画布的 navy 与 banner。
         *  令牌以 rgb 通道三元组存于 CSS 变量（:root），主题可运行时覆盖。 */
        ink: {
          DEFAULT: "rgb(var(--tk-ink) / <alpha-value>)",
          // 次级/弱化文字 = 墨色 alpha 派生（#109）：任何色板自动获得正确层级，
          // 压在 tile 色块上也不塌（PI-Desktop 论证过的对比度策略）
          muted: "rgb(var(--tk-ink) / 0.72)",
          faint: "rgb(var(--tk-ink) / 0.50)",
        },
        /** 画布底 / 卡片面的层级对 */
        paper: "rgb(var(--tk-paper) / <alpha-value>)",
        surface: "rgb(var(--tk-surface) / <alpha-value>)",
        line: {
          DEFAULT: "rgb(var(--tk-line) / <alpha-value>)",
          strong: "rgb(var(--tk-line-strong) / <alpha-value>)",
        },
        /** 行级内嵌色块（#109）：替代"列表项 = 描边卡片"的分层方式。
         *  ink 随主题翻转，浅色=淡墨渍 / 深色=淡白提亮，两端通用 */
        tile: {
          DEFAULT: "rgb(var(--tk-ink) / 0.035)",
          hover: "rgb(var(--tk-ink) / 0.06)",
          active: "rgb(var(--tk-ink) / 0.09)",
        },
        /** 唯一强调色：汇流蓝。状态色（live/busy/ended）不在此列，只表达生命状态 */
        accent: {
          DEFAULT: "rgb(var(--tk-accent) / <alpha-value>)",
          deep: "rgb(var(--tk-accent-deep) / <alpha-value>)",
          soft: "rgb(var(--tk-accent-soft) / <alpha-value>)",
        },
      },
      /** 半步字阶（#109）：10.5 地板给 kbd/微标签，12 起 = 列表正文 */
      fontSize: {
        "2xs": ["11px", { lineHeight: "15px" }],
        "md-plus": ["13.5px", { lineHeight: "19px" }],
        "base-plus": ["15px", { lineHeight: "22px" }],
      },
      fontFamily: {
        sans: [
          '"IBM Plex Sans"',
          '"PingFang SC"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          "system-ui",
          "sans-serif",
        ],
        /** mono 只用于真的终端数据（id/路径/代码/会话名），不做装饰 */
        mono: ['"IBM Plex Mono"', '"Cascadia Mono"', "Consolas", "monospace"],
      },
      /** 阴影只给浮起物：卡片静态无影或极浅，浮层/拖拽/选中才升级 */
      boxShadow: {
        card: "0 1px 2px rgba(24, 34, 52, 0.05)",
        raised: "0 4px 16px rgba(24, 34, 52, 0.10), 0 1px 3px rgba(24, 34, 52, 0.06)",
        overlay: "0 12px 32px rgba(24, 34, 52, 0.18)",
      },
    },
  },
  plugins: [],
};

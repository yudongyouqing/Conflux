/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /** 品牌文字色：蓝黑，呼应图拓扑画布的 navy 与 banner */
        ink: {
          DEFAULT: "#182234",
          muted: "#5C677D",
          faint: "#8B94A7",
        },
        /** 画布底 / 卡片面的层级对 */
        paper: "#F6F7F9",
        line: {
          DEFAULT: "#E4E8EF",
          strong: "#CBD3E0",
        },
        /** 唯一强调色：汇流蓝。状态色（live/busy/ended）不在此列，只表达生命状态 */
        accent: {
          DEFAULT: "#2563EB",
          deep: "#1E4FC4",
          soft: "#EBF1FE",
        },
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

// Every color is a CSS variable (RGB channels) defined in global.css, so the
// light/dark themes swap at runtime and opacity modifiers (`bg-danger/10`) work.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: ["./src/web/index.html", "./src/web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", "16px"],
        xs: ["12px", "16px"],
        sm: ["13px", "20px"],
        base: ["14px", "22px"],
        lg: ["16px", "24px"],
        xl: ["20px", "28px"],
        "2xl": ["24px", "32px"],
      },
      colors: {
        canvas: token("canvas"),
        surface: token("surface"),
        subtle: token("subtle"),
        fg: token("fg"),
        "fg-dim": token("fg-dim"),
        muted: token("muted"),
        line: token("line"),
        "line-strong": token("line-strong"),
        frame: token("frame"),
        ink: token("ink"),
        "ink-fg": token("ink-fg"),
        primary: token("primary"),
        "primary-fg": token("primary-fg"),
        brand: token("brand"),
        "brand-fg": token("brand-fg"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
        "danger-solid": token("danger-solid"),
        info: token("info"),
        ring: token("ring"),
      },
      borderColor: {
        DEFAULT: token("line"),
      },
      ringColor: {
        DEFAULT: token("ring"),
      },
      ringOffsetColor: {
        DEFAULT: token("surface"),
      },
      borderRadius: {
        sm: "2px",
        DEFAULT: "3px",
        md: "3px",
        lg: "4px",
        xl: "4px",
        "2xl": "4px",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        pop: "var(--shadow-pop)",
      },
      animation: {
        "fade-in": "fadeIn 0.15s ease-out",
        "slide-up": "slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        "pop-in": "popIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        popIn: { "0%": { opacity: "0", transform: "translateY(-4px) scale(0.985)" }, "100%": { opacity: "1", transform: "translateY(0) scale(1)" } },
      },
    },
  },
  plugins: [],
};

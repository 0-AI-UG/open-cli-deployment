module.exports = {
  content: ["./src/web/index.html", "./src/web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["Geist Mono Variable", "monospace"],
        sans: ["Geist Mono Variable", "monospace"],
      },
      colors: {
        bg: "#FFFDF5", "bg-raised": "#FFFFFF", alt: "#F0EBE1",
        fg: "#1A1A1A", "fg-dim": "#4A4A4A", muted: "#8A8A8A",
        accent: "#BAFF39", "accent-h": "#A8E830",
        "accent-blue": "#5B8DEF", "accent-red": "#FF4444",
        "accent-amber": "#FFB800", "accent-green": "#BAFF39",
      },
      boxShadow: {
        neo: "4px 4px 0 #1A1A1A", "neo-sm": "2px 2px 0 #1A1A1A",
        "neo-lg": "5px 5px 0 #1A1A1A", "neo-none": "0 0 0 #1A1A1A",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out", "slide-up": "slideUp 0.4s ease-out",
        "pulse-slow": "pulse 3s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
    },
  },
  plugins: [],
};

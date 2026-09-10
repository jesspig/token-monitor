const colors = require('tailwindcss/colors')

module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: colors.neutral[950],
          card: colors.neutral[900],
          raised: colors.neutral[800]
        },
        line: {
          DEFAULT: colors.neutral[800],
          strong: colors.neutral[700]
        },
        content: {
          DEFAULT: colors.neutral[100],
          secondary: colors.neutral[300],
          muted: colors.neutral[500]
        },
        success: {
          DEFAULT: colors.emerald[400],
          bright: colors.emerald[500]
        },
        warning: {
          DEFAULT: colors.amber[400],
          bright: colors.amber[500]
        },
        danger: {
          DEFAULT: colors.red[400],
          bright: colors.red[500]
        },
        info: {
          DEFAULT: colors.sky[400],
          bright: colors.sky[500]
        }
      }
    }
  },
  plugins: []
}

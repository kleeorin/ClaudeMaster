/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
    './src/renderer/index.html',
  ],
  theme: {
    extend: {
      animation: {
        blink: 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
      colors: {
        ctp: {
          base:     '#1e1e2e',
          mantle:   '#181825',
          crust:    '#11111b',
          text:     '#cdd6f4',
          subtext:  '#a6adc8',
          overlay:  '#6c7086',
          surface0: '#313244',
          surface1: '#45475a',
          green:    '#a6e3a1',
          yellow:   '#f9e2af',
          red:      '#f38ba8',
          blue:     '#89b4fa',
          mauve:    '#cba6f7',
        },
      },
    },
  },
  plugins: [],
}

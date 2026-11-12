/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
        display: ['var(--font-display)'],
      },
    },
  },
  plugins: [],
};

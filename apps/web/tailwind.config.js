import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'var(--ui-border)',
        input: 'var(--ui-border-strong)',
        ring: 'var(--ui-focus-ring)',
        background: 'var(--ui-background)',
        foreground: 'var(--ui-text)',
        primary: { DEFAULT: 'var(--ui-primary)', foreground: '#ffffff' },
        secondary: { DEFAULT: 'var(--ui-surface-subtle)', foreground: 'var(--ui-text)' },
        destructive: { DEFAULT: 'var(--ui-status-danger)', foreground: '#ffffff' },
        muted: { DEFAULT: 'var(--ui-surface-subtle)', foreground: 'var(--ui-text-muted)' },
        accent: { DEFAULT: 'var(--ui-primary-soft)', foreground: 'var(--ui-text)' },
        popover: { DEFAULT: 'var(--ui-surface)', foreground: 'var(--ui-text)' },
        card: { DEFAULT: 'var(--ui-surface)', foreground: 'var(--ui-text)' },
      },
      borderRadius: { lg: 'var(--ui-radius-surface)', md: 'var(--ui-radius-control)', sm: '6px' },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      boxShadow: {
        panel: '0 18px 45px rgba(15, 23, 42, 0.08)',
      },
    },
  },
  plugins: [animate],
};

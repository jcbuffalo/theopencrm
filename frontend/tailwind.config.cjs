/** @type {import('tailwindcss').Config} */
const colors = require('tailwindcss/colors');

// The brand-blue ramp. Exposed twice: as `primary-*` (legacy alias, keep
// working) and as `info-*` (the semantic name new code should reach for).
const BRAND_RAMP = {
  50:  '#EFF6FF',
  100: '#DBEAFE',
  200: '#BFDBFE',
  300: '#93C5FD',
  400: '#60A5FA',
  500: '#2076CD',
  600: '#1B5FAD',
  700: '#15497F',
  800: '#0F3865',
  900: '#0A2647',
};

module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // The Open CRM brand colors
        brand: {
          blue: '#2076CD',
          'blue-dark': '#1B5FAD',
          'blue-darker': '#15497F',
          mint: '#80CE99',
          // mint-dark used to be #5DB97D; failed WCAG 1.4.3 AA on small text
          // against bg-brand-blue/10 backgrounds (~3.4:1, needed 4.5:1).
          // #1F6B3D measures ~5.7:1 on the same translucent panel and reads
          // as a richer accent forest-green in branded contexts.
          'mint-dark': '#1F6B3D',
          ink: '#0F172A',
        },
        // Aliases so existing `primary-*` usages keep working but pick up the brand palette
        primary: BRAND_RAMP,
        accent: {
          50:  '#F0FDF4',
          100: '#DCFCE7',
          200: '#BBF7D0',
          300: '#80CE99',
          400: '#5DB97D',
          500: '#3F9F62',
          600: '#2E8650',
          700: '#1F6B3D',
        },
        // Semantic aliases (design system, Aug 2026 — see DESIGN_SYSTEM.md).
        // New code should say `text-success-700` / `bg-warning-50` rather than
        // picking between emerald/green or amber/yellow per call site. Each
        // maps to ONE Tailwind ramp so a palette change is a one-line edit.
        success: colors.emerald,
        warning: colors.amber,
        danger:  colors.red,
        info:    BRAND_RAMP,
      },
      borderRadius: {
        // One radius for controls, cards, and pills-that-aren't-round. Makes
        // bare `rounded` equal `rounded-lg` (8px) so the historical split
        // between the two collapses without a mass rename. `rounded-md`
        // (6px) stays for dense/small controls; `rounded-full` for pills.
        DEFAULT: '0.5rem',
      },
      boxShadow: {
        // Resting surface (cards, tables, filter bars) — soft, low-contrast.
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        // Floating surface (modals, drawers, menus, popovers).
        overlay: '0 24px 48px -12px rgb(15 23 42 / 0.25), 0 8px 16px -8px rgb(15 23 42 / 0.10)',
      },
    },
  },
  plugins: [],
};

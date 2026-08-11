/**
 * Tailwind v4 runs as a single PostCSS plugin — no tailwind.config.js, no
 * autoprefixer (v4 handles vendor prefixing itself). The theme and the layers
 * live in src/app/globals.css.
 */
export default {
  plugins: ['@tailwindcss/postcss'],
};

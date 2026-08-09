/**
 * The chart palette, in one place.
 *
 * ECharts paints to a canvas and cannot read the CSS custom properties the rest
 * of the console uses, so the hues are duplicated here as plain hex. Kept in
 * step with the `--c-*` tokens in `globals.css` by hand — five colours that
 * change roughly never. Importable from Server Components too, so a legend
 * swatch rendered in HTML matches the slice ECharts draws.
 */
export const PALETTE = {
  blue: '#4e8cf5',
  green: '#35c28e',
  amber: '#f5b74e',
  red: '#f2685f',
  purple: '#6d5ef8',
} as const;

/** The order slices and series cycle through when a colour is not named. */
export const WHEEL = [
  PALETTE.purple,
  PALETTE.blue,
  PALETTE.green,
  PALETTE.amber,
  PALETTE.red,
  '#9b83ff',
  '#f39bd0',
  '#5fd0c4',
] as const;

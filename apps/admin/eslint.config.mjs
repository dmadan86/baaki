import next from 'eslint-config-next';

export default [
  ...next,
  // eslint-plugin-react (pulled in transitively by eslint-config-next) auto-detects
  // the installed React version by calling context.getFilename(), which ESLint 10
  // removed — that path throws before any rule runs. Pinning the version here skips
  // detection entirely. Keep in sync with the `react` dependency in package.json.
  { settings: { react: { version: '19.2' } } },
  { ignores: ['.next/**', 'out/**', 'next-env.d.ts'] },
];

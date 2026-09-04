import next from 'eslint-config-next';

export default [
  ...next,
  // Same pin as apps/web: eslint-plugin-react's React-version auto-detection
  // calls an ESLint 10 removal and throws before any rule runs. Keep in sync
  // with the `react` dependency in package.json.
  { settings: { react: { version: '19.2' } } },
  { ignores: ['.next/**', 'out/**', 'next-env.d.ts'] },
];

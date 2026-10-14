module.exports = {
  forbidden: [
    {
      name: 'no-modules-to-apps',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-platform-to-apps',
      severity: 'error',
      from: { path: '^platform/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-cross-app-imports',
      severity: 'error',
      // Only the worker composition root may consume the API's explicitly exported
      // notification-drain facade. The companion rule below keeps that exception exact.
      from: { path: '^apps/([^/]+)/', pathNot: '^apps/worker/src/composition-root\\.ts$' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'worker-api-facade-only',
      severity: 'error',
      from: { path: '^apps/worker/src/composition-root\\.ts$' },
      to: {
        path: '^apps/([^/]+)/',
        pathNot: '^apps/worker/|^apps/api/(src|dist)/worker\\.(ts|js|d\\.ts)$',
      },
    },
    {
      name: 'no-packages-to-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    exclude: { path: '(^|/)(dist|node_modules)/' },
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'] },
  },
};

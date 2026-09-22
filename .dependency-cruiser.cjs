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
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
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

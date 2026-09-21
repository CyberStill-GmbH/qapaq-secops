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
      from: { path: '^apps/([^/]+)/', pathNot: '^apps/([^/]+)/test/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'] },
  },
};

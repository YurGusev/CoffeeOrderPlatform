// AST import authority for Dependency Cruiser 18.2.0. The package/lock pin is owned by issue #3.
const runtimes = [
  'edge-gateway', 'api-public', 'api-internal', 'web', 'customer-service',
  'catalog-service', 'catalog-supplier-sync', 'catalog-activation-worker',
  'pricing-service', 'orders-service', 'orders-aroma-preparation',
  'aroma-observer', 'aroma-convergence', 'aroma-gateway', 'realtime-gateway',
];

const crossRuntimeRules = runtimes.flatMap((source) =>
  runtimes
    .filter((target) => target !== source)
    .map((target) => ({
      name: `BOUND-IMPORT:${source}->${target}`,
      severity: 'error',
      comment: 'Runtime source roots never import another runtime implementation.',
      from: { path: `^apps/${source}/` },
      to: { path: `^apps/${target}/` },
    })),
);

module.exports = {
  forbidden: [
    ...crossRuntimeRules,
    {
      name: 'BOUND-IMPORT:shared-business-package',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { path: '^packages/(domain|models|shared-business)(/|$)' },
    },
    {
      name: 'BOUND-IMPORT:frontend-server-boundary',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^(apps/(?!web/)|.*(sql|migrations|provider-client))' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    preserveSymlinks: false,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['types', 'import', 'default'] },
  },
};

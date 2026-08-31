# Repository security gates

Release/migration CI блокирует:

- tracked `.env.agent`/real secret env;
- vendored virtualenv/site-packages/node_modules;
- hard-coded bootstrap password/token;
- secret-like values outside allowlisted synthetic fixtures;
- oversized unexpected blobs;
- new local PDF path as business contract;
- new public `xmin` wire fields;
- new cross-owner database client;
- resurrection of legacy direct Draft→AROMA endpoint.

History sanitation — отдельный admin operation after credential rotation; current-tree PASS не доказывает чистую history.

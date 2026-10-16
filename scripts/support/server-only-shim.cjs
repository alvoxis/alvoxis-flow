// Operator CLI scripts run outside Next.js, where the `server-only` guard (which protects server
// modules from client bundles) would throw. Scripts are server-side by definition, so the guard
// is satisfied here with an empty module. Never use this from application code.
const resolved = require.resolve("server-only");
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} };

# Dependency patches

Bun 1.4.3 scopes compression 1.8.2 to serve 14.2.6. The latest serve release still pins 1.8.1. The patch fixes response-close stream cleanup in [GHSA-vc2v-76pw-4v95](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95), [upstream change](https://github.com/expressjs/compression/commit/151f63e91e1b64f8fb0b064e19321a4f28db6bff). Remove the override when serve adopts a patched dependency.

Validation covered real static GET and gzip responses from serve, a local HTTP middleware response aborted by its client, and an instrumented close-event fixture that asserts the compression stream is destroyed. Frozen installs passed and bun audit reports no advisories. This static project has no TypeScript, lint, build, or test suite.

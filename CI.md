# CI and Renovate

All development pull requests and default-branch pushes run independent required
quality, unit/registry, browser/security/production smoke, media-tool integration,
and hygiene jobs. `ci / required` requires every job to succeed and rejects missing,
skipped, failed or cancelled jobs. Its dispatch guard binds repair runs to the exact
current PR commit. Renovate updates merge unattended after all seven current-head
checks in `.github/merge-policy.json` pass. For other changes, review the exact
current head/base, full CI results and relevant
artifacts before merging with the maintainer’s ghmerge function. Repository branch protections and
rulesets are intentionally disabled; local prek protections remain in place.

Use Bun 1.4.2 and `bun install --frozen-lockfile`. CI shares `bun run format:check`,
`bun run lint`, `bun run check`, `bun run test:ci`, `bun run test:browser:ci`, and
`bun run test:media-tools:ci` with local development. Installation generates SvelteKit
types so the first unit run resolves aliases from a clean checkout. The foundation
test enforces consistent exact runtime pins and exact core dependency pins without
copying dependency versions into a second inventory that blocks every update.

The default suite retains its explicit directories, including reliability,
performance and static security. The new aggregate browser command builds once,
runs all six existing E2E files plus browser security sequentially, then runs the
production smoke against the same bytes. Existing individual commands still work.
Browser failure evidence in `test-results` is retained for seven days. Tests use
loopback provider fixtures and disposable data, not real Poyo credits or API keys.
The live suite and registry network refresh are excluded from required CI.

The media job uses macOS 15 and Homebrew's ExifTool, ImageMagick and FFmpeg from
`.github/Brewfile`, then requires every tool to meet the application's supported
minimum versions. Missing/outdated tools fail this required job instead of printing
an optional skip. The existing optional local media command retains its readiness
behavior. Homebrew supplies native tools whose supported versions exceed Ubuntu
24.04 system packages; this justified runner variation tests real image/video
sanitization rather than weakening the version requirements.

Shared Bun workflows/gates and external actions use full version tags. Read-only
permissions, lockfile/runtime/runner caches, bounded jobs, source mutation checks,
and cancellation of superseded runs apply consistently. Prek skips duplicate
application hooks only in CI; its local test hook now uses the safe explicit suite.

Renovate uses `edbfi/automation:default`, including official Biome package/schema
handling and grouped non-major updates. The v1.1.0 default and automerge presets
make all dependency update types eligible, including majors and shared-policy
updates, without dashboard approval. Svelte checks remain required to test
TypeScript compatibility. The checked merge preserves genuine sign-offs and
dispatches full CI for the exact merged commit. Biome repair computes without
write privileges, publishes only allowlisted source/config changes, and
explicitly runs full CI for the repaired SHA. Broad formatting changes beyond the
shared limits require manual handling. Actions and shared preset updates arrive as
normal Renovate PRs; full version tags are the agreed reference policy.

Real paid API behavior, live model registry/pricing drift and deployment packaging
remain separate integration/release concerns. Native media tools follow Homebrew
releases rather than a frozen binary image; their behavioral tests and version
readiness check are the gate for changes in those tools.

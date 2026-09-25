# CI and Renovate

All development pull requests and default-branch pushes run independent required
quality, unit/registry, browser/security/production smoke, media-tool
integration, and hygiene jobs. `ci / required` requires every job to succeed and
rejects missing, skipped, failed or cancelled jobs. The separately required
`policy / ci / policy` check validates PR titles, commit sign-offs, reviews and
hold labels using read-only API evidence; after a pass it re-runs the other
event's older failed verdict for the same head, which needs `actions: write`.
Protection must require both checks from GitHub Actions and current branches
before enabling automerging. Local prek protections remain in place.

Use Bun 1.4.2 and `bun install --frozen-lockfile`. CI shares `bun run
format:check`, `bun run lint`, `bun run check`, `bun run test:ci`, `bun run
test:browser:ci`, and `bun run test:media-tools:ci` with local development.
Installation generates SvelteKit types so the first unit run resolves aliases
from a clean checkout. The foundation test enforces consistent exact runtime
pins and exact core dependency pins without copying dependency versions into a
second inventory that blocks every update.

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

Renovate uses the v4 `default.json` and `automerge.json` presets, including
official Biome package/schema handling and grouped non-major updates. Renovate is
the only merger: it arms GitHub auto-merge with rebase merges, so GitHub merges
once every required check passes. Rebase merges preserve signed commits and
require complete current-head CI and policy checks, up-to-date branches, release
ages, reviews and hold labels. Shared automation configuration updates remain
manual. The legacy Actions merger and maintainer command are retired. Svelte
checks and the TypeScript 7 hold remain in place. Biome repair computes without
write privileges and publishes only allowlisted source/config changes with the App
token, which starts the normal `pull_request` CI and policy runs on the repaired
commit; nothing is dispatched. Broad formatting changes beyond the shared limits
require manual handling. Actions and shared preset updates arrive as normal
Renovate PRs; full version tags are the agreed reference policy.

Real paid API behavior, live model registry/pricing drift and deployment packaging
remain separate integration/release concerns. Native media tools follow Homebrew
releases rather than a frozen binary image; their behavioral tests and version
readiness check are the gate for changes in those tools.

The configured Biome App repair workflow remains enabled and uses the released v4
workflow. A repair must receive complete current-head CI and policy checks. If a
workflow-token publication suppresses PR events, the missing policy check blocks
merging until a supported App/Renovate update triggers full validation. Metadata
and review events refresh policy; GitHub review rules provide the independent
server-side review guarantee during event propagation.

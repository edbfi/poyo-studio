# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Poyo Local Studio: a local-first SvelteKit 2 / Svelte 5 (runes) app on Bun with `bun:sqlite`,
driving the Poyo.ai image and video APIs. Single user, loopback-only by design.

## Commands

Bun `1.4.2` is the only runner; `tests/unit/foundation.test.ts` fails under any other
`Bun.version`. Tests and checks resolve `$lib` through `.svelte-kit/tsconfig.json`, which
`bun install` generates (`prepare` runs `svelte-kit sync`).

| Task | Command |
| --- | --- |
| Install | `bun install --frozen-lockfile` |
| Dev / production | `bun run dev` (:5173) · `bun run build && bun run start` (:3000) |
| Typecheck | `bun run check` (svelte-check, then the TS 7 `check:native` pass) |
| Lint / format | `bun run lint` · `bun run format` · `bun run format:check` |
| Default suite | `bun run test` |
| One file | `bun test tests/unit/registry/video-registry.test.ts` |
| One case | `bun test tests/unit/registry/video-registry.test.ts -t "name substring"` |
| Browser e2e / security | `bun run test:e2e` · `bun run test:security` (both build first) |
| Registry evidence | `bun run validate:registry` |
| Full CI parity | `bun run test:ci` · `bun run test:browser:ci` (needs `bunx playwright install chromium`) |

- Use `bun run test`, not bare `bun test`. Bare `bun test` also picks up
  `tests/media-tools/media-sanitizer.host.test.ts`, which has no skip guard and fails without
  ExifTool/ImageMagick/FFmpeg on `PATH`; run it via `bun run test:media-tools`, which skips.
- `*.browser.ts` and `*.live.ts` are outside Bun's test discovery. A single browser file needs
  `build/index.js` and a `./` prefix: `bun run build && bun test --max-concurrency 1 ./tests/e2e/gallery.browser.ts`.
- `bun run test:live` spends real credits; it is gated on `POYO_LIVE_TESTS=1`,
  `POYO_LIVE_APPROVED=YES`, `POYO_API_KEY` and a budget. Run it only when asked; every other
  suite uses loopback mocks.
- `prek.toml` blocks local commits to `main` (`no-commit-to-branch`); commit on a branch. The PR
  policy check requires `Signed-off-by` (`git commit -s`) and a Conventional Commit PR title;
  see `CI.md`.

## Where code goes

- `src/lib/features/**` — browser-safe logic and contracts. Never value-import `$lib/server`
  from here, `.svelte` files or `hooks.client.ts`; use `import type` for server types.
- `src/lib/server/**` — server-only. Shared services come from `getPlatformServices()`
  (`src/lib/server/platform/runtime.ts`: database, settings, apiKey, logger, publicIpv4,
  pricing, mediaTools) and job services from `getJobRuntime()` (`src/lib/server/jobs/runtime.ts`).
  Get them there; don't construct them in routes. These memoized module singletons are the
  sanctioned server state; `event.locals` is unused.
- `src/routes/**` — loads are `+page.server.ts` only (no `+page.ts`/`+layout.ts`). There are no
  form actions; every mutation is a JSON endpoint in `src/routes/api/**/+server.ts`.
- `src/lib/components/ui/` — hand-written primitives over the CSS variables in `src/app.css`
  (mapped to UnoCSS colors in `uno.config.ts`); `bits-ui` only for headless primitives.

## Mutating API routes

- Read the body with `readSameOriginJson` (`src/lib/server/platform/request-security.ts`); it
  enforces Origin, `Sec-Fetch-Site`, JSON content type and size. The one exception,
  `src/routes/api/sources/+server.ts` (multipart), gets the same checks from
  `src/lib/server/media/source-intake.ts`.
- `src/hooks.server.ts` automatically takes a maintenance writer permit for every request that
  is not GET/HEAD/OPTIONS. Work that outlives the response must go through
  `maintenanceGate.trackDetached(label, fn)`, or storage maintenance cannot drain it.

Canonical shape (`src/routes/api/library/[jobId]/favorite/+server.ts`):

```ts
export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{ favorite: boolean }>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    new LibraryRepository(platform.database).setFavorite(params.jobId, body.favorite);
    return Response.json({ favorite: body.favorite });
  } catch (error) {
    return jobHttpError(error);
  }
};
```

| Route area | Error mapper |
| --- | --- |
| jobs, library, account, sources | `jobHttpError` (`src/lib/server/jobs/http.ts`) |
| settings, cleanup, onboarding, public-ipv4 | `operationsHttpError` (`src/lib/server/operations/http.ts`) |

## Invariants enforced by `tests/security/static-architecture.test.ts`

Read that test before adding anything unusual under `src/`. It fails on:

- `export let` or `on:event=` in `.svelte` files; use `$props()` and callback props.
- `Bun.spawn`/`spawnSync`/`which`/`secrets`, `process.platform` or `node:os` in `src/`.
  Run subprocesses with `execFile` and an argument array, as `src/lib/server/media/media-sanitizer.ts` does.
- Host-OS words anywhere in `src/`, comments and UI copy included: `macOS`, `Windows`, `Linux`,
  `Keychain`, `operating-system`, `credential-backend`, `storage-root`, `output-location`,
  `open-native`, `open-folder`. Describe the behaviour without naming a platform.
- Any `tests/` path referenced from `src/`.
- `new PoyoClient(`/`new PoyoTransport(` outside `src/lib/server/poyo/factory.ts` and
  `transport.ts`. Call `createPoyoClient({ ..., publicIpv4Guard: platform.publicIpv4 })`; that
  exact argument text is asserted.
- Dependencies `tailwindcss`, `@sveltejs/adapter-node`, `express`, `ts-node`, `jest`, `vitest`,
  and package scripts calling `npm`/`pnpm`/`yarn`/`node`. `foundation.test.ts` also requires
  exact `x.y.z` devDependency versions.

## Database migrations

Applied migrations are pinned by checksum. Editing a shipped file in `migrations/` breaks existing
databases (`Migration N no longer matches its recorded checksum`). To change the schema:

1. Add `migrations/NNNN-name.ts` exporting a `Migration` (`migrations/types.ts`).
2. Append it to the array in `migrations/index.ts`.
3. Bump `DATABASE_SCHEMA_VERSION` in `src/lib/server/platform/version.ts` (startup throws on mismatch).
4. Update the expected version chain in `tests/integration/database/migrations.test.ts`.

`migrations/0001-initial.ts` is also frozen against a fixture; verify with
`bun scripts/check-pre-collapse-schema-signature.ts`.

## Adding or changing a model (registry)

Worked examples: `git show --stat 1259c8e` (video), `git show --stat 6ef6d0a` (image).

1. Edit `src/lib/features/registry/{image,video}-registry.ts` (plus `normalize*.ts`/`types.ts` for a
   new request shape) and bump `IMAGE_REGISTRY_VERSION`/`VIDEO_REGISTRY_VERSION`.
2. Run `bun run registry:evidence:refresh` (network). It regenerates
   `evidence/official-source-manifest.json` and `evidence/reviewed-*-fixtures*.json`; don't
   hand-edit those. `reviewed-conditional-vectors.json` and `reviewed-conflicts.json` are hand-reviewed.
3. Update the hard-coded inventory counts in `scripts/validate-registry.ts` and
   `tests/unit/registry/source-evidence.test.ts`.
4. Grep `tests/` for the old registry version string and the `poyo-public-pricing-…` version and
   update them, including `tests/fixtures/pricing/{reviewed-inventory,supported-signatures}.json`.
   Read `tests/fixtures/pricing/README.md` before touching that directory.
5. `bun run validate:registry && bun run test`.

## TypeScript

`exactOptionalPropertyTypes` is on: omit optional properties instead of passing `undefined`,
using conditional spreads as `src/lib/server/poyo/factory.ts` does:
`...(options.fetch ? { fetch: options.fetch } : {})`.

## Reference rules

- `.agents/rules/svelte5-sveltekit-app.md` — generic Svelte 5 runes / SvelteKit / Bun reference.
  Read before writing new components. Its runes guidance applies, but where it conflicts with this
  repo, this repo wins: `svelte-adapter-bun` (not adapter-node), `bun test` plus
  `scripts/test-browser.ts` (not Vitest), UnoCSS `presetWind4` with `src/lib/components/ui`
  (no shadcn-svelte or `unocss-preset-shadcn`), `bun run start` (not `bun ./build/index.js`),
  Vite under Bun (`bun --bun vite`), and JSON API routes instead of form actions.

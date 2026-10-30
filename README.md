<p align="center">
  <img src="static/poyo-local-studio-logo.svg" alt="Poyo Local Studio logo" width="192" height="192">
</p>

<h1 align="center">Poyo Local Studio</h1>

<p align="center">
  <strong>A local-first image and video studio for Poyo.ai</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/Bun-1.4.2-000000?logo=bun&logoColor=white" alt="Bun 1.4.2">
  <img src="https://img.shields.io/badge/SvelteKit-3.0-FF3E00?logo=svelte&logoColor=white" alt="SvelteKit 3.0">
  <img src="https://img.shields.io/badge/TypeScript-6.0.3-3178C6?logo=typescript&logoColor=white" alt="TypeScript 6.0.3">
  <img src="https://img.shields.io/badge/UnoCSS-presetWind4-333333?logo=unocss&logoColor=white" alt="UnoCSS presetWind4">
</p>

Poyo Local Studio is a Bun-backed SvelteKit application for creating, monitoring, and
organising Poyo image and video generations on one machine. It combines registry-driven
model forms, persisted asynchronous jobs, immediate verified downloads, a grouped media
library, presets, balance visibility, cleanup controls, and redacted diagnostics in one
responsive light/dark interface.

The project is independent and is not an official Poyo.ai client.

## Model coverage

The October 11, 2026 comparison against [Poyo's documentation index](https://docs.poyo.ai/llms.txt)
covers all 29 indexed image and 41 indexed video model pages, plus the two existing Sora Official
pages that remain directly accessible. The registry contains 53 image model IDs with 66 workflows
and 69 video model IDs with 151 workflows. The studio supports text and reference-image generation, image
editing, text/image/frame/reference-to-video, video editing and extension, motion transfer,
multi-shot generation, and audio-driven avatar video.

Recent additions include [Seedream 5.0 Flash](https://docs.poyo.ai/api-manual/image-series/seedream-5-0-flash),
GPT Image 2.5 Flare and Sunburst, Nano Banana 2.1, Qwen Image 2.1, Gemini Omni 1.1 Flash,
H3 Max and H3 Max Turbo. Grok Imagine Video 1.5 includes text, image and reference modes;
Kling Avatar 2.0 Standard and Pro accept an avatar image and a public driving-audio URL.
Audio inputs use remote URLs; local audio upload is not available.

The Models page links each workflow to its source documentation and shows its limitations.
Model-specific fields, reference limits and incompatible combinations are checked before
submission. Remote media metadata constraints remain subject to provider validation.
Legacy and JSON-only Sora specifications remain audit records outside the selectors.
Pricing stays unavailable when published rows cannot be matched unambiguously; the studio
does not invent prices for new models. Registry evidence includes paired Markdown/JSON hashes,
reviewed schemas and request fixtures. Run `bun run validate:registry` to check this evidence.

## Quick start

### Requirements

- [Bun 1.4.2](https://bun.sh/) — pinned in `.bun-version` and `package.json`.
- A Poyo API key for connectivity or generation. No paid request is needed to install, build,
  or run the automated test suite.

ExifTool, ImageMagick, FFmpeg, and ffprobe are optional local privacy enhancements. Image cleanup is
available with [ExifTool 13.55+](https://exiftool.org/) and
[ImageMagick 7.1+](https://imagemagick.org/); video cleanup uses ExifTool plus
[FFmpeg and ffprobe 8.1+](https://ffmpeg.org/). Without a complete supported toolchain, local uploads
still use the validated managed-source path but continue without metadata cleanup. The application
invokes available tools directly with bounded argument-array subprocesses and no shell integration.
After installing or updating a tool, restart Studio so its server process receives the updated
`PATH`, then reload the page.

### Development

Clone the repository, install with `bun install --frozen-lockfile`, and create a private `.env`
from `.env.example` if environment configuration is needed. Never commit `.env`. Start the local
development server with `bun run dev`.

Open <http://127.0.0.1:5173>.

### Production build

```bash
bun run build
bun scripts/start.ts
```

Run Studio directly. With Bun 1.4.2's default shell, `bun run start` and `bun start` deliver one
Ctrl+C twice, which skips the drain and stops at once.

Open <http://127.0.0.1:3000>, the address the server listens on. Use the IP address rather than
`http://localhost:3000`: pages load there too, but the browser reports a different origin, so
saving changes fails.

The supported production command validates the bind address before importing the built server.
`HOST` may be `127.0.0.1` or `::1` only. Wildcard, LAN, and hostname binds fail closed so the
backend remains a private loopback service.

### Runtime settings

All optional; set them in the environment or in `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address, `127.0.0.1` or `::1` (then open `http://[::1]:3000`). |
| `PORT` | `3000` | Listen port, read when the server starts. |
| `BODY_SIZE_LIMIT` | `101M` | Largest request body; `K`/`M`/`G` are binary units and `Infinity` disables the limit. The default fits the largest upload Studio accepts. |
| `SHUTDOWN_TIMEOUT` | `1` | Seconds open requests get to finish after Ctrl+C, `SIGTERM`, or closing the terminal (`SIGHUP`); the server exits at that deadline even if the app still has work in flight. Background job polling stops at the first signal and cancels a status check in progress, so a restarted server polls its jobs again at once. With `bun scripts/start.ts`, a second Ctrl+C stops at once. |
| `CONNECTION_IDLE_TIMEOUT` | `10` | Seconds before an idle connection is closed (0 to 255; 0 never closes). Time the app takes to answer does not count, and live job updates are exempt. |
| `ORIGIN` | unset | Not needed. If set, it must equal the address the server listens on, such as `http://127.0.0.1:3000`, or startup fails. |

The server sets `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER`, `ADDRESS_HEADER`, `XFF_DEPTH` and
`SOCKET_PATH` itself; values you set for them are ignored.

## Privacy

Poyo Local Studio stores application data locally and includes no telemetry or analytics. Your API
key remains server-side; media is sent to Poyo only for operations you initiate or to finish an
existing job. Optional metadata cleanup is available for local uploads when the supported tools are
installed. Deleting local data does not delete content held by Poyo.

## License

Poyo Local Studio is licensed under the [GNU Affero General Public License v3.0](LICENSE).

## Biome configuration

`biome.json` uses the pinned Biome version, Git ignore rules, recommended lint and
import-organizing rules, and the existing two-space, 100-column, single-quote style.
`bun run lint` runs every Biome check (lint, formatting and import organization)
without writing; `bun run format` writes formatting, and `bunx --bun biome check --write .`
applies safe fixes.

Experimental HTML support enables Svelte markup checks and formatting. The exact
file overrides record these compatibility limits:

- Formatting is disabled for `src/routes/gallery/+page.svelte` and
  `src/lib/components/library/JobDetailView.svelte`: Biome 2.5.15 would insert whitespace
  between elements they deliberately keep adjacent, which changes the rendered DOM. Lint
  and import organization remain enabled.
- Focusable tab panels and the keyboard-operated media viewport retain their tab stops.
- Generated video has no caption track; the caption exceptions match the existing
  Svelte suppressions. The media preview link has a dynamic accessible name that
  Biome's anchor-content check does not recognize.
- Named UI groups and the media viewport retain their explicit ARIA roles instead
  of requiring form fieldsets or a different container element.

The captured pricing HTML fixture is excluded so formatting cannot alter the
source evidence. Keep `bun run check` as the framework/type check, and re-evaluate
these narrow overrides when upgrading Biome.

# web/

Frontend for the MBTA Reliability Tracker. One page, no routing.

## Vercel settings

| Setting | Value |
|---|---|
| Root Directory | `web` |
| Framework Preset | Next.js (auto-detected) |
| Include files outside root directory | **ON** (Vercel default) |
| Build / Install / Output | defaults |

**"Include files outside root directory" must stay on.** `lib/limitations.ts` reads
`../README.md` at build time so the limitations shown on the page cannot drift from
the project's own record of them. Vercel clones the whole repository and the Root
Directory setting only changes the working directory, so the parent README is
present — but only while that option is enabled. If it is turned off the build
fails loudly rather than rendering an empty limitations section, which is the
intended failure mode.

This also means `vercel deploy` run by hand from inside `web/` will FAIL: the CLI
uploads only that directory. Deploy through the Git integration, or run the CLI
from the repository root with Root Directory configured in the project.

## Environment

| Variable | Default |
|---|---|
| `NEXT_PUBLIC_WORKER_BASE` | `https://mbta-collector.mbta-collector.workers.dev` |

Only needed if the Worker moves. The frontend reads three JSON endpoints and never
touches D1.

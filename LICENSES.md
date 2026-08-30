# LICENSES.md

Every framework, library, font and tool used in this project. No starter
template, boilerplate, UI kit or purchased asset was used.

## Frontend — runtime

| Package | Version | Licence |
|---|---|---|
| react | ^19.0.0 | MIT |
| react-dom | ^19.0.0 | MIT |
| @tanstack/react-query | ^5.59.0 | MIT |
| @dnd-kit/core | ^6.1.0 | MIT |
| @dnd-kit/utilities | ^3.2.2 | MIT |

## Frontend — build tooling

| Package | Version | Licence |
|---|---|---|
| vite | ^6.0.0 | MIT |
| @vitejs/plugin-react | ^4.3.4 | MIT |
| tailwindcss | ^4.0.0 | MIT |
| @tailwindcss/vite | ^4.0.0 | MIT |
| typescript | ^5.7.0 | Apache-2.0 |
| @types/react, @types/react-dom | ^19.0.0 | MIT (DefinitelyTyped) |
| tsx | latest (npx, dev harness only) | MIT |

## Backend

| Package | Version | Licence |
|---|---|---|
| express | ^4.21.2 | MIT |
| pg | ^8.13.1 | MIT |
| @upstash/redis | ^1.34.3 | MIT |
| cors | ^2.8.5 | MIT |
| compression | ^1.7.5 | MIT |
| dotenv | ^16.4.7 | BSD-2-Clause |

Tests use Node's built-in `node:test` runner and `node:assert` — no third-party
test framework.

## Fonts

Loaded from Google Fonts. All three are under the SIL Open Font License 1.1.

| Font | Role | Licence |
|---|---|---|
| Archivo | display / headings | OFL-1.1 |
| IBM Plex Sans | body text | OFL-1.1 |
| IBM Plex Mono | times, ids, data | OFL-1.1 |

## Container images

| Image | Licence |
|---|---|
| node:22-alpine | MIT (Node.js) / Alpine base |
| nginxinc/nginx-unprivileged:1.27-alpine | BSD-2-Clause (nginx) |

## Services

| Service | Role |
|---|---|
| Neon | Postgres — plans and the audit ledger |
| Upstash Redis | read-through cache |
| Vercel | hosting |

## Assets

No icon set, illustration pack, stock image or purchased asset is used. The
timeline, meters, bars and hatching are hand-written CSS and SVG-free DOM.

## Data

`instructions/P11_route_shift_public.json` is the organisers' public sample
dataset, used unmodified. See [EVENT.md](./EVENT.md).

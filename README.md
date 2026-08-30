# Dispatch Board — Route & Shift Assignment Optimiser

**Problem:** P11 · **Team:** `LSH26-T###` *(fill in)* · **Live URL:** *(fill in)*

A dispatcher's day-plan tool for a home-service company in Dhaka. It builds the
morning plan across 12+ technicians, refuses anything that breaks a hard rule and
says which rule, and lets the dispatcher move a job by hand and see the verdict
before they let go.

---

## Run it

Everything runs in Docker. You need Docker and a `.env`.

```bash
cp .env.example .env      # then fill in DATABASE_URL and the Upstash keys
docker compose up --build
```

- **http://localhost:8090** — the board
- **http://localhost:8091/api/readyz** — API health:
  `{"ok":true,"db":true,"cache":true,"persistence":true}`

`db` and `cache` report `"not_configured"` rather than `false` when the variable
is absent — absent is not the same as unreachable. The board works without
either: the solver is deterministic, so a plan is rebuilt from its id when there
is no database. You lose the ledger and move persistence, nothing else.

The API applies its migrations on boot, so there is no separate setup step.

### Run the tests

```bash
docker compose run --rm --build test
```

**212 tests** across three suites. They need no database and no network — the
rule engine, solver and HTTP layer are all exercised in-process — so this runs
offline and in CI.

Keep the `--build`. Without it Compose reuses the image from the last build and
silently runs an older copy of the tests. Add `-e FORCE_COLOR=1` if your terminal
strips the colour.

```bash
# the 25 public cases: feasibility, reasons, determinism, scripted moves
docker compose run --rm --build test node --test --test-reporter=spec test/golden.test.js

# our own cases: malformed input, degenerate shapes, replanning
docker compose run --rm --build test node --test --test-reporter=spec test/edge.test.js

# the API over HTTP: validation, 409s, emergency persistence, sick accounting
docker compose run --rm --build test node --test --test-reporter=spec test/api.test.js

# one behaviour by name
docker compose run --rm --build test node --test --test-name-pattern="manual move"
```

### Frontend with hot reload

```bash
docker compose --profile dev up web-dev     # Vite on :5173, /api proxied to the API container
```

### Offline demo, no database

```bash
docker compose --profile dev run --rm -e VITE_USE_MOCK=1 -p 5173:5173 web-dev
```

Runs the planner in the browser against the bundled case file. Useful when you
have no connectivity; it is not the real engine.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind v4 | The board is bespoke timeline geometry, so no component kit — a UI library is largely what makes products look interchangeable. |
| Drag | dnd-kit | Ships keyboard dragging, so the manual move is not mouse-only. |
| Server state | TanStack Query | The server owns the plan; the browser never decides what is legal. |
| Backend | Node 20+, Express, plain ESM JavaScript | One monolith, one process, no build step on the server. |
| Database | Neon Postgres (`pg`) | Plans and the audit ledger. Pooled endpoint works the same from Docker and Vercel. |
| Cache | Upstash Redis (REST) | Read-through and optional — an outage costs latency, not correctness. |
| Container | Multi-stage Docker, nginx + Node | Static bundle on unprivileged nginx; `/api` proxied to the monolith. |
| Deploy | Vercel | `api/index.js` exports the same Express app Docker runs. |

Full diagrams and the reasoning behind the structure: **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## How each requirement is met

### AT1 — the data

25 public cases (`PUB-01`…`PUB-25`), 12–16 technicians and 30–40 jobs each, with
skills, shift windows, home areas, and the authoritative area-to-area travel
table. Validated at ingest; nothing is hardcoded to a case size.

> `docker compose run --rm --build test node --test --test-name-pattern="brief minimums"`

### AT2 — assignment that respects the hard rules, and one stated goal

> **Goal: assign as many jobs as possible; among plans that assign equally many,
> minimise total travel minutes.**

Stated in the board header and enforced lexicographically. Structural pre-screen,
then multi-start cheapest insertion across four fixed orderings, then local
search — all through `rules.js`, and deterministic, so a judge re-running a case
gets the same board.

Every generated plan is checked against the same engine that built it, on all 25
cases, and compared to a naive baseline (jobs in id order to the first technician
who can legally take them). The board shows the delta.

> `docker compose run --rm --build test node --test --test-name-pattern="feasible|beats the naive"`

### AT3 — the timeline, and the unassigned list

One row per technician: solid blocks are service, hatched bands are travel, and
idle is the bare ruled board showing through — a wasteful plan reads as holes.
Below it, every unassigned job with its rule code and a sentence carrying the
real numbers:

```
J17  Mirpur · electrical · 1h 30m · 13:00–15:00
WINDOW_LATE — every electrician is booked; the earliest free arrival is 14:20
and 90 min does not fit before 15:00.
```

Assigned + unassigned always accounts for every job, with no job in both.

> `docker compose run --rm --build test node --test --test-name-pattern="silently dropped|planted"`

### AT4 — the manual move

Drag a job onto another technician (or focus it and press Enter). The verdict
appears in the ledger *before* you drop, and it is the same verdict you get on
drop, because `validate-move` and `move` are one function — validate just throws
its copy away. A refused move returns **409 with the violations attached**,
leaves the plan untouched, and is written to the ledger.

```
$ curl -s -XPOST localhost:8091/api/plans/PUB-07-v1/move \
    -H 'content-type: application/json' -d '{"job_id":"J18","to_technician":"T05"}'
409
SKILL_MISMATCH — Habib does not have the ac skill (has: electrical).
WINDOW_LATE    — Habib reaches Gulshan at 13:25, but J16 takes 1h 15m and must be finished by 12:00.
```

Note it names the **knock-on** effect too, not just the first rule.

> `docker compose run --rm --build test node --test --test-name-pattern="scripted manual_move|never changes the plan|always agree"`

### Bonus

All three have a UI, not just an endpoint.

- **Emergency job mid-day** — the *Emergency job* button. Area, skill and
  duration come from the live case; the form warns before you submit if the
  window is shorter than the job. Jobs already under way stay put. An infeasible
  emergency lands in unassigned with its rule, never dropped. The job is stored
  with the plan, so it still exists on the next request.
  `POST /plans/:id/emergency`
- **Technician calls in sick** — the *Technician off* button. Before you commit
  it says exactly what moves: what they keep, and which jobs need a new home,
  by id and time. `POST /plans/:id/sick`
- **Plan score and comparison** — every plan carries assigned, travel, idle,
  tightest slack, coverage and a score. Once you drag anything, a *Your plan vs
  the generated one* table appears and marks in red whatever your edits made
  worse against the stated goal. `POST /plans/compare`

### On a phone

Below 900px the timeline becomes a per-technician agenda — a 12-hour axis is
unreadable at 390px. Travel and idle stay visible as their own rows, because
that waste is what the board exists to show. Press and hold to move a job; the
ledger becomes a button in the bottom corner.

---

## Major decisions

**One rule engine, called by everything.** The solver, the manual move, the drag
preview and both bonus replanners all go through `rules.evaluate()`. Two code
paths would drift and the dispatcher's verdict would stop matching the board.

**Every rejection is a value, not a log line.** `{code, message, detail}`, with
the message written once in the backend and rendered verbatim by the UI.

**Deterministic by construction.** No RNG anywhere, fixed tie-breaks, and
`solver_version` in the plan id — judges must be able to reproduce a board.

**Impossible vs no-room.** The structural pre-screen separates "no technician has
this skill" from "everyone is booked". A dispatcher can act on the second and
only escalate the first.

**Times are integer minutes since midnight** everywhere — database, domain, API.
Formatting happens only in the UI.

---

## Known limitations

- **Overnight shifts are rejected, not wrapped.** `22:00–06:00` is flagged
  `INVALID_SHIFT` and the technician is excluded, rather than silently
  reinterpreted.
- **A job must fit entirely inside its customer window.** The brief is ambiguous
  about start-vs-finish; the stricter reading is the safer promise to a customer.
- Local search is relocate-only inside a time budget. Swap and 2-opt would likely
  find more. When the budget runs out the API returns the best plan so far with
  `"partial": true` — never nothing.
- The travel table is taken as authoritative. An asymmetric table is accepted and
  used directionally, with a warning in the ledger, rather than "corrected".
- No auth, single dispatcher. Concurrent edits are caught by plan `version`
  (`409 STALE_PLAN`), not prevented.
- The phone layout is built and type-checked but has not been reviewed on a real
  device; spacing and touch targets may need tuning.
- `web/src/mocks/planner.ts` is a browser fixture for offline demos. It is not
  the rule engine and is not in the default path.

---

## Repository

```
server/src/
  domain.js      minute arithmetic and the single route walk — no I/O
  rules.js       THE hard-rule engine; every caller goes through it
  solver.js      multi-start greedy, local search, moves, replanning
  validate.js    request-body validation, so a 400 names the field
  cases.js       ingest and validation of the 25 cases
  store.js       the only module that knows SQL
  cache.js       Upstash, read-through and always optional
  app.js         HTTP surface
server/migrations/   001 schema · 002 emergency jobs
server/test/         golden (25 cases) · edge (our own) · api (over HTTP)

web/src/components/
  Timeline.tsx   the desktop board
  Agenda.tsx     the phone layout
  Panels.tsx     metrics, unassigned list, job drawer
  Disruptions.tsx  emergency and sick sheets
  Insights.tsx   meters, composition, failure breakdown, comparisons
  Ledger.tsx     the rule ledger
  ErrorBoundary.tsx

api/index.js     Vercel entry: exports the same Express app
instructions/    Problem statement, sample data, planning docs (gitignored)
```

Secrets live in `.env` (gitignored) and in Vercel's environment. `.env.example`
lists only the variables this app actually reads.

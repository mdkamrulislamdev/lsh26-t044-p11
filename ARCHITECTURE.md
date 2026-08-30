# Architecture

## The decision everything else follows from

**There is exactly one hard-rule engine, and every caller goes through it.**

```mermaid
flowchart LR
    S[solver.js<br/>builds the plan] --> R
    M[POST /move<br/>dispatcher drags a job] --> R
    V[POST /validate-move<br/>drag preview] --> R
    E[POST /emergency] --> R
    K[POST /sick] --> R
    R[["rules.js — evaluate()<br/>returns Violation[]"]] --> O["[] = legal<br/>non-empty = named rules broken"]
```

If the solver and the manual-move check were separate code, they would drift, and
the verdict shown to the dispatcher would stop matching the plan on screen. One
function, typed rule codes, one vocabulary of reasons in the UI.

It is also how the brief's hard constraint is met — *"the unassigned jobs list
with a reason for each one is required. Silence is not an answer."* Every
rejection anywhere in this system is a `Violation` value, never a log line.

## Stack

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["React 19 · TypeScript · Vite<br/>Tailwind v4 · dnd-kit · TanStack Query"]
    end

    subgraph edge["nginx :8080 (container) → :8090 (host)"]
        ST["static bundle"]
        PX["/api/* proxy"]
    end

    subgraph api["Express monolith :8080 → :8091"]
        A["app.js — HTTP surface"]
        SOL["solver.js — greedy + local search"]
        RUL["rules.js — the engine"]
        DOM["domain.js — minute arithmetic"]
        CAS["cases.js — ingest + validation"]
        CA["cache.js"]
        STO["store.js — the only SQL"]
    end

    PG[("Neon Postgres<br/>plans · plan_events")]
    RD[("Upstash Redis<br/>read-through, optional")]

    UI --> ST
    UI --> PX --> A
    A --> SOL --> RUL --> DOM
    A --> CAS
    A --> CA --> RD
    A --> STO --> PG
```

Dependency direction is one-way: `app → solver → rules → domain`, and
`app → store → database`. `rules.js` and `domain.js` import nothing else from
the project — they cannot reach a database or a request, which is what makes the
engine trustworthy.

## A day plan, end to end

```mermaid
sequenceDiagram
    participant D as Dispatcher
    participant W as React board
    participant A as Express
    participant R as Redis
    participant P as Postgres

    D->>W: pick PUB-07, Generate plan
    W->>A: POST /api/plans {case_id}
    A->>R: GET plan:gen:PUB-07:v1
    alt cache hit
        R-->>A: plan
    else miss
        A->>A: structural pre-screen → multi-start greedy → local search
        A->>R: SET (1h)
    end
    A->>P: upsert plans
    A->>P: insert plan_events "plan_generated"
    A-->>W: routes + unassigned[] + score
    W-->>D: timeline, unassigned reasons, ledger
```

## The manual move — AT4

```mermaid
sequenceDiagram
    participant D as Dispatcher
    participant W as React board
    participant A as Express
    participant P as Postgres

    D->>W: drag J18 over T05's row
    W->>A: POST /validate-move (debounced 120ms)
    A->>A: attemptMove() on a throwaway copy
    A-->>W: {ok:false, violations:[SKILL_MISMATCH, ...]}
    W-->>D: ledger previews the refusal before the drop

    D->>W: drop
    W->>A: POST /move {version}
    A->>A: attemptMove() — the same function
    alt breaks a hard rule
        A->>P: plan_events "move_refused" + violations
        A-->>W: 409 + unchanged plan + named rules
        W-->>D: block springs back, row flashes, ledger logs why
    else legal
        A->>P: upsert plan (version+1) + "move_applied"
        A-->>W: new plan + travel delta
    end
```

`validate-move` and `move` call one function; validate discards its copy. The
drag preview and the drop result cannot disagree. A refused move is a **409 with
the violations attached**, not a bare 400 — and it is written to the ledger,
because a dispatcher's failed attempt and the rule that blocked it is exactly the
history worth keeping.

## The solver

Stated goal, lexicographic: **maximise assigned jobs; among equal, minimise total
travel minutes.**

```mermaid
flowchart TB
    J["all jobs"] --> PS{"structural pre-screen<br/>impossible today?"}
    PS -->|yes| U["unassigned + reason<br/>SKILL_MISMATCH · WINDOW_TOO_SHORT<br/>WINDOW_INVALID · UNKNOWN_AREA · SHIFT_END_OVERRUN"]
    PS -->|no| Q["schedulable queue"]
    Q --> MS["multi-start: 4 fixed orderings<br/>deadline · narrowest · longest · id"]
    MS --> CI["cheapest insertion<br/>every legal (tech, position)"]
    CI --> LS["local search: relocate for travel,<br/>then retry the unplaced pool"]
    LS --> BEST{"keep the lexicographic best"}
    BEST --> PLAN["plan + score"]
    LS -.->|no legal slot| U2["unassigned NO_CAPACITY"]
```

Cheapest insertion is order-sensitive and no single ordering wins on every case —
a single-ordering greedy actually lost to the naive baseline on PUB-03, 07 and
12. Multi-start fixes that without giving up **determinism**: fixed orderings,
fixed tie-breaks, no RNG, so judges re-running a case get the same board.

The pre-screen exists to separate *"impossible today"* from *"no room left"*.
That distinction is what makes the unassigned list useful to a dispatcher, and
the sample data is built to test it: all 25 public cases plant at least one job
no technician can do, and 16 plant a job whose window is shorter than its own
duration.

## Data model

```mermaid
erDiagram
    plans ||--o{ plan_events : "writes"
    plans {
        text id PK
        text case_id
        int version "optimistic concurrency"
        text source "generated|manual|emergency|sick"
        text solver_version
        jsonb score
        jsonb routes
        jsonb unassigned
    }
    plan_events {
        bigserial id PK
        text plan_id FK
        timestamptz at
        text kind
        text summary
        jsonb violations
    }
```

The 25 cases are read-only reference data, embedded in the image and validated at
ingest — there is nothing to migrate and nothing to keep in sync. Only *plans*
and *what happened to them* are persisted.

`plan_events` is append-only and is the backing store for the Rule Ledger in the
UI. `version` gives optimistic concurrency: a `move` carrying a stale version
gets `409 STALE_PLAN` and the current plan, so two dispatchers cannot silently
clobber each other.

## Caching

Plan generation is the only expensive operation, and it is **pure** — the same
case always yields the same plan. That is what makes it safely cacheable, and
part of why the solver is deterministic.

| Key | TTL | Why |
|---|---|---|
| `case:{id}:v1` | 24h | read on every board load, never changes |
| `plan:gen:{case}:{solver_version}` | 1h | keyed on solver version, so shipping a new solver invalidates everything without a flush |
| `mv:{plan}:{version}:{job}:{tech}` | 60s | drag-hover fires the same validation repeatedly; keyed on plan version, so any mutation invalidates the generation |

The cache is read-through and **always optional**. Every path falls back to
computing the value, so a Redis outage costs latency, never correctness. Nothing
cached is ever the source of truth for a rule verdict.

## One codebase, two hosts

```mermaid
flowchart LR
    SRC["server/src/app.js<br/>createApp()"]
    SRC --> D["Docker: server/src/index.js<br/>listen + migrate on boot"]
    SRC --> V["Vercel: api/index.js<br/>export default createApp()"]
    W2["web/"] --> DW["nginx static + /api proxy"]
    W2 --> VW["Vercel static build<br/>rewrite /api/* → api/index"]
```

The same Express app runs in both places. Docker adds the listener and boot
migrations; Vercel imports the app directly.

## Frontend

The board's visual encoding *is* its argument: **service is solid, travel is
hatched, idle is nothing — the bare ruled ground showing through.** A wasteful
plan reads as holes. The header's coverage % and the objective function are the
same quantity.

One hot colour exists on the page (`#D8402A`) and it is reserved exclusively for
a broken hard rule. Nothing else is ever red, so a dispatcher learns in seconds
what red means.

The **Rule Ledger** is the signature element: an append-only right rail reading
from `plan_events`, which doubles as a live verdict preview during a drag. It is
*"silence is not an answer"* made literal — nothing happens on this board without
a written reason.

## Known limitations

- **Overnight shifts are rejected**, not wrapped. A technician with
  `22:00–06:00` is flagged `INVALID_SHIFT` and excluded rather than silently
  interpreted.
- **A job must be fully contained in its window.** The brief is ambiguous;
  the stricter reading is the safer one for a promise made to a customer.
- Local search is relocate-only within a time budget. Swap and 2-opt would
  likely find more, and `partial: true` is reported when the budget runs out.
- `web/src/mocks/planner.ts` is a browser fixture kept for offline demos
  (`VITE_USE_MOCK=1`). It is not the rule engine and is not in the default path.

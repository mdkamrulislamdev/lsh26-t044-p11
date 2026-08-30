# Approach

## How we read the problem

The brief asks for a plan, but the sentence that shapes the whole design is the
constraint: *"The unassigned jobs list with a reason for each one is required.
Silence is not an answer."* A scheduler that quietly drops the jobs it cannot
place looks better on a screenshot and is useless to a dispatcher.

Reading the sample data confirmed it. **All 25 public cases plant at least one
job whose required skill no technician has**, and 16 of them plant a job whose
customer window is shorter than the job's own duration. **19 of the 25 scripted
`manual_move` entries send a job to a technician who lacks the skill** — the
manual-move requirement is graded mostly on the *refusal*, not the success.

So we built the explanation first and the optimiser second.

## What we did about it

**One rule engine.** `rules.evaluate()` is the only thing in the system that
decides whether something is legal, and the solver, the manual move, the drag
preview and both bonus replanners all call it. Two code paths would drift, and
the verdict shown to the dispatcher would stop matching the board. Every
rejection anywhere is a `{code, message, detail}` value — never a log line —
and the message is written once in the backend and rendered verbatim in the UI.

**Impossible versus no-room.** A structural pre-screen decides, before any
scheduling happens, whether a job is impossible today regardless of arrangement.
"No technician has the gas_line skill" is a hiring problem; "everyone is booked"
is a today problem. A dispatcher can act on the second.

**The optimiser, stated plainly.** Maximise assigned jobs; among plans that
assign equally many, minimise total travel. Structural pre-screen, then
cheapest-insertion greedy, then relocate-based local search. Cheapest insertion
turned out to be order-sensitive enough that a single ordering *lost to the naive
baseline* on three cases — a real bug our tests caught — so it now runs four
fixed orderings and keeps the lexicographic best. Still fully deterministic: no
RNG, fixed tie-breaks, so a judge re-running a case gets the same board.

**The board shows its holes.** Service is a solid block, travel is a hatched
band, and idle is nothing at all — the bare ruled ground showing through. A
wasteful plan reads as gaps, so the visual encoding and the objective function
are the same quantity. One hot colour exists on the page and it is reserved
exclusively for a broken rule.

**The Rule Ledger.** An append-only rail, backed by a `plan_events` table, where
every decision writes a line — including refused moves. During a drag it
previews the verdict *before* you let go, in the exact wording you would get on
drop, because the preview and the drop call the same function.

## What we would do next

Swap and 2-opt neighbourhoods in the local search, an ejection chain to trade one
placed job for two, and a proper compare view for manual-versus-generated plans.

## Contributions

<!-- FILL IN: one line per registered member, naming what they actually owned. -->

| Member | Major contribution |
|---|---|
| *(name)* | *(e.g. rule engine and solver, `server/src/rules.js`, `solver.js`)* |
| *(name)* | *(e.g. board UI, timeline and drag interaction, `web/src/components/`)* |
| *(name)* | *(e.g. persistence, caching, Docker and deploy)* |
| *(name)* | *(e.g. test suites, edge-case catalogue)* |

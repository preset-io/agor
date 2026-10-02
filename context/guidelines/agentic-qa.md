# Agentic QA protocol

Use this protocol for agent-driven feature validation and regression discovery.
Start at [qa/README.md](../../qa/README.md) for templates and environment profiles.
It complements [automated testing conventions](testing.md); it does not replace them.

## Define the claim before execution

1. Map the requested feature or diff to stable scenario IDs and adjacent risks.
2. Read the relevant product guide, accepted requirement, canonical types, and code.
   Requirements define intended behavior; code locates enforcement and observation
   points. If they conflict, record the ambiguity instead of copying a bug into the
   expected result. Continue independent checks while resolving it.
3. Choose the smallest test layer that proves each claim: unit/component,
   service/database, browser component, or running application. Name mocked boundaries.
4. Assess [tenant ownership and isolation](../concepts/multitenancy.md). Select
   applicable negative cases across API, realtime, async work, files, and cleanup.
   A hidden control alone does not prove denied access. Review this assessment again
   against the final change and evidence.
5. Record applicable permission, multiplayer, persistence, lifecycle, recovery,
   execution-mode, and accessibility/layout variations. Explain exclusions briefly;
   do not expand every scenario into every possible combination.

## Preflight

- Record the scenario revision, checkout revision and relevant uncommitted changes,
  target URLs, environment profile, database dialect, execution mode, browser/viewport,
  and agent/tool versions when they affect reproducibility. Never record credentials.
- Verify that the running target belongs to the intended checkout. A reachable health
  endpoint alone does not prove revision identity or application readiness.
- Establish fixture ownership, independent authenticated actors, expected initial state,
  observation tools, and a cleanup procedure before mutating data. Use disposable,
  run-owned resources; never reset a shared database as a convenience.
- Use the documented environment workflow. Respect the repository's user-managed watch
  mode: do not start background processes or build the application without authorization.
- Identify external calls, paid execution, and irreversible side effects. Stay within
  the authorized environment and task scope; missing required access is a blocker.
- Set a time/action budget for exploration, condition-based timeouts, and a bounded
  reproduction/retry budget before running. Budget exhaustion leaves unfinished checks
  explicitly untested; it is not evidence of success.

## Execute and observe

Run each required scenario from its declared starting state. Exercise the named
interface: an API mutation cannot substitute for the UI action being tested. APIs
and existing fixtures may prepare data or independently verify the result.

Use semantic browser locators and condition-based waits. Inspect screenshots for
visual claims and retain traces or focused event/network evidence for failures.
Confirm persistence and side effects at their authoritative boundary when the scenario
requires them. For multiplayer, use independent authenticated clients. For runtime
changes, follow [task lifecycle invariants](../concepts/task-runtime-state.md): a badge
or live heartbeat is not proof of SDK progress or verified termination.

After prescribed checks, investigate the scenario's exploration charter. Record new
hypotheses and findings separately from required coverage. Preserve the first failure
before retrying, fixing, or resetting. Reset relevant state between trials, and record
every attempt; a later success does not erase an intermittent failure.

## Verdict and failure handling

Assign a verdict per scenario **and environment/variation**, with evidence references:

| Verdict        | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `pass`         | All required outcomes were observed with the specified evidence.       |
| `fail`         | Evidence demonstrates a violated requirement.                          |
| `blocked`      | A known prerequisite prevents completion; name it and the next action. |
| `inconclusive` | Execution or evidence cannot establish the outcome reliably.           |
| `not_run`      | No execution was attempted; explain the omission.                      |

Classify failures separately as product, test/harness, environment, or unresolved.
Do not call a suspected harness problem a product pass. A required check that skips,
times out without sufficient evidence, or lacks its required environment stays incomplete.
Report verdict counts and unresolved gaps; never summarize a partially executed scope
as fully validated. Record intermittent results even when a later attempt passes.

Reproduce a defect within the agreed budget and capture expected versus actual behavior,
minimal steps, affected actors, and evidence. Fix within the authorized scope under the
normal development workflow; keep diagnosis, source repair, and verification distinct.
Never weaken assertions, accept a new visual baseline, change requirements, or skip a
broken test merely to obtain a passing result. Locator/wait/fixture repairs must preserve
the claim and explain why the failure belonged to the harness.

## Preserve regressions and finish

- Link a confirmed reproducible defect to the smallest useful automated regression test
  and the stable scenario ID. Prefer existing colocated suites; add a full application
  test only when that boundary is needed. Record a follow-up if automation is blocked.
- Where feasible, prove the regression check fails before the fix and passes after it
  in an isolated environment. Do not introduce deliberate faults into a shared runtime.
- Update the specification when accepted behavior changes, preserving IDs for the same
  contract. The feature author maintains it and the reviewer checks its proof limits.
- Clean up only resources owned by this run, including sessions/processes started for it.
  Verify cleanup and record leftovers or intentional retention separately from verdicts.
- Use the [run result template](../../qa/templates/run-result.md). Keep routine reports,
  traces, screenshots, and logs in issue/PR attachments or CI artifacts, not tracked
  repository reports. Sanitize evidence before sharing: exclude secrets, auth state,
  private data, and credential-bearing URLs; use an access-appropriate artifact destination.

## Design references

The protocol combines [specification by example](https://martinfowler.com/bliki/SpecificationByExample.html),
[human-readable browser test plans](https://playwright.dev/docs/test-agents), and
[outcome-based agent evaluation](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
These inform the approach; the repository contracts above govern execution.

# QA run: {run ID}

Publish the completed result in the issue/PR or CI artifacts, not as a tracked report.
Sanitize attachments and links before sharing. Use aliases for actors and resources;
omit secrets, authentication state, private data, and credential-bearing URLs.

## Scope and environment

- Requested scope and scenario IDs/revisions: {references}
- Checkout revision and relevant uncommitted changes: {identity}
- Target/profile: {sanitized URLs, proof target uses intended checkout, profile ID}
- Runtime: {dialect, execution mode, replicas, real/mocked dependencies}
- Browser/viewport and relevant agent/tool versions: {versions}
- Actors/fixture state and preflight evidence: {aliases, ownership, checks}
- Start/end time and execution/exploration/retry limits: {values}

## Results

Verdicts: `pass`, `fail`, `blocked`, `inconclusive`, `not_run`.
Report each required profile/variation separately, including ones not executed.

| Scenario / profile / variation | Verdict | Attempt(s), including first failure | Evidence references                | Gap or next action |
| ------------------------------ | ------- | ----------------------------------- | ---------------------------------- | ------------------ |
| {ID / profile / case}          | not_run | {none, or attempt IDs}              | {assertion/trace/state references} | {reason}           |

- Counts by verdict: {counts; reconcile with the selected scope}
- Intermittent outcomes: {all failures and retries, even after later success}
- Untested scope and proof limits: {explicit omissions; no extrapolated claims}

## Findings and reproduction

For each finding, include severity/impact, classification (`product`, `test/harness`,
`environment`, `unresolved`), expected versus actual behavior, minimal reproduction,
affected actors, and sanitized evidence. Identify the attempt and revision observed.
List exploratory discoveries separately from required scenario failures.

## Repairs and regression evidence

- Changes: {source or harness repair, rationale, revision; or none}
- Reverification: {new attempts and evidence; preserve original failure}
- Regression test: {path/test name and scenario ID; before/after result or proof gap}
- Follow-ups: {remaining automation or specification gaps}

## Cleanup

- Run-owned resources and cleanup checks: {removed/verified, or no resources created}
- Leftovers/intentional retention: {reason and responsible owner; or none}
- Cleanup failures: {evidence and next action; or none}

State the conclusion proportionately: a passing subset is not a fully validated feature,
and successful scenario assertions do not imply successful cleanup.

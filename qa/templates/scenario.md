---
id: QA-feature-001
status: draft
risk: normal
profiles: []
surfaces: []
regression_tests: []
---

# Scenario: {observable user outcome}

Copy to `qa/specs/{feature}/{scenario}.md`. Replace all placeholders before setting
`status: ready`. Follow the QA protocol linked from `qa/README.md`.

## Intent and requirement

- Accepted requirement: {guide/issue section and relevant contract}
- User outcome: {what this protects and impact of failure}
- Related scenarios/source boundaries: {stable IDs and relevant code paths}

## Actors and preconditions

- Actors: {identities by alias, roles, tenants, ownership and independent clients}
- Resources: {tenant-owned / derived / explicit system-global classification}
- Environment: {profile IDs; configuration, dialect, execution mode, viewport}
- Setup: {existing fixture/helper or exact repeatable setup actions; no secrets}
- Initial state: {observable conditions and how to verify them}
- Dependencies and observation access: {real versus mocked services; missing setup}
- Scope: {allowed mutations/external calls and run-owned resource identifiers}
- Limits: {condition timeouts, reproduction attempts, exploration time/actions}

## Actions and required evidence

| Step | Actor and interface  | Action              | Required outcome, including forbidden side effects | Evidence/check and timeout  |
| ---- | -------------------- | ------------------- | -------------------------------------------------- | --------------------------- |
| 1    | {actor; UI/API/etc.} | {meaningful action} | {observable assertion}                             | {authoritative observation} |

Specify persistence, other-client updates, and runtime evidence when needed. UI
confirmation alone does not prove those outcomes. Avoid implementation-specific click
scripts unless the exact interaction is the requirement. Missing required evidence
prevents a pass.

## Applicable variations

For each applicable dimension, specify concrete steps/outcomes here or link a separate
scenario. Record a short reason for exclusions; an empty checklist is not coverage.

| Dimension                       | Applicable cases or exclusion reason                | Scenario/step reference |
| ------------------------------- | --------------------------------------------------- | ----------------------- |
| Permissions and foreign tenants | {allowed/denied actors and boundary assertions}     | {reference}             |
| Multiplayer and concurrency     | {independent clients; competing actions; reconnect} | {reference}             |
| Persistence and lifecycle       | {reload; cancellation; late events; cleanup}        | {reference}             |
| Failure and recovery            | {dependency failure; retry; partial completion}     | {reference}             |
| Execution and infrastructure    | {mock/live provider; dialect; mode; replicas}       | {reference}             |
| Keyboard and layout             | {focus; viewport; overflow}                         | {reference}             |

## Exploration charter

Investigate {specific failure hypotheses} within the limits above. Record additional
findings separately; exploration does not replace required steps or expand authorization.

## Cleanup and regression maintenance

- Cleanup: {exact run-owned resources, removal procedure and verification}
- Retention/failure handling: {what remains if cleanup fails; how to report it}
- Regression mapping: {existing test path plus test name, or explicit automation gap}
- Maintenance: {feature owner; linked requirement change when expectations change}

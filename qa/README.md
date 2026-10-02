# Agentic QA

Reusable specifications describe what must work, which environment can prove it,
and what evidence an agent must collect. Follow the
[QA protocol](../context/guidelines/agentic-qa.md) before executing them.

## Start here

1. Copy the [scenario template](templates/scenario.md) into
   `qa/specs/<feature>/<scenario>.md` when a feature is selected. Create that directory
   with the first real specification; templates alone are not coverage.
2. Replace placeholders, link an accepted requirement, select applicable variations,
   and resolve the required environment/setup before calling the scenario executable.
3. Use the [local environment profile](environments/local.md) to identify existing
   test layers and missing runtime prerequisites. It is an inventory, not a readiness receipt.
4. Execute under the protocol and publish a [run result](templates/run-result.md)
   with evidence in the issue/PR or CI artifacts.
5. Link useful regression tests from the specification. Existing automated tests remain
   colocated with source under [testing conventions](../context/guidelines/testing.md).

## Conventions and ownership

- IDs use `QA-<feature>-<number>`, for example `QA-catalog-001`. Keep IDs stable across
  filename changes; use a new ID when replacing the behavioral contract.
- YAML frontmatter is descriptive metadata, not an executable schema or runner API.
  `status` is `draft`, `ready`, or `retired`; `risk` is `critical`, `high`, or `normal`.
  `ready` means prerequisites and expectations are specified, not that testing passed.
- `profiles` names documented profile IDs. The local profile defines `local-component`
  and `local-app`; selecting either still requires its preflight checks for each run.
- Feature authors maintain scenarios with behavior changes. Reviewers check requirements,
  applicable boundaries, evidence quality, and linked regression coverage.
- Keep durable specs, profiles, templates, and shared helpers here. Keep transient results
  outside the tracked tree; do not put authentication state or fixture secrets in specs.

## Template walkthrough (documentation only)

The existing [Catalog keyboard browser test](../apps/agor-ui/src/components/Marketplace/MCPCatalogModal.browser.test.tsx)
named `opens from the header with Enter/Space, searches, closes with Escape, tears down and restores focus`
illustrates how to fill the template:

| Field               | Mapping from the existing test                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent              | Keyboard users can open, search, close, and reopen the Catalog.                                                                                                                                             |
| Profile/surface     | `local-component`; real browser, fixture client, mounted Catalog harness.                                                                                                                                   |
| Actors/ownership    | One fixture client; no real authenticated tenant or persisted resources.                                                                                                                                    |
| Preconditions       | Render the harness with a fresh client; visible header trigger; configured Chromium viewport.                                                                                                               |
| Actions             | Open with Enter; search for a missing provider; clear; select Credentials; close with Escape; reopen with Space.                                                                                            |
| Expected evidence   | Dialog in viewport; no-match message; results restored; stable dialog height across tab switch; listeners removed and trigger focused after close; Catalog tab selected after reopening; route remains `/`. |
| Variations          | Use the existing browser configuration's viewport instances. Real auth, tenant isolation, persistence, and provider connection need separate scenarios.                                                     |
| Exploration charter | In a future QA run, investigate focus loss across repeated close/reopen actions within a declared budget. This is additional coverage, not an assertion already made by this test.                          |
| Cleanup             | The suite unmounts rendered components; its listener assertion checks teardown.                                                                                                                             |
| Regression link     | Link the test above and its exact test name.                                                                                                                                                                |

This mapping demonstrates template fit by reading an existing test. It is not a run
result or a newly approved product requirement. A production scenario must also link
its accepted behavior source; this component test cannot establish full application QA.

## Pilot follow-ups

After feature selection, start with three representative journeys: persisted behavior,
permissions/multiplayer, and execution lifecycle. Use them to refine setup and evidence
before adding seed/reset helpers, a full application runner, new CI lanes, additional
environment profiles, or a reusable skill. None of those is provisioned by this scaffold.

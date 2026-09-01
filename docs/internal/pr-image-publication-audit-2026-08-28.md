# Pull-request Docker image publication audit (2026-08-28)

## Decision

Pull requests build the `production-source` image, load it into the job's local
Docker engine, and run the existing daemon health smoke test. They do not log in
to Docker Hub, publish `preset/agor` tags, or export a PR-scoped GitHub Actions
cache. Main, tag, and manual events retain their existing publication behavior.

This is a system-level CI resource change, not an application tenant-resource
change. It narrows writes to shared Docker Hub and Actions-cache infrastructure
and does not change any runtime tenant boundary.

## Revisions and audit scope

- Agor `main` and the audit branch both started at
  `e031ee50ad6eda0f881e994e4e9e02c41c942181`.
- External repositories inspected at their then-current `main`:
  - `preset-io/agor-cloud`:
    `401824d014a63d678ab7be872ac1d6fd99a4d151`
  - `preset-io/agor-k8s-poc`:
    `4c4eb04ac310d9c98c770f1827399ed5faf262a5`

The audit covered every workflow in `.github/workflows`, Dockerfiles and Compose
files, `.agor.yml`, environment-manager commands, scripts, package/install
tests, release and promotion workflows, docs, repository rules/protection,
recent Actions job logs, Docker Hub authentication behavior, and discoverable
Preset repositories and GitHub code references.

On pull requests the image job is an independent workflow job: no CI, smoke,
package, deployment, or promotion job declares it as a dependency. The only
`needs: build` edge is `promote-main`, which is restricted to the successful
main `workflow_run` event. No reusable workflow consumes the standalone image.
Classic branch protection had no required status checks, and the active `main`
ruleset required a pull request but declared no status-check rule. The workflow
and job names nevertheless remain `Build image / Build & push` to avoid breaking
dashboards or a future protection rule outside the inspected configuration.

## Consumer trace

| Consumer                                 | Image flow                                                                                                                                           | Needs PR `preset/agor` tag? |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| PR image CI                              | Builds `docker/Dockerfile` target `production-source`, loads `preset/agor:smoke`, starts it, and checks `/health` in the same job                    | No                          |
| Managed sqlite/sandbox/demo environments | `.agor.yml` runs local Compose with `--build`; `docker-compose.yml` builds target `development` from the branch worktree                             | No                          |
| Managed postgres/rich/full environments  | Same local source build plus a local Postgres service                                                                                                | No                          |
| Managed HA environment                   | Builds local `agor-ha-source:latest` target `production-source-ha`; pulls only third-party Node, Redis, and nginx bases                              | No                          |
| Managed docs environment                 | Builds `apps/agor-docs/Dockerfile` from the branch worktree                                                                                          | No                          |
| Local development and Docker tests       | `pnpm dev`, local Compose builds, or locally named test images                                                                                       | No                          |
| Packaged `agor-live` install/smoke       | Builds npm tarball artifacts, transfers them between jobs, and installs them into a temp home                                                        | No                          |
| Main/release promotion                   | Successful main CI publishes immutable full-SHA `preset/agor`, then serially retags it `main`/`latest`; tag/manual runs publish SHA/semver outputs   | Yes, but not a PR tag       |
| `agor-cloud`                             | Independently checks out an exact Agor SHA and publishes private `preset/agor-daemon`, `preset/agor-executor`, and `preset/agor-ui` component images | No                          |
| `agor-k8s-poc`                           | Builds/publishes the same three component-image families; local Kind flows load local images with `pullPolicy: Never`                                | No                          |

The only checked-in standalone `preset/agor` runtime reference was the producer
workflow itself. No exact `preset/agor:pr-*` code reference was discoverable in
Preset repositories or public GitHub code search. Docker Hub reports the
repository as private to anonymous clients, so any undocumented pull would also
need separate credentials. Private/manual consumers and Docker Hub pull
analytics remain outside the evidence available to repository code and Actions
metadata.

## Measured Actions cost

The sample is the 35 most recent successful PR image jobs on 2026-08-28. Step
durations come from the Actions API; BuildKit phase durations come from raw job
logs. The surrounding 80 recent PR runs comprised 54 successes, 19
cancellations, 6 build failures, and 1 in progress.

All 35 successful jobs found a GHA cache manifest, so the recent window has no
statistically valid fully cold-cache cohort from which to report a cold p50/p90.
It does provide a consistent and more relevant split: every job was
manifest-warm, but the changed-source builder layer was a cache miss in all 35.
Older cold runs were not mixed into the distribution because the Dockerfile and
dependency graph have changed since then.

| Duration                                          |     p50 |     p90 |    Mean |
| ------------------------------------------------- | ------: | ------: | ------: |
| Whole image job                                   |   603 s |   746 s | 636.5 s |
| Local image build/load                            |   549 s |   683 s | 583.0 s |
| Docker Hub login + metadata + runnable-image push |    14 s |    19 s |  14.8 s |
| Runnable-image push step alone                    |    12 s |    17 s |  13.2 s |
| GHA `mode=max` cache export                       | 314.5 s | 430.4 s |       — |
| Projected PR job without publication/cache export | 284.1 s | 298.9 s | 280.6 s |

Docker Hub publication itself was not the large delay: the second Buildx
invocation reused the just-built layers and usually finished in seconds. The
dominant side-effect was Buildx's `cache-to` export. All 35 jobs imported a
cache manifest, but all 35 rebuilt the source-builder `RUN` layer because the
preceding `COPY . .` changes with PR source. That layer alone took p50 169.3 s
and p90 178.6 s before the cache was exported again.

In the paired sample, removing PR cache export and registry publication saves a
median 318.9 s and p90 447.1 s. The 35 jobs consumed 371.3 runner-minutes;
199.0 were cache export and 8.65 were direct publication. The projected total
is 163.7 runner-minutes. During the sampled burst (about 36 successful image
jobs/day), that is roughly 197 runner-minutes/day reclaimed if the rate
continued. Public-repository standard GitHub-hosted runner minutes are not
billed, so this is queue/feedback/resource time rather than a claimed invoice
saving.

The repository's current Actions-cache snapshot held 12.0 GiB across 58
entries. A representative PR cache was 2,359,532,682 bytes (2.197 GiB), scoped
to `refs/pull/2544/merge`; its largest intermediate layer was 1,939,355,832
bytes. BuildKit logs do not report exact Docker Hub wire bytes and private Hub
analytics were unavailable. The locally loaded runtime layers were about 485 MB
uncompressed, but registry compression and layer deduplication make that an
invalid upload-bandwidth estimate.

Ordinary Docker Hub pull limits did not explain PR time: these jobs publish
rather than consume, and the repository requires authentication for a pull.
The practical registry costs were latency, storage/tag churn, and use of a
shared-namespace write credential. The GHA cache backend has separate API
throttling and storage behavior; it accounted for the measured large transfer.

The image job was the last completed check for 25/35 sampled commits (71.4%).
When last, it finished p50 198 s and p90 340 s after the final non-image check.
The push itself blocked nothing downstream on PRs; it merely extended this
independent job/check. The main promotion job depends on the build job and is
unchanged.

## Cache, fork, and supply-chain findings

- A GHA cache export is not a runnable image publication. `cache-to: type=gha`
  uploads BuildKit cache records; `push: true` publishes an OCI image and its
  tags to Docker Hub. This change disables both PR writes independently while
  keeping `cache-from` restore.
- GitHub scopes PR caches to `refs/pull/<n>/merge`; they cannot update the
  default-branch cache. PRs can continue restoring the trusted main cache.
- Fork PR run `33110651714` built and passed the identical local smoke without
  registry secrets or publication. Its max-cache export took 627.4 s. This is
  direct evidence that Docker Hub is not required for PR coverage.
- GitHub withholds repository secrets from fork and Dependabot PRs. Same-repo
  PR workflows previously received a Docker Hub write token even though no
  consumer used their tags. Because the workflow file is PR-controlled, that
  needlessly increased credential-exfiltration and shared-namespace risk.
- `pr-<number>` tags were mutable. Full-SHA tags were operationally treated as
  immutable but Docker tags are overwriteable without separate enforcement.
- Buildx emitted provenance attestations for pushed images. The workflow has no
  explicit SBOM generation or cosign/Notation signature. Removing unused PR
  artifacts reduces the unsigned/unpromoted supply-chain surface; main and
  release provenance behavior is unchanged.
- The current PR cache is unsigned, generated from untrusted code, large, and
  branch-local. Avoiding PR cache writes also removes a low-trust cache-poisoning
  input without exposing any secret to the build.

## Rollout, rollback, and residual risk

The check and job names remain `Build image / Build & push`, and the same
`production-source` image still boots and passes `/health` before any non-PR
publication. A deterministic repository script enforces those facts and fails
if a checked-in standalone `preset/agor` consumer appears elsewhere.

Roll back by reverting the workflow guards and PR `cache-to` condition. If a
real cross-job consumer emerges, prefer a same-job local load/smoke (current), a
workflow artifact for a later job, or an explicitly short-lived registry tag
with least-privilege credentials and cleanup over permanent PR tags in the
shared namespace.

Residual risks are undocumented private/manual consumers, future external
repositories that do not land in code search, and possible slower repeated
builds for a PR that changes dependency inputs while main's trusted cache stays
stale. The deterministic scan detects new checked-in consumers, and the change
can be reverted without changing image formats or release tags. Confidence is
high for checked-in and discoverable consumers, and medium-high overall because
private Docker Hub pull analytics were unavailable.

## Validation

- `pnpm check:image-publication-policy`
- `node --check scripts/check-image-publication-policy.mjs`
- Biome check of the policy script and Prettier check of the changed YAML,
  JSON, and Markdown
- PyYAML parse of all 10 workflow files
- actionlint 1.7.12 over all workflows, suppressing only the pre-existing
  `concurrency.queue` diagnostic; unfiltered actionlint reported that identical
  single diagnostic on both starting `main` and the changed workflow

The live PR workflow remains the end-to-end Docker build/boot validation. No
local package or Docker build was run as part of this workflow-only change.

## References

- [Workflow introduction and design discussion](https://github.com/preset-io/agor/pull/1902)
- [Fork/Dependabot secret guard](https://github.com/preset-io/agor/pull/1966)
- [Main image promotion hardening](https://github.com/preset-io/agor/pull/2382)
- [GitHub cache matching and PR scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- [Docker Buildx GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/)
- [GitHub Actions secret availability](https://docs.github.com/en/code-security/reference/secret-security/secret-types)
- [Docker Hub pull accounting and limits](https://docs.docker.com/docker-hub/usage/pulls/)

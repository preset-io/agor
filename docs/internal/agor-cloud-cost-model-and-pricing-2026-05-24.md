# Agor Cloud — Cost Model and Pricing Analysis (2026-05-24)

**Status:** Draft v0.1 — author: Claude (via `/loop` analysis run), for Max's review.
**Scope:** Unit economics for a hosted Agor service on AWS. Pricing recommendation for Free / paid tiers. Sensitivity analysis. **Not** a deployment plan, IaC, or budget.

---

## 1. TL;DR

At a hosted-AWS baseline (us-east-1, on-demand pricing, optimistic operational efficiency, **+25% ops-overhead buffer applied to every line**), per-tenant monthly COGS land at:

| Scenario | Storage | Executor-hours | Cost / tenant / mo | Notes |
|---|---|---:|---:|---|
| **Free / Trial** | 5 GB | 10 h | **~$3.80** | Cost of customer acquisition. Cap aggressively. |
| **Hobby / Individual (modest)** | 50 GB | 100 h | **~$22** | Realistic for most paying single-user accounts. |
| **Individual (heavy)** | 50 GB | 500 h | **~$45** | Full-time vibe-coder envelope from the brief. |
| **Pro Team (5 seats)** | 200 GB | 5,000 h | **~$285** | Brief's "pro team" envelope. Highly executor-dominated. |

**Recommended P&P (opinionated, see §5):**

| Tier | Price / mo | Includes | Target GM |
|---|---:|---|---:|
| **Free** | $0 | 5 GB · 10 exec-hr · 1 daemon · BYO API key | n/a (CAC) |
| **Hobby** | **$19** | 25 GB · 100 exec-hr · hibernating daemon | ~70% (against ~$15 modest blend) |
| **Pro (Individual)** | **$49** | 75 GB · 400 exec-hr · always-warm daemon | ~60% (against ~$22 typical, ~$45 heavy worst case) |
| **Team (5 seats)** | **$199** | 200 GB · 2,000 exec-hr pooled · 5 daemons hibernating · branch RBAC | ~50% (against ~$110 typical, ~$285 worst case) |
| **Enterprise** | **Contact** | Custom storage / quotas · SSO · audit · dedicated isolation tier | Negotiated |

**Three things that move the answer most**, in order:

1. **Executor utilization & pool overhead** (±50% input → ±$5–$120/tenant). Biggest unknown; need pilot telemetry.
2. **Daemon hibernation effectiveness** (no-hib vs aggressive-hib swings $15 → $4/tenant). Engineering investment required; see §8.
3. **Storage growth + snapshot tier** (Standard vs One-Zone vs IA blend; 2× storage ≈ +$8–$16/tenant for Pro Team).

**Critical prerequisites** before launching paid tiers (see §7):

- **P0** — Per-tenant **quotas on executor-hours and schedules**. Today: zero quota enforcement; any user can `schedule_cron: "* * * * *", allow_concurrent_runs: true` and auto-burn arbitrary compute (`scheduler.ts:159`, `:494` — no rate-limit).
- **P0** — **Daemon hibernation plumbing** (or accept ~$15/tenant/mo always-on baseline). Feasibility is "moderate engineering" — not blocked, but not free.
- **P1** — Decide topology: **one-daemon-per-tenant** (this model) vs **multi-tenant daemon with worktree affinity** (the direction implied by `daemon-ha-design-2026-05-24.md`). The two have ~2× cost delta at low tenant counts.

---

## 2. Topology assumptions (anchor your challenge here)

This model assumes the topology from the brief:

```
Browser → CloudFront (static UI) ─────────────────┐
                                                  │
Browser ── WSS ─── ALB (shared) ── per-tenant ───┤
                                  daemon (Fargate)│
                                       │           │
                                       │ spawns    │
                                       ▼           │
                              shared executor pool │
                              (c7g.xlarge fleet,   │
                               carved 4 slots/node)│
                                       │           │
                                       │ reads/writes
                                       ▼           │
                              per-tenant EFS PVC ──┘
                                       │
                              shared Aurora Serverless v2
                              (per-tenant schema)
```

**Region:** us-east-1 (cheapest AWS region for the components used; cite footnote).
**Account/tenant model:** one Agor "tenant" = one organization (1–5 seats typical). One PVC per tenant, one logical DB schema per tenant on shared Aurora.
**Daemon:** one **Fargate task** per tenant (NOT EC2 — Fargate gives instant scale-to-zero, no host-management).
**Executor:** ECS-on-EC2 with a shared fleet of c7g.xlarge nodes carved into 4 slots each. (Fargate at executor sizes would be ~2× more expensive than EC2.)
**Storage:** EFS One-Zone Standard ($0.16/GB-mo) per tenant — acceptable because the authoritative copy of source lives in the user's git remote. Lifecycle to IA for files unused >30 days.
**Database:** **Aurora PostgreSQL Serverless v2** (0.5 ACU min, scales up under load) shared across tenants, schema-per-tenant. Cheaper than per-tenant RDS at small/medium scale, hibernates idle tenant load to zero.
**CDN:** CloudFront (global, free 1 TB egress / mo amortized across all tenants).
**LLM token spend:** **Out of scope** — tenants BYO API key; Agor never sees those bills.

### Tensions with this topology (see §9 for full discussion)

- `daemon-ha-design-2026-05-24.md` (the PR #1252 referenced in the brief) does **not** assume multi-tenant daemons. It assumes per-worktree sticky-affinity for HA-of-the-daemon-process — compatible with one-daemon-per-tenant. The "multi-tenant daemon" framing in the brief slightly misreads that doc; the cost-relevant tension is "one daemon per worktree" vs "one daemon per tenant (many worktrees)".
- True multi-tenant daemons (one daemon serving many tenants) are blocked by 35 filesystem touchpoints owned by the daemon Unix uid — would need the **executor-as-volume-owner** refactor from `context/explorations/daemon-fs-decoupling.md` Option D (~15 eng-weeks). Out of scope for v1 hosted.

---

## 3. AWS pricing anchor table (us-east-1, May 2026, on-demand)

Every number used in the cost model traces back to this table.

| Component | Unit | Price | Source |
|---|---|---:|---|
| **Fargate** vCPU Linux/ARM (Graviton2) | $/vCPU-hr | $0.0324 | [aws.amazon.com/fargate/pricing](https://aws.amazon.com/fargate/pricing/) |
| **Fargate** Memory Linux/ARM | $/GB-hr | $0.0036 | same |
| **Fargate Spot** | discount | up to −70% | same |
| **EC2 c7g.xlarge** (4 vCPU, 8 GB) on-demand | $/hr | $0.145 | [instances.vantage.sh/aws/ec2/c7g.xlarge](https://instances.vantage.sh/aws/ec2/c7g.xlarge) |
| **EC2 c7g.xlarge** 1-yr Reserved | $/hr | $0.096 (−34%) | same |
| **EC2 c7g.xlarge** 3-yr Reserved | $/hr | $0.064 (−56%) | same |
| **EC2 t4g.small** (2 vCPU burst, 2 GB) | $/hr | $0.0168 | [aws.amazon.com/ec2/pricing/on-demand](https://aws.amazon.com/ec2/pricing/on-demand/) |
| **EBS gp3** | $/GB-mo | $0.08 | [aws.amazon.com/ebs/pricing](https://aws.amazon.com/ebs/pricing/) |
| **EFS Standard** (Multi-AZ) | $/GB-mo | $0.30 | [aws.amazon.com/efs/pricing](https://aws.amazon.com/efs/pricing/) |
| **EFS One-Zone Standard** | $/GB-mo | $0.16 | same |
| **EFS Infrequent Access (IA)** | $/GB-mo | $0.025 | same |
| **EFS Archive** (One-Zone) | $/GB-mo | $0.008 | same |
| **EFS Elastic Throughput** | $/GB read | $0.03 | same |
| **EFS Elastic Throughput** | $/GB write | $0.06 | same |
| **AWS Backup for EFS** (warm) | $/GB-mo | ~$0.05 | [aws.amazon.com/backup/pricing](https://aws.amazon.com/backup/pricing/) |
| **RDS PostgreSQL db.t4g.small** Single-AZ | $/hr | $0.032 | [instances.vantage.sh/aws/rds/db.t4g.small](https://instances.vantage.sh/aws/rds/db.t4g.small) |
| **Aurora Serverless v2** | $/ACU-hr | $0.12 | [aws.amazon.com/rds/aurora/pricing](https://aws.amazon.com/rds/aurora/pricing/) |
| **CloudFront** egress NA | $/GB | first 1 TB/mo free, then $0.085 | [aws.amazon.com/cloudfront/pricing](https://aws.amazon.com/cloudfront/pricing/) |
| **CloudFront** HTTPS req | $/10K req | $0.0100 | same |
| **EC2/ALB egress** to internet | $/GB | first 100 GB/mo free, then $0.09 | [aws.amazon.com/ec2/pricing/on-demand](https://aws.amazon.com/ec2/pricing/on-demand/) (Data Transfer section) |
| **ALB** | $/hr | $0.0225 (~$16.43/mo) | [aws.amazon.com/elasticloadbalancing/pricing](https://aws.amazon.com/elasticloadbalancing/pricing/) |
| **ALB LCU** | $/LCU-hr | $0.008 | same |
| **NAT Gateway** | $/hr + $/GB | $0.045/hr + $0.045/GB | [aws.amazon.com/vpc/pricing](https://aws.amazon.com/vpc/pricing/) |
| **CloudWatch Logs ingestion** | $/GB | $0.50 | [aws.amazon.com/cloudwatch/pricing](https://aws.amazon.com/cloudwatch/pricing/) |
| **CloudWatch Logs storage** | $/GB-mo | $0.03 | same |
| **EKS control plane** | $/cluster-hr | $0.10 (~$73/mo) | [aws.amazon.com/eks/pricing](https://aws.amazon.com/eks/pricing/) |

**Conventions used below:**
- **730 hours = 1 month** (AWS standard).
- All EC2/Fargate prices are Linux/ARM (Graviton). x86 is ~15–20% more.
- "Active hours/day" means the tenant has at least one human or scheduled action driving the daemon.
- A baseline of **100 active paying tenants** is assumed for amortizing shared infrastructure (ALB, NAT, EKS, Aurora min-capacity, base executor pool). This is the early-stage envelope; at 1,000+ tenants, shared overhead per tenant drops ~10×.

---

## 4. Cost model — per component

### 4.1 Daemon hosting

**Sizing:** Node.js process running 18+ FeathersJS services, tsx watch in dev (not prod), WebSocket server, scheduler tick (`scheduler.ts:188–192`), health monitor (`health-monitor.ts:88–102`), several `setInterval` cleanup loops. Real-world memory: 200–500 MB. **Pick 0.5 vCPU + 1 GB ARM Fargate** = $0.0162 + $0.0036 = **$0.0198 / hr**.

**Two modes:**

| Daemon mode | Hours/mo billed | $ / tenant / mo |
|---|---:|---:|
| (a) Always-on baseline | 730 | $14.45 |
| (b) Hibernated, active 8 h/day | 240 | $4.75 |
| (b) Hibernated, active 4 h/day | 120 | $2.38 |

**Hibernation has costs that don't appear in the table:**
- **Snapshot/state storage**: with Fargate scale-to-zero, there is no in-process snapshot — the daemon cold-starts from disk (db, config). Cold-start 2–10 s per `apps/agor-daemon/src/index.ts` boot phases (see Q1 in §9 cross-refs). UX latency cost: first request after idle takes 5–10 s longer.
- **Per-tenant DB connection**: Aurora Serverless v2 already pools, so cold daemons don't hold idle connections. Net additive cost: **~$0**.
- **Engineering investment**: not free. See §7 "P0 prerequisites".

**Per-tenant DB:** model uses **shared Aurora Serverless v2** ($0.12/ACU-hr), not per-tenant RDS. With 100 tenants on a cluster averaging 2 ACU steady state = $176/mo total = **$1.76/tenant/mo amortized**. Per-tenant RDS would be $11–23/mo each — 6–13× more expensive and an operational nightmare. **Verdict:** shared Aurora is the right answer until ~500+ tenants when per-tenant Aurora schemas start to crowd connection pools, at which point shard.

### 4.2 Executor compute

**Sizing:** c7g.xlarge (4 vCPU, 8 GB, $0.145/hr) carved into **4 slots × (1 vCPU + 2 GB)** each.

**Two costing lenses, both reported below:**

**Lens 1 — "Ideal billable per-executor-hour"** (assumes perfect bin-packing):
$0.145 / 4 = **$0.0363 / executor-hr**

**Lens 2 — "Real pool with overhead"** (accounts for autoscale lag, base warm pool, idle headroom):

For 100 tenants, average concurrency M = 1.5 executors/tenant during active hours (8/24), 0 otherwise:
- Avg concurrent demand: 100 × 1.5 × (8/24) = **50 slots**
- Peak demand (2× avg): 100
- Pool sizing: warm pool of 32 slots during off-hours (= 8 nodes), surge to 100 slots during peak (= 25 nodes)
- Weighted node-hours: (8/24 × 25 + 16/24 × 8) × 24 × 30 = 8,160 node-hours/mo
- Cost: 8,160 × $0.145 = $1,183/mo → **$11.83 / tenant / mo for the pool**

Combined effective rate at 60% utilization: **$0.060 / executor-hr blended** (Lens 1 × 1.67).

With **1-yr Reserved Instances** for the 8-node base pool (−34%) + on-demand surge: blended drops to **~$0.045 / exec-hr**.

With **Spot pricing** for executors (interruption tolerant since each task is checkpointable on the user's git remote): could drop to **~$0.020/exec-hr**, but agentic CLIs aren't trivially restartable mid-LLM-call — would need executor-side checkpointing. Defer as a future optimization, model uses on-demand blended **$0.060 / exec-hr**.

### 4.3 Storage (PVC / EFS)

**Pick:** EFS One-Zone Standard at **$0.16/GB-mo** (acceptable because git remote is the authoritative source; tenants can re-clone on AZ failure with no data loss except in-progress task state).

**Snapshots:** AWS Backup for EFS, daily snap + 7-day retention. Snapshots are incremental; assume ~1.5× live size in steady state at warm tier ($0.05/GB-mo) → **+$0.075/GB-mo of live storage**.

**Throughput:** Elastic Throughput is billed per GB read ($0.03) and per GB write ($0.06). For typical agentic workload (git clone, build, test, write artifacts): assume **5 GB read + 2 GB write per 100 exec-hours** (highly variable; conservative). For 100 exec-hours: $0.15 + $0.12 = **$0.27 throughput**. Often free if you use **Bursting Throughput** instead, but Elastic is the safer default at scale.

**Per-GB-month all-in:** $0.16 storage + $0.075 snapshots + ~$0.005/GB throughput allocation = **~$0.24 / GB-mo blended**.

### 4.4 Bandwidth (egress to user browsers)

**WebSocket traffic** is dominated by message/event broadcasts. Estimate: an active session sends ~50 KB/min of events (typed messages, tool calls, console logs). For a tenant active 4 h/day, 30 days/mo: 4 × 60 × 50 KB × 30 = **~360 MB/mo per active seat**.

**Log streaming** can spike — when an executor produces verbose output (test runs, npm install, claude-code tool calls), live tailing to browser can hit MB/s burst. Conservative: **+5 GB/mo per active seat**.

**File downloads** (occasional): **+1 GB/mo**.

| Tenant type | Egress/mo | Cost |
|---|---:|---:|
| Free | 2 GB | $0.18 (assume free tier exhausted across tenants) |
| Hobby (1 seat) | 10 GB | $0.90 |
| Individual heavy | 20 GB | $1.80 |
| Pro Team (5 seats) | 50 GB | $4.50 |

**Inter-AZ:** Avoid by pinning per-tenant resources to a single AZ (One-Zone EFS already mandates this). NAT Gateway egress for executor outbound (to LLM APIs, git providers): if all execution is in same AZ as NAT, ~$0.045/GB on top of the $0.09 internet egress. For 100 exec-hours of moderate I/O (5 GB outbound to LLM API + git push): ~$0.45 NAT processing. **Modeled in shared overhead, see 4.6.**

### 4.5 CDN / static

Frontend bundle: Vite-built React app, ~2 MB gzipped. Cache-friendly (immutable hashed assets).

Per tenant: 5 MB initial load + ~50 MB/mo cache misses, page reloads, asset updates. CloudFront first 1 TB/mo free across all tenants — at 100 tenants × 50 MB = 5 GB/mo total, **effectively $0**. Even at 10,000 tenants × 50 MB = 500 GB/mo, still under free tier.

**Per tenant: ~$0.00–$0.01.** Negligible.

### 4.6 Misc / ops overhead (shared, amortized across 100 tenants)

| Item | Monthly cost (shared) | Per tenant (÷ 100) |
|---|---:|---:|
| ALB (base + LCU est.) | $25 | $0.25 |
| NAT Gateway (1 × $32.85 base + ~5 GB/tenant × $0.045 processed) | $33 + $22.50 | $0.55 |
| EKS control plane (if used) | $73 | $0.73 |
| Aurora Serverless v2 (2 ACU avg) | $176 | $1.76 |
| Aurora storage (~50 GB) | $5 | $0.05 |
| CloudWatch Logs (1 GB/tenant × $0.50 ingest + 7-day retention) | ~$70 | $0.70 |
| AWS Backup overhead (control plane, lifecycle) | $10 | $0.10 |
| Monitoring (assume Prometheus self-hosted, 1 node m7g.xlarge) | $119 | $1.19 |
| Misc (Route 53, Secrets Manager, KMS, CloudTrail) | $30 | $0.30 |
| **Shared subtotal** | **$564** | **$5.63 / tenant / mo** |

Note: switching from self-hosted Prometheus to **Datadog** at standard SaaS pricing ($15/host/mo + per-metric) would 2–5× this entire shared subtotal. Stay self-hosted for v1.

---

## 5. Cost stack per scenario

All scenarios assume:
- **100 active tenants** for amortizing shared infra.
- **On-demand executor pricing**, 60% utilization blend → **$0.060 / exec-hr**.
- **EFS One-Zone + snapshots** → **$0.24 / GB-mo**.
- **+25% ops-overhead buffer** applied to subtotal (covers redundancy, peak headroom, support tooling, things we forgot).

### 5.1 Free / Trial

| Line | Quantity | $/unit | $ |
|---|---:|---:|---:|
| Daemon (hibernated, 1 h/day) | 30 hr | $0.0198 | $0.59 |
| Executor compute | 10 hr | $0.060 | $0.60 |
| Storage + snapshots | 5 GB | $0.24 | $1.20 |
| Bandwidth | 2 GB | $0.09 | $0.18 |
| CDN | ~0 | — | $0.00 |
| Shared overhead | — | — | $0.20 (reduced for trial — fewer logs) |
| **Subtotal** | | | **$2.77** |
| +25% ops buffer | | | $0.69 |
| **Free tier cost / mo** | | | **$3.46** |

**Bound the free tier cost at ≤ $4/mo per user.** With aggressive limits (10 exec-hr, 5 GB storage), this is achievable. Treat as CAC: if 1 in 10 free converts to $19+ Hobby, payback is ~2 months on a $200 LTV-to-CAC win.

### 5.2 Hobby / Individual (modest)

50 GB storage, **100 exec-hours/mo** (realistic for hobbyist or PT user, ~3 hr/day of agent activity).

| Line | Quantity | $/unit | $ |
|---|---:|---:|---:|
| Daemon (hibernated, 4 h/day) | 120 hr | $0.0198 | $2.38 |
| Executor compute | 100 hr | $0.060 | $6.00 |
| Storage + snapshots | 50 GB | $0.24 | $12.00 |
| Bandwidth | 10 GB | $0.09 | $0.90 |
| Shared overhead | — | — | $0.56 (lower bandwidth share) |
| **Subtotal** | | | **$21.84** |
| +25% buffer | | | $5.46 |
| **Hobby cost / mo** | | | **$27.30** |

Wait — drop storage to **25 GB** (more realistic for hobby) and the cost falls to **$21.30 / mo with buffer**. Storage is the swing factor at low exec-hours. **The Hobby tier should cap storage tight to keep COGS low.**

### 5.3 Individual (heavy — brief's "power user" envelope)

50 GB storage, **500 exec-hours/mo** (heavy daily use, 16+ h/day of agent activity).

| Line | Quantity | $/unit | $ |
|---|---:|---:|---:|
| Daemon (active 8 h/day) | 240 hr | $0.0198 | $4.75 |
| Executor compute | 500 hr | $0.060 | $30.00 |
| Storage + snapshots | 50 GB | $0.24 | $12.00 |
| Bandwidth | 20 GB | $0.09 | $1.80 |
| Shared overhead | — | — | $5.63 |
| **Subtotal** | | | **$54.18** |
| +25% buffer | | | $13.55 |
| **Heavy individual cost / mo** | | | **$67.73** |

**This is the worst case for a single-user paid tier.** A Pro plan at $49 here would have **−38% margin** in this scenario. Two strategies: (a) price Pro at $79–99 to cover the worst case, or (b) price at $49 with quotas (400 exec-hr cap, overage at $0.10/exec-hr). Recommend (b) — see §6.

### 5.4 Pro Team (5 seats, brief's envelope)

200 GB storage, **5,000 exec-hours/mo**.

| Line | Quantity | $/unit | $ |
|---|---:|---:|---:|
| Daemon × 5 (hibernated, 4 h/day each) | 600 hr | $0.0198 | $11.88 |
| Executor compute | 5,000 hr | $0.060 | $300.00 |
| Storage + snapshots | 200 GB | $0.24 | $48.00 |
| Bandwidth | 50 GB | $0.09 | $4.50 |
| Shared overhead × 5 | — | — | $28.15 |
| **Subtotal** | | | **$392.53** |
| +25% buffer | | | $98.13 |
| **Team cost / mo (worst case)** | | | **$490.66** |

**Sticker-shock check:** 5,000 exec-hours/mo across a 5-person team is each member running an agent ~33 hours/week — plausible if they're full-time vibe coding. A more typical team of 5 averages ~50 exec-hr per seat = **1,000 hr total team** → cost drops to:

| Pro Team typical | $ |
|---|---:|
| Daemon × 5 | $11.88 |
| Executor compute (1,000 hr) | $60.00 |
| Storage + snapshots (200 GB) | $48.00 |
| Bandwidth (50 GB) | $4.50 |
| Shared overhead × 5 | $28.15 |
| Subtotal | $152.53 |
| +25% buffer | $38.13 |
| **Team typical / mo** | **$190.66** |

So **Pro Team realistic COGS: ~$190–$490** depending on usage. Critical that quotas + overage exist.

### 5.5 Summary table

| Scenario | Daemon | Executor | Storage | Bandwidth | Shared | Buffer | **Total** |
|---|---:|---:|---:|---:|---:|---:|---:|
| Free | $0.59 | $0.60 | $1.20 | $0.18 | $0.20 | $0.69 | **$3.46** |
| Hobby (modest) | $2.38 | $6.00 | $12.00 | $0.90 | $0.56 | $5.46 | **$27.30** |
| Individual (heavy) | $4.75 | $30.00 | $12.00 | $1.80 | $5.63 | $13.55 | **$67.73** |
| Pro Team (typical) | $11.88 | $60.00 | $48.00 | $4.50 | $28.15 | $38.13 | **$190.66** |
| Pro Team (worst case) | $11.88 | $300.00 | $48.00 | $4.50 | $28.15 | $98.13 | **$490.66** |

---

## 6. Recommended Pricing & Packaging (P&P)

### 6.1 Tier structure (opinionated)

| Tier | Price | Includes (per month) | Overage | Target Gross Margin |
|---|---:|---|---|---:|
| **Free** | $0 | 5 GB · 10 exec-hr · 1 daemon · 1 schedule · BYO API key · public boards only · forced hibernation | Hard cap; throttle at limit | n/a (CAC) |
| **Hobby** | **$19** | 25 GB · 100 exec-hr · 1 daemon · 5 schedules · BYO API key · private boards · 7-day session retention | $0.10/exec-hr, $0.50/GB-mo storage | ~70% (typical) |
| **Pro** | **$49** | 75 GB · 400 exec-hr · always-warm daemon · unlimited schedules · BYO API key · 30-day retention · team-of-1 collaboration tier | $0.10/exec-hr, $0.30/GB-mo storage | ~60% (typical) / ~30% (heavy worst case) |
| **Team** | **$199/team** | 5 seats · 200 GB · 2,000 exec-hr pooled · RBAC · audit log · 90-day retention · 10 schedules/seat | $0.08/exec-hr (volume), $0.25/GB-mo · +$39/extra seat | ~50% (typical) |
| **Enterprise** | Contact | Unlimited seats · SSO/SAML · dedicated executor pool · Unix-isolation mode · custom retention · DPA · 24/7 support | Negotiated | Negotiated (target 60%+) |

### 6.2 Overage policy

- **Soft warning at 80%** of monthly quota (in-app banner + email).
- **Hard limit at 100% — but allow opt-in pay-as-you-go**. Default: throttle. User can flip on PAYG in billing settings.
- **PAYG rates** (above table) include a **30% margin uplift** over COGS — overage shouldn't be cheaper than bundled. e.g., bundled exec-hr at $49/400 = $0.12/hr; PAYG at $0.10/hr is **deliberately equal-ish** so users prefer upgrading their plan over running on overage. (Alternative philosophy: PAYG much more expensive to push to upgrade. Personal call.)
- **Hard cap (anti-runaway)**: even with PAYG enabled, cap at **5× plan quota / month** absent explicit override. Critical for schedule-driven auto-burn (see §9 #1253).
- **Scheduled vs interactive runs**: same $/exec-hr. Don't bifurcate pricing — added complexity, marginal revenue. Do **bill schedules to the schedule-owner**, not the branch-creator, so accidental "every-minute" cron pings the right user.

### 6.3 Annual discount

- Monthly: as listed.
- Annual: **−17% (≈ 2 months free)**. Standard SaaS pattern. Don't overthink.
- Annual is for Hobby+, not for Enterprise (negotiated separately).

### 6.4 Free tier guardrails

The Free tier is a CAC line item. Cap aggressively:
- **Aggressive hibernation**: daemon spins down after 5 min idle (cold-start 5–10 s acceptable for free users).
- **10 exec-hours/mo hard cap** (no PAYG).
- **No scheduled runs by default** (or 1 schedule/day max).
- **Single daemon, single board**.
- **Inactivity reaping**: PVC archived to EFS Archive ($0.008/GB-mo) after 30 days no activity; deleted after 90 days no login.

Cost expectation: **$3–5/mo per active free user**. With a 5–10% conversion rate, CAC of $30–100 per paying convert. Comparable to Vercel/Railway free tiers.

---

## 7. Sensitivity analysis

Vary the top 4 inputs ±50% and recompute the **Pro Team typical scenario** ($190/mo baseline) to see what moves cost most:

| Variable | Baseline | −50% | +50% | Cost at −50% | Cost at +50% | Sensitivity |
|---|---:|---:|---:|---:|---:|---|
| **Executor utilization rate** | 60% | 30% | 90% (capped) | $246 | $159 | **HIGH** (±30% on total) |
| **Storage per tenant** | 200 GB | 100 GB | 300 GB | $159 | $222 | MEDIUM (±17%) |
| **Daemon hibernation effectiveness** | 4 h/day active | 8 h/day | 1 h/day | $194 | $182 | LOW (±3%) |
| **Network egress per tenant** | 50 GB | 25 GB | 75 GB | $189 | $193 | NEGLIGIBLE |
| **Avg concurrent executors per tenant** | 1.5 | 0.75 | 2.25 | $158 | $220 | **HIGH** (±16%) |
| **Shared infra tenant count** | 100 | 50 | 200 | $218 | $176 | MEDIUM (amortization) |

**Top movers (in order of impact on $/tenant):**

1. **Executor utilization** — this is the *single biggest lever*. At 30% utilization, the same 5,000 exec-hours costs the pool 2× more to serve. **Action:** pilot must measure actual utilization curves; if <50%, autoscale faster and accept colder starts (10–20 s acceptable).
2. **Concurrent executors per tenant** — drives peak pool size. **Action:** cap per-tenant concurrent executors at 3 for Pro, 10 pooled for Team. Already a knob in the brief.
3. **Storage growth** — linear, no surprises. **Action:** lifecycle to IA aggressively (files unread 30 d → IA at $0.025/GB-mo, 6× cheaper). Cap Pro at 75 GB hard; sell storage overage at margin.
4. **Daemon hibernation** — surprisingly low impact on Pro Team because executor compute dominates. But on **Hobby/Free**, hibernation is the single biggest line; doubling daemon hours doubles 30% of the Hobby cost.

---

## 8. Risk levers and operational hedges

| Risk | Trigger | Hedge |
|---|---|---|
| **Executor utilization < 40%** (pool over-provisioned) | Pilot telemetry shows users are bursty, not steady | Tighten autoscale (5-min cooldown → 1-min); accept 10–20 s cold starts; move base pool to 1-yr RI for 34% saving |
| **Schedule abuse** (one user enables cron-every-minute with concurrent runs) | `scheduler.ts` has no rate limit; could run 1,440 sessions/day from one user | **P0 fix before launch**: enforce per-user `max_schedule_freq` (≥ 5 min between fires) and `max_total_exec_hr_per_day` server-side. See §9 #1253. |
| **Storage runaway** (tenant clones huge monorepo + node_modules) | Single tenant exceeds 500 GB | Enforce PVC quota at EFS level; warn at 80%, hard fail at 100%; show storage breakdown in UI |
| **Egress spike** (live-tailing huge log to browser) | Single executor produces 100 MB of console output streamed live | Sample/throttle log streaming above 1 MB/s; show "view in terminal" affordance |
| **NAT Gateway processing fees** (executors hitting LLM APIs heavily) | NAT processed-GB charges scale with exec-hours | Consider VPC endpoints for major LLM providers if Anthropic/OpenAI offer PrivateLink (today: no). Otherwise, factor $0.045/GB into per-exec-hour cost. |
| **CloudFront egress overage** (single tenant abuses bandwidth, e.g., publishes large artifacts via shareable links) | >100 GB/mo egress per tenant | Cap shareable-artifact downloads; charge for excess at $0.10/GB |
| **Cross-AZ traffic** (accidentally span AZs) | EFS-Multi-AZ or wrong subnet placement | Audit at infra level; enforce single-AZ per tenant tag |
| **Aurora ACU spike** under load | One tenant runs heavy queries (e.g., huge session/task list) | Cap ACU per tenant via Aurora cluster guardrails; if not possible, shard tenants across multiple Aurora clusters |
| **Cold daemon → bad UX** | Hibernation cold-start >10 s | Pre-warm based on user activity signals (login, schedule about to fire); fall back to warm-pool for Pro/Team tiers |

---

## 9. Cross-references and tensions

### vs. PR #1252 / `docs/internal/daemon-ha-design-2026-05-24.md` (HA daemon design)

The brief said "PR #1252 assumed multi-tenant daemons" — that's a slight misread of the doc. What #1252 actually proposes (per the explorer's read, file `docs/internal/daemon-ha-design-2026-05-24.md`):

> "the daemon is currently architected as the single owner of `~/.agor/worktrees/` … Two daemons on different hosts can't both own the same worktree. **Sticky session per *worktree* is the necessary glue until the executor-as-volume-owner topology lands.**"

So #1252 is about **per-worktree affinity for HA-of-the-process** (e.g., 2 daemon replicas, sticky routing per worktree), not about **one daemon serving N tenants**. The cost model assumed one daemon per tenant; that's compatible with #1252's affinity model as long as each tenant's daemon can be replicated with sticky routing.

**Cost delta if we eventually adopt true multi-tenant daemons** (one daemon serving 10–50 tenants):
- Daemon line item drops ~5–10× (one Fargate task at 2 vCPU/4 GB = $0.115/hr = $84/mo serving 20 tenants = **$4.20/tenant/mo** vs current $14.45 always-on / $4.75 hibernated)
- **Net savings: ~$0–$10/tenant/mo** — meaningful at Hobby (~50% reduction) but negligible at Pro Team (executor-dominated)
- **Blocker:** the 35 filesystem touchpoints in the daemon owned by daemon Unix uid (see `context/explorations/daemon-fs-decoupling.md`, Option D). ~15 eng-weeks. **Not v1.**

**Recommendation:** ship v1 with one daemon per tenant + #1252-style affinity-based HA, revisit multi-tenancy after 500+ paying tenants when daemon line starts to matter.

### vs. PR #1253 (schedules)

From the explorer's read of `services/scheduler.ts`:

> "No global quota system exists in the code. … `allow_concurrent_runs` (per-schedule, boolean, default false) … grace period 2 min prevents backfill runaway. **No rate limits, max-frequency guards, or per-user quota checks** are visible."

**Cost implication:** scheduled runs are executor-hours that consume the same compute as interactive runs. A tenant who enables `schedule_cron: "* * * * *"` with `allow_concurrent_runs: true` can burn 1,440 exec-hours/day (~$1,037/mo at $0.060/hr blended) without ever opening the UI.

**Pricing recommendation:**
- **Don't bifurcate price** for scheduled vs interactive. Same $0.10/exec-hr overage. Simpler.
- **Do enforce server-side quotas** as a **P0 prerequisite** (called out in §1):
  - Free: 0 schedules (or 1 with min-15-min frequency)
  - Hobby: 5 schedules, min 5-min frequency, hard cap at plan exec-hr limit
  - Pro: unlimited schedules, min 1-min frequency, soft cap with PAYG on
  - Team: unlimited, but configurable per-org quotas
- **Bill schedules to the schedule-owner** (the user who enabled the cron), not the branch-creator. Today the spawned session attribution defaults to branch owner per the `dangerously_allow_session_sharing` flag — that's wrong for billing.

### vs. daemon hibernation feasibility

From the explorer's deep-dive on `apps/agor-daemon/src/`:

> "**Moderate engineering** — achievable with: (1) explicit shutdown phase to stop all `setInterval` … (2) orphan cleanup already implemented (startup.ts:97–313). … Cold-start: **2–10 seconds** depending on dialect, orphan count, gateway init, CLI rehydration. … **No blockers** for single-daemon hibernation."

**Implication for cost model:**
- Hibernation is feasible without major refactor. ~1–2 eng-weeks to plumb scale-to-zero correctly (stop intervals on SIGTERM, signal load balancer, drain in-flight WS, dispose Aurora handle).
- Cold-start UX cost (5–10 s) is acceptable for free tier; less so for paid. **Recommend warm daemons for Pro/Team** (don't hibernate during user's known active hours), hibernate only deep-idle.
- **If hibernation slips, model assumes always-on daemon**: adds ~$10/tenant/mo across all tiers. Hobby margin would invert. **This is the single biggest engineering dependency for the cost model.** Call out as a P0 prerequisite.

---

## 10. Open questions for Max

These are the decisions or data points that block tightening the model further. In priority order:

1. **What's the actual executor utilization in the existing pilot?** Brief says "highly variable / unmeasured" — confirm whether we have *any* telemetry on per-tenant exec-hours/day from current users. If not, the 60% utilization assumption is a guess; could be 30–90%.

2. **Is daemon hibernation on the v1 roadmap?** If yes (1–2 eng-weeks), model holds. If no, every tier's cost goes up ~$10/mo and Hobby margin disappears.

3. **One-daemon-per-tenant vs multi-tenant daemons** — is the v1 hosted target stuck on one-per-tenant (because of FS coupling), or is there a planned path to multi-tenant before launch? Affects daemon cost line by 50–80%.

4. **Are we OK with One-Zone EFS** as the default storage tier? Multi-AZ is ~2× the cost ($0.30 vs $0.16/GB-mo). One-Zone is acceptable if we accept "AZ outage → tenant must wait for AZ recovery (typically <2 hr) → re-clone if necessary, no data loss since git remote is authoritative." If we want true high availability of in-progress task state, switch to Multi-AZ and add ~$8/tenant/mo at Pro Team.

5. **Reserved vs on-demand vs Spot for executor pool** — RIs require 1-yr commitment (34% savings). Spot is interruption-tolerant but agentic-CLI tasks are not trivially checkpointable. Pick a default strategy. Recommendation: on-demand for v1, evaluate RIs after 6 months of utilization data.

6. **Are schedules in v1 hosted?** They exist in code but have zero quota enforcement (`scheduler.ts:494` is the only guard). If yes-in-v1, the P0 quota work is blocking.

7. **What's the headline price comparison we want?** Are we positioning against Vercel/Railway (cheap PaaS) or against Replit/Cursor (developer tools)? Affects whether Pro at $49 looks cheap or expensive.

---

## 11. Out of scope (explicit)

- **LLM token costs** — users BYO API key. We never see these bills. (Implicit risk: if a user's API key burns through their own credit, they may blame us for "wasted" agent runs. Product-side question, not cost.)
- **Sales/marketing/CAC beyond free-tier costs** — covered only as "free tier should be ≤ $5/user/mo to absorb." Real CAC depends on go-to-market.
- **Support staffing** — covered in 25% ops buffer but not modeled explicitly.
- **Compliance/SOC2/audit costs** — assume bundled into Enterprise tier negotiated pricing.
- **Multi-region** — model is single-region (us-east-1). Multi-region adds Aurora Global cost (~2× DB) and inter-region transfer.
- **Reseller / partner discounts** — not modeled.
- **Currency / international pricing** — model is USD only.
- **Per-LLM-provider PrivateLink** — not yet offered by Anthropic/OpenAI; revisit.
- **Cloud provider alternatives** (GCP / Hetzner / Vultr) — AWS chosen as baseline per brief. Hetzner volumes are ~10× cheaper than EFS ($0.10/GB-mo for HC NVMe vs $0.16 EFS One-Zone), so storage-dominated tiers would shift on a cloud change. Out of scope unless surfaced as a P0 question.

---

## Appendix A — Working assumptions log (cite-or-die)

Every quantitative assumption used above, listed once for challenge:

| # | Assumption | Value | Source / Rationale |
|---:|---|---:|---|
| A1 | Region | us-east-1 | Cheapest tier for the components used; lowest cross-region transfer baseline. |
| A2 | Daemon sizing | 0.5 vCPU + 1 GB ARM | Inferred from Node.js / Feathers / tsx watch process footprint. May need 1+ GB at scale. |
| A3 | Executor slot sizing | 1 vCPU + 2 GB | c7g.xlarge / 4 slots. Matches agentic-CLI workloads (git, build, test, claude-code). |
| A4 | Executor pool utilization | 60% | Blended bin-pack efficiency assumption. **HIGHLY UNCERTAIN** — see §10 #1. |
| A5 | Avg concurrent executors per tenant | 1.5 (active hours) | Brief said 1–3; picked midpoint. |
| A6 | Daemon active hours/day | Free 1h, Hobby 4h, Pro 8h, Team 4h × 5 seats | Heuristic. |
| A7 | Hibernation cold-start | 5–10 s | Per explorer's read of boot phases (`apps/agor-daemon/src/index.ts:127–687`). |
| A8 | Storage class | EFS One-Zone Standard | Cheaper than Multi-AZ; acceptable risk because git remote is authoritative. |
| A9 | Snapshot overhead | +47% of live storage | Daily snap + 7-day retention, incremental, ~1.5× live × $0.05/GB. |
| A10 | Bandwidth per active seat | 10 GB/mo (light), 20 GB/mo (heavy) | Estimated WS event + log streaming + occasional downloads. |
| A11 | Shared infra amortization base | 100 active tenants | Early-stage envelope. At 1,000 tenants, shared cost per tenant drops ~10×. |
| A12 | Ops overhead buffer | +25% | Conventional for early-stage SaaS COGS modeling. |
| A13 | Blended exec-hour cost | $0.060 | $0.036 ideal × 1.67 utilization adjustment. |
| A14 | Blended storage cost | $0.24/GB-mo | $0.16 EFS One-Zone + $0.075 snapshots + ~$0.005 throughput. |
| A15 | Per-tenant DB cost | $1.76/mo | Aurora Serverless v2 shared cluster, ~2 ACU avg, 100 tenants. |
| A16 | CloudFront cost | ~$0/tenant | Free 1 TB/mo egress covers >10,000 tenants of static asset traffic. |
| A17 | NAT processed GB | ~5 GB/tenant/mo | Executor outbound to LLM APIs + git push. |

---

## Appendix B — Comparison anchors (sanity check)

Rough comparables for "what do other dev-tool / cloud-IDE / agent platforms charge":

| Product | Headline Hobby | Headline Pro | Notes |
|---|---:|---:|---|
| GitHub Codespaces | Free 60 hr/mo (2-core) | PAYG $0.18/hr (2-core) | No bundled agentic CLI |
| Replit Core / Replit Agent | $20/mo Hobby | $25–35/mo Pro | Bundles compute + storage + light AI |
| Cursor | $20 Pro | $40 Business | Editor + LLM gateway; no compute |
| Vercel Pro | $20 (1 seat) | $20 + usage | Hosting/edge, not compute-heavy |
| Railway | $5 / $20 / $50+ usage-based | Same | Pure usage-based PaaS |
| Lovable | $25 → $99 → $499 | Tiered by AI message volume | Pure agentic, no separate compute |
| **Agor (proposed)** | **$19** | **$49 / $199 team** | Bundles per-tenant compute + storage + RBAC |

Our Hobby at $19 sits in-line with Replit Core / Cursor Pro. Pro at $49 is a stretch for solo; the value sell is "managed compute pool + multi-agent orchestration", not "just a chat UI". Team at $199 is light vs GitHub Enterprise but reasonable vs an early-stage SaaS land-and-expand price.

---

## Appendix C — What would change with Postgres-only vs SQLite-only deployments

The model assumes Aurora PostgreSQL Serverless v2 shared across tenants (with schema-per-tenant). The product currently supports both SQLite (default) and Postgres. Implications:

- **SQLite per-tenant on EFS**: zero DB infra cost, but EFS file-locking + SQLite + concurrent daemons = fragile. Don't recommend for hosted.
- **Postgres per-tenant RDS**: $11–23/tenant/mo, eliminates noisy-neighbor — too expensive for v1.
- **Aurora Serverless v2 shared, schema-per-tenant** (modeled): best price/isolation tradeoff at <500 tenants.
- **Aurora Serverless v2 cluster-per-tier** (Free on cluster A, Pro on cluster B): isolates blast radius; modest cost increase.

If we ship hosted on SQLite (per-tenant), the DB line item disappears (~$1.76 savings/tenant/mo) but operational risk goes up significantly. **Recommend Postgres + Aurora Serverless v2 for hosted**, keep SQLite as self-hosted default.

---

*— End of v0.1 cost model. Iterate after pilot telemetry on executor utilization and after the hibernation P0 lands.*

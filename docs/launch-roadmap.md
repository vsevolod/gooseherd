# Gooseherd: From Internal Tool to Public Product

## Context

Gooseherd is a working self-hosted AI coding agent orchestrator. It has a solid core (pipeline engine, dashboard, browser verify, observer, sandbox) but zero public-facing infrastructure — no license, no CI, no published Docker image, no website. The goal is to make it dead-simple for others to deploy, polish the dashboard, create a landing page, and lay groundwork for a paid hosted service.

---

## Phase 1: Ship It (Open Source Ready)

**Goal**: `docker pull` → edit `.env` → `docker compose up` → working in 5 minutes.

### 1.1 LICENSE file
- Create `LICENSE` (MIT) at project root

### 1.2 GitHub Actions CI
- Create `.github/workflows/ci.yml`:
  - Trigger: push to `main`, PRs to `main`
  - Jobs: `npm ci` → `npm run check` → `npm run build` → `npm test`
  - Node 22, ubuntu-latest

### 1.3 Docker image publish to GHCR
- Create `.github/workflows/docker-publish.yml`:
  - Trigger: push to `main`, version tags (`v*`)
  - Multi-platform: `linux/amd64` + `linux/arm64`
  - Push `ghcr.io/chocksy/gooseherd:latest` + `ghcr.io/chocksy/gooseherd:<tag>`
  - Also build+push sandbox: `ghcr.io/chocksy/gooseherd-sandbox:latest`

### 1.4 Update docker-compose.yml for published image
- Add `image: ghcr.io/chocksy/gooseherd:latest` with `build: .` as fallback
- Users who pull the image skip the build step entirely

### 1.5 Makefile for common tasks
- Create `Makefile` with targets: `setup`, `dev`, `build`, `run`, `stop`, `test`, `pull`

### 1.6 Clean up internal references
- `README.md`: Replace Hubstaff examples with generic `yourorg/yourrepo`
- `.env.example`: Clear `GITHUB_DEFAULT_OWNER=hubstaff` → empty
- `deploy-preview.ts` line 9: "Hubstaff review" → "review apps"
- Add `docs/README.md` noting the internal research docs are historical

### 1.7 README overhaul
- New structure: Hero + Quick Start (Docker) + Quick Start (npm) + Slack setup + GitHub setup + Agent config + Dashboard + Architecture link + Contributing
- Add badges: CI status, Docker pulls, license

### 1.8 GitHub community files
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `CONTRIBUTING.md`

### 1.9 .dockerignore update
- Add: `.work-live/`, `.data-live/`, `.github/`, `website/`, `Makefile`

### 1.10 Remove `"private": true` from package.json

**Files to create**: `LICENSE`, `.github/workflows/ci.yml`, `.github/workflows/docker-publish.yml`, `Makefile`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `docs/README.md`
**Files to modify**: `README.md`, `.env.example`, `docker-compose.yml`, `.dockerignore`, `package.json`, `src/pipeline/nodes/deploy-preview.ts`

---

## Phase 2: Dashboard Polish

**Goal**: Settings page works, runs are searchable, URLs are shareable, cost overview at a glance.

### 2.1 Settings panel (slide-over)
**Files**: `src/dashboard/html.ts`, `src/dashboard-server.ts`

Replace the `alert()` stub with a slide-over panel from the right.

**Read-only info section** (shows current config):
- App name, pipeline file
- Slack connection status
- GitHub auth mode (PAT vs App)
- Features: observer, sandbox, browser verify, scope judge — on/off badges
- Agent command template (masked)
- LLM models configured

**Aggregate stats section**:
- Total runs, success rate
- Total cost (sum of all `tokenUsage.costUsd`)
- Average cost per run
- Runs in last 24h

**API**: `GET /api/settings` returns sanitized config + aggregate stats.

### 2.2 Run search and filter
**Files**: `src/dashboard/html.ts`, `src/dashboard-server.ts`, `src/store.ts`

- Add search input in sidebar header (client-side filter on title/task/repo/id)
- Add status filter pills: All | Running | Completed | Failed
- Extend `GET /api/runs` with `?status=` and `?search=` query params
- Add `searchRuns()` method to `RunStore`

### 2.3 Run permalinks
**Files**: `src/dashboard/html.ts`

- Use URL hash: `/#run/abc12345` (short 8-char ID)
- On run selection: `window.location.hash = '#run/' + runId.slice(0,8)`
- On page load: check `window.location.hash`, select matching run
- Listen for `hashchange` events

### 2.4 Cost analytics in top bar
**Files**: `src/dashboard/html.ts`, `src/dashboard-server.ts`

- New `GET /api/stats` endpoint: `{ totalRuns, successRate, totalCostUsd, avgCostUsd, last24h }`
- Display in top bar: `142 runs | 73% success | $12.45 total`

### 2.5 Manual run trigger from dashboard
**Files**: `src/dashboard/html.ts`, `src/dashboard-server.ts`

- "New Run" button in top bar → opens modal
- Fields: Repo slug, base branch, task description, pipeline
- `POST /api/runs` creates a run via RunManager (mirrors `local-trigger.ts`)

---

## Phase 3: Website at goose-herd.com

**Goal**: Professional landing page deployed to Cloudflare Pages using Astro (same stack as getcems.com).

### 3.1 Project setup
Create `website/` directory at project root as a separate Astro project.

**Stack** (matching getcems.com pattern):
- Astro 5 (`astro@^5`) with `output: 'static'`
- Tailwind CSS v4 (`tailwindcss@^4`, `@tailwindcss/vite@^4`)
- `@astrojs/sitemap` integration
- Geist font family (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`)
- Lucide icons (`@lucide/astro`)

**Config** (`website/astro.config.mjs`):
```js
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://goose-herd.com',
  output: 'static',
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
```

### 3.2 Component structure (following getcems.com pattern)
```
website/src/
├── assets/          # images, screenshots, diagrams
├── components/
│   ├── Nav.astro
│   ├── Hero.astro           # "Herd your AI coding agents"
│   ├── HowItWorks.astro     # 3-step: Connect Slack → Assign task → Get a PR
│   ├── Features.astro       # Grid: Pipeline, Browser verify, Observer, Dashboard, Cost tracking, Sandbox
│   ├── DashboardPreview.astro  # Screenshot/GIF of the dashboard in action
│   ├── QuickStart.astro     # Docker deploy code block
│   ├── Pricing.astro        # Self-hosted (free) vs Hosted (paid) tiers
│   ├── FAQ.astro
│   ├── FinalCTA.astro       # Get Started + GitHub link
│   └── Footer.astro
├── layouts/
│   └── Layout.astro         # Base layout with meta, OG tags, fonts
├── pages/
│   └── index.astro          # Composes all components
└── styles/
    └── global.css           # Tailwind imports + custom styles
```

### 3.3 Landing page sections

1. **Nav**: Logo + "Docs" (→ GitHub README) + "Dashboard Demo" + "GitHub" + "Get Started" CTA
2. **Hero**: "Herd your AI coding agents" headline, sub: "Self-hosted orchestrator that turns Slack messages into tested, reviewed PRs". Two CTAs: "Get Started" (→ GitHub), "See it in action" (→ dashboard screenshot section)
3. **How it works**: 3-step cards with icons
   - Step 1: Connect Slack & GitHub (icon: plug)
   - Step 2: Describe the change in Slack (icon: message-square)
   - Step 3: Get a PR with tests, screenshots, and cost tracking (icon: git-pull-request)
4. **Features grid**: 6 cards
   - Pipeline Engine (configurable YAML, goto/sub-pipelines)
   - Browser Verification (Stagehand + video recording)
   - Observer Triggers (auto-fix from Sentry, GitHub, Slack)
   - Dashboard (real-time run tracking, agent activity replay)
   - Cost Tracking (per-model pricing, per-run cost)
   - Sandbox Isolation (Docker-out-of-Docker, non-root)
5. **Dashboard Preview**: Screenshot or short GIF of the dashboard showing a run with video, cost chip, agent activity
6. **Quick Start**: Code block with the 4-line deploy
   ```bash
   docker pull ghcr.io/chocksy/gooseherd:latest
   cp .env.example .env  # edit with your tokens
   docker compose up -d
   open http://localhost:8787
   ```
7. **Pricing**: Two columns
   - Self-Hosted (Free): MIT license, your infrastructure, full control
   - Hosted (Coming Soon): Managed service, no Docker needed, pay per run
8. **FAQ**: 5-6 common questions (What AI models? Which repos? How much does it cost? Is it secure?)
9. **Footer**: GitHub, MIT license, "Built by Chocksy"

### 3.4 SEO
- `<title>Gooseherd — Herd Your AI Coding Agents</title>`
- `<meta name="description" content="Self-hosted AI coding agent orchestrator. Turn Slack messages into tested, reviewed PRs with pipeline automation, browser verification, and cost tracking.">`
- Open Graph tags + Twitter card
- `website/public/robots.txt` + auto-generated sitemap via `@astrojs/sitemap`
- SoftwareApplication JSON-LD structured data

### 3.5 Deployment to Cloudflare Pages
- Use Cloudflare CLI (`wrangler`) or Cloudflare Pages dashboard
- Build command: `cd website && npm run build`
- Output directory: `website/dist`
- Custom domain: `goose-herd.com`
- No GitHub Actions needed — Cloudflare Pages connects directly to the repo

### 3.6 Assets needed
- Dashboard screenshot (capture from localhost:9090 with the rich run data)
- Architecture diagram (simplified SVG from docs/architecture.md)
- Logo/brand mark (simple text logo or icon)

**Files to create**: entire `website/` directory
**Dependencies**: Phase 1 (published Docker image for Quick Start section)

---

## Phase 4: Hosted Service Foundation

**Goal**: MVP where users sign up, connect GitHub/Slack, run agents in the cloud, pay per usage.

### 4.1 Make Slack optional in core
**File**: `src/config.ts` lines 6-8

Change `z.string().min(1)` to `z.string().optional()` for all three Slack tokens. In `src/index.ts`, skip `startSlackApp()` when tokens absent. Unblocks dashboard-only usage.

### 4.2 Multi-tenant architecture (tenant-per-container)
Each customer gets their own Gooseherd container. A provisioner service manages lifecycle:
- On signup: create tenant record in Postgres, generate container config
- On activate: spin up container with tenant's env vars
- Reverse proxy routes `{tenant}.goose-herd.com` → container

Zero changes to core Gooseherd — each container is a standard single-tenant install.

### 4.3 Provisioner API (new service)
- `hosted/provisioner.ts` — manages tenant containers
- `hosted/auth.ts` — GitHub OAuth for signup
- `hosted/billing.ts` — Stripe metered billing
- `hosted/docker-compose.hosted.yml`

### 4.4 Billing model
- $29/mo base (100 runs included)
- $0.50/run overage
- Stripe metered billing: usage event on each run completion
- Dashboard: usage display + Stripe billing portal link

### 4.5 Database
- Postgres: `tenants`, `usage` tables
- Core Gooseherd keeps file-based RunStore per container (no refactor for MVP)

---

## Sequencing

```
Phase 1: Ship It              ← START HERE
    │
    ├── Phase 2: Dashboard     (depends on Phase 1)
    │
    ├── Phase 3: Website       (depends on Phase 1, parallel with Phase 2)
    │
    └── Phase 4: Hosted        (depends on Phase 2 for manual trigger)
```

---

## Verification

### Phase 1
- `docker pull ghcr.io/chocksy/gooseherd:latest` succeeds
- `docker compose up -d` starts healthy container
- CI badge is green on README
- `npm test` passes, `npx tsc --noEmit` clean

### Phase 2
- Settings button opens slide-over with config + stats
- Search filters runs by title/task/repo
- `http://localhost:8787/#run/abc12345` deep-links to a run
- Top bar shows aggregate cost
- "New Run" button creates a run from dashboard

### Phase 3
- `goose-herd.com` loads Astro landing page via Cloudflare Pages
- Lighthouse score > 90
- Open Graph preview works
- `wrangler pages deploy website/dist` succeeds

### Phase 4
- GitHub OAuth signup flow works
- Container provisioned with user's config
- Run completes, Stripe records usage

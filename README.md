# CodePilot

Connect a GitHub repository and get a living, traceable map of its code: every file, every
import resolved to its exact target and line, classified and summarized.

Landing page, authentication + GitHub onboarding, real analysis with streamed progress, and
Project Home with three views:

- **Summary** — totals, hubs, cycles, orphans, entry points.
- **Wireframe** — *what is connected to what.* Three modes over the same graph:
  - **Ring**: every file on one circle in fixed category arcs (Pages, Routes, Components,
    Actions, Services, Utilities, APIs, Configuration, Other), ordered by directory then name,
    so a file never moves when filtering, searching or zooming. Each dependency is a thread from
    the exact source file to the exact target file, hierarchically bundled through category and
    directory control points. Noise controls (intra-group, weight threshold, show all), hover
    focus (red = imports, blue = imported by, everything else ~8%), click to lock + inspector,
    double-click to isolate, click a category band to focus its dependencies, semantic zoom
    (ticks → file names → names + directory + type), keyboard navigation, one-time load sequence.
  - **Layered**: top-to-bottom routes/pages → components → actions → services → utilities.
  - **Summary**: totals, category dependency matrix (a cell opens those threads on the ring),
    most depended-on files, import cycles and the accessible file table.
- **Architecture** — *how the system works.* Three modes:
  - **System map**: layered swimlanes (Client, Transport / API, Backend, Services, Data / Cache,
    Async workers, External services, Deployment — only those present): transports by protocol
    and library (REST · fetch via `request()`, Server-Sent Events · EventSource…), API route
    groups, the middleware chain in registration order, route handlers, service modules, and the
    data stores, queues and external services they call, inside application boundaries. Calls
    whose target is computed at runtime go to an explicit "Unknown target".
  - **Technologies**: name, category, version, role, used by, evidence and confidence for every
    detected technology; focusing a row shows its connections on the map.
  - **Request flows**: real scenarios traced from the code (a button click, a page load, a
    stream) through the API client, transport, route, middleware, handler, services and data or
    external calls, back through the response to the UI's navigation and state updates — in
    Frontend / Backend / External / Async swimlanes with play, pause, step, replay, speed and
    per-step file, line, technology, sync/async and evidence. Background work is a separate
    async branch; cache reads show hit/miss branches.
  - Cross-links: Wireframe file → its component in the Architecture; component, route and flow
    step → the file in the Wireframe or on GitHub; technology → matrix and map.
- **Technology Intelligence** — *what powers the system, and why the code shows it is used.*
  Every technology (catalogued frameworks, databases, caches, queues, services, infrastructure,
  and other dependencies from the import graph) explained for this repository only: what it
  does here, why it is used here, where (files, functions, package scripts), its architecture
  connections with a small focused relationship graph, the request flows and routes that use
  it, the evidence, and a confidence for each claim — *confirmed*, *strong inference*,
  *possible* or *unknown*. Purposes come only from what the code does with it (e.g. "Used for
  caching (pricing reads from and writes to it) through the `cache` client created at
  backend/app/cache.py:5"); when the code does not prove a purpose it says "Purpose could not be
  confidently determined from the available source." General descriptions are labelled as
  such and never presented as project facts. Explanations are stored with the analysis
  snapshot (commit) and regenerated whenever the repository is re-analyzed. Links to the
  Wireframe, the system map, request flows, files and evidence.
  - Exports: PNG / SVG / PDF one-pager / Mermaid / JSON.
- **Automation** — *how this project actually works, in at most four main flows.* The engine
  traces every entry point (route, queue, schedule, UI action) and groups them into
  capabilities. It then picks one flow per cycle: **access** (sign-in), **core action**, **data**
  (read or browse) and **background / integration**. A flow is only stitched to another (a route
  to the worker it enqueues) when the code links them. Near-duplicates fold into
  "+N similar endpoints". Slots are never padded, so a small project shows fewer flows.

  The summary line reads "*project* · N main flows · covers A of B entry points". It expands to
  the shown, folded and omitted lists, and those always add up to B. Each card gives the flow's
  name (actor + verb + object, e.g. "User pays order"), purpose, step count, tools and
  confidence. Owners can rename a flow or swap it for another candidate, and the choice is
  stored per project.

  The canvas is a real flowchart: a trigger pill, then UI, HTTP, server, decision diamonds
  (only where branches lead to different outcomes), data stores, external services, async jobs
  and end pills. Frontend, backend and external swimlanes are drawn only when used, and every
  node carries file:line evidence. It supports:
  - Pan, ctrl/⌘ + scroll zoom to the cursor, pinch, and double-click to zoom or fit.
  - Keyboard: arrows, + / −, 0, 1, F, Home, Esc.
  - Semantic zoom: full cards, then titles, then shapes. Text never renders below 11px.
  - A minimap, a legend and a node inspector.
  - Playback that stops at each decision for you to pick a branch, or runs all paths.
  - Path highlighting and "Focus branch".

  Below the canvas, the explanation covers what the flow does, each step (linked to its node),
  data in and out, decisions and failure paths, tools, folded endpoints and confidence.

  Projects without HTTP routes still get a flow: static apps from their UI actions, CLIs and
  scripts from their entry point's import chain ("How the app starts"). Unsupported languages
  say so instead of guessing. Results are cached per commit and schema version, rebuilt after
  every analysis, and the layout is stored with them. Below 600px wide, a flow is a step list
  with an "Open flowchart" button.

- **Code** — *read the repository as it was imported.* A three-panel browser:
  - **Explorer (left):** a virtualized file tree, folders first, with file-type icons and a
    filter box. Entries that were not stored are shown in grey with the reason. These are
    dependency, build and tool directories, `.env` and other sensitive files, files containing a
    private key, binaries, files over 1 MB, lockfiles, generated files and symlinks.
  - **Viewer (centre):** read-only, syntax-highlighted code with line numbers, open-file tabs and
    a breadcrumb. It has buttons to copy the code or the path, and highlights a line or range from
    `?line=12-20`.
  - **Code intelligence (right):** the file's outline (functions, classes, methods and types,
    each jumping to its line), the files that import it (*Used by*) and the files it imports. An
    import specifier in the code links to the file it resolves to. Unresolved imports say why and
    are never guessed.
  - **Shortcuts:** Ctrl/⌘ + P opens a file by name (`api.ts:42` jumps to a line). Ctrl/⌘ + Shift + F
    searches every stored file on the server, with results grouped by file.

  Files are stored during the import, in parallel with the analysis, so they can be read before
  it finishes. The header reads "*N* files stored · *M* not stored". Every file:line reference in
  Wireframe, Architecture, Automation and Technology Intelligence opens here at that line, pinned
  to the snapshot's commit. Detected secrets are masked when the files are stored, so the raw
  value never reaches storage, file views, search or copy. Masking covers known credential
  formats, secret-named assignments, passwords in URLs and JWTs.

  Special states:
  - An empty repository shows "Repository was empty".
  - A failed import shows "Import failed at *stage*" with a Retry button that runs the import again.
  - A snapshot analyzed before this feature asks to be re-analyzed.

- **Collective Intelligence** — *how this architecture compares with anonymized real-world
  projects.* Off by default, per project ("Contribute anonymized patterns to Collective
  Intelligence" in project Settings). With explicit consent, each analyzed snapshot contributes a
  deterministic **structural fingerprint**: size and type *ranges*, topology buckets (density,
  90th-percentile fan-out, fan-in, cycles), layers, architecture pattern, technology *categories*,
  category-to-category relations, structural risk and resilience codes, and the month — every
  field and value from an enumerated allowlist that the server validates before storage
  (`server/src/collective/schema.ts`). Never: code, file contents, paths or names, repository or
  organization names, symbols, comments, commits, environment variables, secrets, IPs, exact counts
  or incident descriptions. Fingerprints live in a separate database (`collective.sqlite`) keyed
  by an HMAC pseudonym, with no foreign key to projects or users; only the server, which holds the
  key, can find a project's own rows (to show them to the owner and to revoke). The Architecture
  page's **Collective** tab keeps **This project** (its own analysis) and **Collective data**
  (aggregates) in separate, differently styled columns. Benchmarks use the most specific
  population with **N ≥ 20** contributing projects (same pattern and size band → same size band →
  all), every aggregate shows its N and population definition, cells under 5 projects are
  suppressed, and below the threshold nothing is shown at all. Insights are labelled *observed*,
  *correlated* (self-reported incidents) or *statistical pattern* — never predictions or causes.
  Files and components can be tagged with an incident (month and source); with consent only "an
  incident on a `<kind>` element in `<month>`" is shared. Periodic association-rule discovery
  (support, confidence, lift, χ² with p < 0.01, subgroups ≥ N) only queues patterns for human
  review; nothing is published until a reviewer approves it, and a causal claim needs a written
  justification. A State of Architecture report aggregates all contributions, withheld below N.
  Revoking consent stops extraction, marks every fingerprint and outcome inactive and recomputes
  all aggregates without them; the inactive rows are kept (pseudonymous, allowlisted), which the
  settings dialog says plainly. Consent changes are kept in an audit log.

Nothing is decorative data. Every node and edge comes from parsing source and configuration;
each carries evidence (file, line, redacted snippet) and a confidence level — *confirmed*,
*strong inference* or *possible*. Imports that cannot be resolved are shown as *Unresolved*
with a reason, and flows stop at "Outbound call target unknown" instead of guessing.

## Quick start

```bash
npm install
cp .env.example .env            # fill in OAuth credentials, or use the dev token below
npm run dev                     # server on :8787, web on http://localhost:5173
```

Without OAuth credentials you can sign in locally with a personal token (development only):

```bash
DEV_GITHUB_TOKEN=$(gh auth token) npm run dev
```

The dev token is stored server-side, encrypted, in `.data/` (gitignored). Delete `.data/` to
remove it.

Production: `npm run build && NODE_ENV=production TOKEN_ENCRYPTION_KEY=… npm start` — the
server then also serves `web/dist` with a Content-Security-Policy.

## Repository layout

```
packages/analyzer   Analysis engine (no web/server dependencies)
  scanner.ts          walks the checkout; exclusions, secret files, generated files, symlinks
  parser/             TypeScript compiler API: imports, re-exports, dynamic import(), require(), exports
  resolver/           relative + extensions + index, tsconfig/jsconfig paths & baseUrl (incl. extends
                      and solution-style references), package.json "imports", workspaces
                      (npm/yarn/pnpm/lerna) with "exports" conditions, builtins, external packages
  classifier.ts       deterministic node types with evidence (path rules, then content rules)
  entrypoints.ts      entry points from manifests, npm scripts, HTML <script src>, framework conventions
  summary.ts          hubs, Tarjan SCC cycles with traceable hops, orphans
  layout.ts           deterministic force / circular / layered / grouped layouts (d3-force, fixed seed)
  cluster.ts          adaptive directory clusters used by layouts and hulls
  architecture/       two-stage architecture detection:
    extract.ts          facts while the checkout exists: manifests, lockfiles, imports, clients,
                        queries, routes, HTTP calls, env refs, Dockerfile/Compose/k8s/Helm/Terraform/
                        serverless/CI/proxy/platform config — each with file, line, redacted snippet
    lifecycleFacts.ts   UI triggers (event, handler, component, button text, what happens after),
                        middleware (hooks, plugins, use(), guards), route responses, client functions
    detect.ts           pure detection from facts + dependency graph: apps, tools, connections
    system.ts           the system map: transports, API groups, middleware chain, handlers, services
    intelligence.ts     technology intelligence: role and purpose from operations, routes, scripts,
                        middleware and configuration; "undetermined" when the code does not prove it
    flows.ts            request lifecycles: UI action → client → route → middleware → handler →
                        traced calls → response → UI update, with an async branch for queued work
    findings.ts         pattern, strengths and risks, each citing evidence
    catalog.ts          technology catalog (packages, modules, images, env vars, URL schemes)
    layout.ts, render.ts shared diagram layout and SVG/Mermaid renderers (web + exports)
  shapes.ts, svg.ts   node markers shared by canvas and SVG/PNG export
  test/               hand-verified fixture repo + resolver/classifier/scale tests
server              Fastify API, SQLite (node:sqlite), OAuth, clone + analysis jobs, SSE
web                 React + Canvas renderer (d3-zoom, quadtree hit-testing)
legacy              the previous prototype, kept for reference; not built or served
```

Pipeline: GitHub → shallow single-branch clone (token via `GIT_CONFIG_*` env, never in URL or
argv) → scanner → parser → resolver → classifier → graph builder → SQLite → API → SSE → renderer.
The clone is deleted after analysis; only paths, specifiers, symbol names, line numbers and
sizes are stored.

## API

| Endpoint | |
| --- | --- |
| `GET /api/projects/:id/graph?types=&focus=&depth=` | nodes + edges, cycles, orphans, entry points |
| `GET /api/projects/:id/graph/layout?layout=force\|circular\|layered\|type\|directory` | cached positions |
| `GET /api/projects/:id/graph/nodes/:nodeId` | imports, exports, consumers, dependencies, dependents, transitive depth 1–3 |
| `GET /api/projects/:id/graph/summary` | totals, counts by type, hubs, cycles, orphans, entry points, unresolved imports |
| `GET /api/projects/:id/graph/export?format=png\|svg\|json` | JSON includes repository metadata |
| `GET /api/projects/:id/architecture` | nodes, edges, layers, system map, evidence, flow list (with UI actions and lanes), summary |
| `GET /api/projects/:id/architecture/tools/:toolId` | explanation, connections, blast radius, flows, evidence |
| `GET /api/projects/:id/architecture/flows` · `…/architecture/summary` | flows with steps · pattern, strengths, risks |
| `POST /api/projects/:id/collective-intelligence/consent` · `GET …/collective-intelligence/status` | opt in or out (owner only, `{ "enabled": boolean }`, audited) · consent, history, and exactly what this project has contributed |
| `GET /api/projects/:id/benchmark` · `GET /api/projects/:id/pattern-insights` | this project's metrics beside k-anonymous population statistics (N, population, privacy rule on every aggregate) |
| `POST /api/projects/:id/graph/nodes/:nodeId/incident-tag` | tag a file or component with an incident; only the element kind and month are shared, with consent |
| `GET /api/collective-intelligence/state-of-architecture` · `…/schema` | aggregate report (withheld below N) · the full fingerprint allowlist and privacy rules |
| `GET /api/collective-intelligence/review` · `POST …/review/:patternId` · `POST …/discovery/run` | reviewers only (`COLLECTIVE_REVIEWERS`): discovered patterns and their approval |
| `GET /api/projects/:id/snapshots` | completed analyses (branch, commit, finished) newest first; every architecture endpoint takes `?analysisId=` to read one |
| `GET /api/projects/:id/architecture/intelligence` | per-technology role, purpose, usage, connections, flows, routes, evidence and confidence, with the snapshot (commit) they belong to |
| `GET /api/projects/:id/architecture/export?format=png\|svg\|pdf\|mermaid\|json` | PDF is a one-page summary |
| `POST /api/projects/:id/architecture/regenerate` | recompute from stored facts |
| `GET /api/projects/:id/code?analysisId=&commit=` | the snapshot's state (`ready`, `storing`, `pending`, `empty`, `failed`, `not-stored`), the stored files and every entry not stored with its reason, the counts, and any import failure with its stage |
| `GET …/code/file?path=` · `…/code/outline?path=` · `…/code/relations?path=` · `…/code/search?q=&case=1&word=1` | masked content, symbol outline, importers and imports from the snapshot's graph, literal search grouped by file (capped, with line, column and snippet). Access is checked first, so a project you cannot open is a 404 on every endpoint; paths are validated (no `..`, absolute paths or backslashes) |
| `GET /api/projects/:id/automation/flows` · `…/automation/coverage` | the main flows (nodes, edges, explanation, evidence), candidates, coverage counts, diagnostics, project type · shown / folded / omitted entry points |
| `POST /api/projects/:id/automation/flows/:flowId/replace {key}` · `PATCH …/automation/flows/:flowId {name}` | owner only: swap a main flow for another candidate · rename it (`null` restores the generated name) |
| `POST/GET /api/projects/:id/shares` · `DELETE …/shares/:shareId` · `GET /api/shared/:token/…` | read-only share / embed links (hashed, revocable) |
| `GET /api/projects/:id/analysis/stream` | SSE: `snapshot`, `stage`, `progress`, `partial`, `complete`, `failure` |
| `GET /api/github/repos?q=&owner=&page=` · `GET /api/github/repos/:owner/:repo` | real repositories and branches |
| `POST /api/projects {owner, repo, branch}` | start an analysis |

Architecture results are cached per project, commit SHA and detector version: an unchanged
commit is never re-analyzed, and a new sync recomputes it.

Node: `{ id, path, type, language, size, classification_evidence, … }` · Edge:
`{ id, source, target, symbols, kind: static|dynamic|re-export|require, line, resolved, … }`.
Each relationship is stored once; the UI colours it red from the importer's side and blue from
the imported file's side.

## Tests

```bash
npm test          # analyzer, server integration, web unit tests
npm run typecheck
```

- `packages/analyzer/test/fixture.test.ts` — exact edge-set match against a hand-verified
  fixture; every edge's line contains its specifier; static/re-export/dynamic/require, aliases,
  index/extension, workspaces, `package.json` imports, unresolved reasons, cycles, orphans,
  entry points, exports with lines, secret/exclusion handling, determinism.
- `packages/analyzer/test/scale.test.ts` — 1,200 files / 6,000 imports extracted exactly; all
  four layouts computed and deterministic.
- `packages/analyzer/test/architecture.test.ts` — hand-written Next.js + Postgres,
  FastAPI + Redis + Celery, multi-service Compose and Fastify + React repositories: exact nodes,
  connections, system maps, middleware, responses, UI triggers and full request lifecycles
  (lanes, kinds, labels, lines), automation stages, functions, inputs/outputs, per-step
  confidence and the flow index, risks and patterns; every evidence snippet matches its source
  line; determinism.
- `server/test/collective.test.ts` — Collective Intelligence acceptance: consent is off by
  default; no fingerprint without consent; fingerprints contain only allowlisted fields and
  values (checked against four fixture repositories for paths, file names, symbols, component
  names, snippets and URLs) and anything else is rejected before storage; the collective database
  holds no project, user, repository, commit, path or token; statistics below N are withheld
  entirely and small cells suppressed; every aggregate carries N; repository evidence and
  aggregate data stay apart; revocation excludes a project from all aggregates; other users cannot
  read a project's contribution; insights are labelled as observations; incident descriptions
  never leave the project; discovered patterns wait for review and causal claims need support.
- `web/src/features/landing3d/model.test.ts` — the landing scene contains only snapshot
  entities and connections (files, symbols, packages, technologies, imports, architecture labels),
  technologies connect only to files that import them or appear in their evidence, the traced
  flow's files in order, complete finite layouts per chapter, determinism, the phone model.
- `packages/analyzer/test/automation.test.ts` — Automation Engine on the following fixtures:
  full-stack (Fastify + React), FastAPI + Celery, Next.js + Stripe webhook, a monorepo with
  Compose services, a static React app, a commander CLI, a single Python script and a Rust
  crate (unsupported). It checks:
  - Each flow has one trigger, an end and no unreachable nodes. Evidence points to real files,
    and backend files never sit in the frontend lane.
  - Layouts have no overlaps in every lane, spacing and direction mode.
  - No banned phrases appear, and shown + folded + omitted equals the total.
  - Expected names and decisions are produced, and output is deterministic.
  - A 45-step layout lays out cleanly, and the 150-node cap groups the rest.
- `server/test/automation.test.ts` — flows are built after an analysis; fallback flows keep
  counts consistent; a schema bump regenerates; rename and reset work and reject banned names;
  replace is owner only.
- `web/src/features/automation/chartModel.test.ts` — semantic zoom levels against the 11px
  floor, fit, trigger anchor, zoom to the cursor, pan bounds, path highlighting, collapsed
  branches, and playback that waits at decisions, runs all paths and forks async work.
- `packages/analyzer/test/code.test.ts` — secret masking (credentials, secret-named values,
  URL passwords, JWTs; lines never move; regexes and expressions assigned to secret-named
  variables are left alone), outlines for TS/Python/Go/Rust/Markdown, and the stored-file walk
  with every exclusion reason.
- `server/test/code.test.ts` — Code tab acceptance against a real git remote seeded with a fake
  Stripe key, a database URL password, `.env`, an HTML file with scripts, binaries, a file over
  1 MB and `node_modules`. It checks:
  - Counts and exclusion reasons.
  - The secrets never appear in file responses, search results or the database.
  - HTML comes back as JSON text.
  - Search options work.
  - Outline and Used by are correct.
  - The snapshot can be pinned by commit or analysis.
  - Path traversal is rejected.
  - Other users and anonymous requests get 404 on every endpoint.
  - "Import failed at cloning" appears, and Retry runs a real re-import.
  - Identical file contents are stored once across snapshots.
  - An empty repository is reported as empty.
- `web/src/features/code/code.test.tsx` — the highlighter (state across lines, every
  character kept, masked tokens). The explorer model (folders first, natural sort, filter). Line
  links. HTML, scripts and hostile file names render as text with no elements created. Import
  links and line highlighting.
- `web/src/graph/ring.test.ts` — ring layout order and determinism (independent of input order
  and filters), exact file-to-file threads, bundling through shared control points, default
  noise filters, hit-testing, and 1,500 files / 6,000 threads within budget.
- `server/test/api.test.ts` — mock GitHub API (paginated repos, branches, expired token) and a
  real local git remote: repo listing, search/filter/pagination, SSE stage order and counts,
  graph/details/summary/export endpoints, layouts, architecture caching by commit, snapshots and
  per-snapshot flows, regenerate,
  all architecture export formats, share links, access control, CSRF, token never reaching clients.
- `web/src/**/*.test.ts(x)` — red/blue highlight semantics, transitive depth, keyboard
  navigation, search ranking, reduced motion.

The Wireframe ring was measured in Chrome at 1,500 files / ~6,000 dependencies (2× pixel ratio):
first draw including all bundled splines 32 ms, then 9–15 ms per redraw (all threads, noise-
reduced default, zoomed-in labels) and under 1 ms with a file focused. Nothing redraws when idle.

### Landing page

The landing page is one continuous story over a 3D "living codebase" (Three.js through React
Three Fiber, in `web/src/features/landing3d/`). The scene is CodePilot's analysis of its own
repository: every point is a real source file, exported symbol, external package, technology or
application, and every line a real import, export, package import, technology use or detected
architecture connection. As the page scrolls, the same nodes morph through one layout per
chapter — Discover (GitHub → the file tree → CodePilot), Understand (files grouped by directory
around the applications), Map (layers with the REST / SQL connections the code proves), Trace
(a request traced end to end, packet and step list in sync), Explain (technologies on an orbit,
with what each does here, why, where, how it connects, and its evidence), Verify (the call site
and route behind the web → server connection, line by line) — and converge for the final call to
action. Hovering a node highlights its connections with a tooltip; nearby nodes lean toward the
cursor. Below the story, seven product surfaces (overview, dependency wireframe, architecture,
automation playback, technology intelligence, the coming grounded chat, evidence) run as live
miniatures on the same data.

Performance: the 3D scene is a separate lazy chunk (three.js ≈ 247 KB gzip), loaded after the
page renders; until then, and on devices without WebGL or reporting ≤ 2 cores / ≤ 2 GB memory,
a static drawing of the same import graph is shown. It is one canvas with a handful of draw calls
(points, lines, packets, the traced path, layer rings) whose buffers are updated in place — no React re-renders per frame — and
its render loop stops while the product, docs and trust sections are on screen. Pixel ratio
adapts to measured performance. Phones get a separate composition (files only, no symbols or
packages, no hover, cards under the scene). With reduced motion the scene renders on demand,
cuts between chapters instead of morphing, and shows the traced path all at once. Measured in
Chrome on an Apple M5: about 1–1.3 ms of main-thread work per frame (p95 ≈ 2.5 ms) with hover
active.

`npm run hero:snapshot` regenerates the landing page data (files, symbols, imports, packages,
architecture, technology intelligence, the traced flow, evidence) from a real analysis of this
repository. Every figure and node on the page comes from that snapshot, and "Explore CodePilot"
opens the live sample project (`/sample?view=architecture`).

## Known limitations

- Collective Intelligence only shows statistics once enough projects contribute (N ≥ 20 per
  population); on a new installation every benchmark, insight and the State of Architecture
  report are withheld, by design. Incident links are recorded manually in CodePilot — PagerDuty and
  Opsgenie are labels for the source, not live integrations. Pseudonyms are keyed HMACs: the
  collective dataset alone cannot be linked to a project, but the server (which holds the key)
  can, which is what makes revocation possible. Revoked rows are deactivated, not deleted.

- Import extraction covers JS/TS (`.ts .tsx .js .jsx .mjs .cjs .mts .cts`, `.vue`/`.svelte` script
  blocks). Other languages appear as nodes marked "not analyzed", and are excluded from orphans.
- Aliases defined only in bundler config (e.g. `vite.config` `resolve.alias`) are not read and are
  reported as unresolved; tsconfig/jsconfig `paths` and package.json `imports` are.
- Workspace packages whose manifest points only at build output (`dist/`) resolve as unresolved
  with that reason — build output is intentionally not analyzed.
- `import.meta.glob` and computed `import()`/`require()` are reported as diagnostics, not edges.
- Ring bundling is hierarchical (category → directory → file); files are grouped by their
  classified type, so the quality of the arcs depends on classification (many files land in
  "Other" when nothing marks their role). External packages are not on the ring; the Layered
  view shows them.
- UI triggers, middleware and response shapes are pattern-based (React/JSX events and hooks;
  Fastify/Express/Nest/FastAPI/Flask/Django/Go middleware). A trigger, middleware or response
  that is not written in a recognisable form is left out, and the flow says so, rather than
  being guessed. Response shapes are the returned literal's keys, a declared model, or the
  returned expression — never an inferred payload.
- Architecture detection is static. Connections through values computed at runtime (URLs from
  config, dependency injection containers, reflection) are shown as unknown or not at all;
  flows show code a request can reach, not proven runtime order. Latency is never shown
  because it cannot be measured statically.
- Method-level tracing for flows covers JS/TS and Python; other languages fall back to
  file imports.
- Automation stitches flows only through a direct enqueue → worker link. It does not stitch
  flows through IDs one flow returns and another reads, or through a table two flows share.
  - Decisions come from `if` / `try` blocks that exit (throw, return, respond, redirect) in
    JS/TS and Python. Branches that don't exit, and `switch` statements, aren't drawn.
  - Decision text is the code's own condition when there is no status code or message to name
    it (e.g. `origin !== config.appOrigin?`).
  - Static frontends get no client-side decisions.
  - Languages other than JS/TS and Python get an entry-point flow that says they are not traced.
  - A flow is capped at 150 nodes, with the remainder grouped.
  - Card text is 16px at 100% zoom so it stays readable when zoomed out. As a result, a long flow
    is wider than the screen and opens at 0.85× anchored on its trigger.
- Opening an older snapshot computes its architecture on first use (then it is cached).
  Snapshots are listed only for owned projects, not on the sample or share links.
- Code tab:
  - **Syntax highlighting** is a built-in tokenizer covering about 30 languages. Other files are
    plain text, and lines over 4,000 characters (minified code) are not highlighted.
  - **Outline** is pattern-based: declarations, not every nested local.
  - **Used by and imports** exist only for JS/TS (what the dependency graph traces), and appear
    once the analysis finishes.
  - **Search** is exact text (case and whole-word options), not regex. It is capped at 1,000
    matches, 300 files and 4 seconds.
  - **Storage** keeps at most 50,000 files per snapshot.
  - **Secret masking** can't recognise every secret. A value that matches none of its patterns
    stays visible. Likewise, a long random value assigned to a secret-named variable is masked
    even if it isn't a credential.
  - **The public sample** is CodePilot's own code, so its Code tab is open to everyone.
  - **Shared links** never include code.
- Grounded AI answers are not implemented yet; the landing page marks that section
  "Coming next".
- GitHub OAuth apps have no read-only scope for private code, so the `repo` scope is requested.
  A GitHub App with read-only contents permission is the natural next step.

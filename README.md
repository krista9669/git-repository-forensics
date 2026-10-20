# Git Repository Forensics

**DBMS Mini Project**

**Developed by:**
- **KRISHITHA KANKANALA** — PES2UG24CS234
- **SARAH KAZI** — PES2UG24CS224

---

A database-driven platform that mines Git history and turns it into actionable insights about developer contributions, repository risks, file relationships, and code ownership.

- **Who works on what:** commits, churn, active days and code ownership (`git blame`) per developer, plus the repository's **bus factor**.
- **Where the risk is:** *hotspots* are files that change often, by many people, with high churn.
- **What changes together:** *change coupling* finds pairs of files that keep changing in the same commits, with support, confidence and Jaccard.
- **Where in a file:** line-level hunks show which regions of a file are edited most.
- **Who should review this:** a Neo4j graph suggests reviewers from coupled files and finds knowledge silos and collaboration pairs.
- **Find commits:** PostgreSQL full-text search, and pgvector similarity search over commit messages.

It was built as a DBMS project. PostgreSQL is the authoritative store, and most of the logic lives in the schema: constraints, triggers, views, a materialised view, a SQL function, and full-text and vector indexes. See [docs/database-design.md](docs/database-design.md).

## Architecture

```
 Browser ──► Next.js (app + JSON API) ──► PostgreSQL 17 + pgvector  (source of truth)
                     │      ▲                    ▲
                     │      └── Redis ◄──────────┤  cache · job progress · rate limits
                     ▼                           │
                   Neo4j  ◄── projection ── Analysis worker ──► git (clone / log / blame)
```

| Component | Role |
|---|---|
| **PostgreSQL + pgvector** | All mined data, users, sessions, the job queue and the audit log. |
| **Neo4j** | A rebuildable graph projection (developers → files → coupled files) for traversal queries. |
| **Redis** | Read-through cache for expensive reports, live job progress and rate limiting. If Redis is down, the app keeps working, only slower. |
| **Worker** (`workers/analysis-worker.ts`) | Claims jobs with `FOR UPDATE SKIP LOCKED`, runs git, and rewrites one repository's data in a single transaction. |

## Requirements

- Node.js 22+
- Git 2.30+ on the `PATH`
- PostgreSQL 17 with the **pgvector** extension, Neo4j 5 and Redis 6+. `docker-compose.yml` starts all three. Native installs or hosted services also work: put their connection strings in `.env.local`.

## Setup

```bash
npm install
cp .env.example .env.local        # then replace every CHANGE_ME value
npm run db:up                     # start PostgreSQL, Neo4j, Redis (Docker)
npm run db:migrate                # create the schema
npm run neo4j:init                # graph constraints and indexes
npm run db:seed -- --demo         # admin user + a demo repository with a queued analysis
```

Then, in two terminals:

```bash
npm run worker                    # processes analysis jobs
npm run dev                       # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env.local`. The **demo** repository is analysed as soon as the worker starts.

### Adding repositories

- **Remote:** an `https://` URL on a host listed in `ALLOWED_GIT_HOSTS` (GitHub, GitLab, Bitbucket and Codeberg by default). The worker makes a bare clone into `WORKSPACE_DIR` and fetches on re-analysis. Only public repositories work, because no credentials are ever used.
- **Local:** a folder name inside `LOCAL_REPO_ROOT`. `npm run fixture` creates `fixtures/repos/demo`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js web app |
| `npm run worker` | Analysis worker (run one or more) |
| `npm run db:up` / `db:down` | Start / stop the Docker databases |
| `npm run db:migrate` | Apply pending migrations from `db/migrations` (`-- --test` for the test DB) |
| `npm run db:reset` | **Drop** and recreate the database, then migrate (`-- --test` for the test DB) |
| `npm run db:seed` | Create the administrator (`-- --demo` also adds the demo repository) |
| `npm run neo4j:init` | Create Neo4j constraints and indexes |
| `npm run fixture` | Create the deterministic demo repository |
| `npm test` | All tests; `test:unit` and `test:integration` run them separately |
| `npm run typecheck` | TypeScript check |

## Tests

- **Unit tests** (`tests/unit`) need no database. They cover the git output parsers (on synthetic output and on a real repository built by `scripts/fixture-repo.ts`), the coupling and embedding algorithms, and URL / path / branch validation.
- **Integration tests** (`tests/integration`) run the full pipeline against PostgreSQL and check the stored results against values known in advance, e.g. the `api.ts ↔ api.test.ts` coupling has Jaccard 3/5. They also check the schema's rules: one active job per repository, ordered coupling pairs, the last-admin trigger, case-insensitive e-mail uniqueness and cascading deletes. Run `npm run db:reset -- --test` first. They are skipped when `TEST_DATABASE_URL` is unreachable.

## JSON API

All endpoints need a session cookie, except login and registration. Mutating requests must come from the same origin.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` · `register` · `logout` | Sessions |
| `GET /api/repositories` · `POST /api/repositories` | List / register (`{name, sourceType, source, branch?}`) |
| `GET /api/repositories/:id` · `DELETE …` | Details, summary and jobs / delete (owner or admin) |
| `POST /api/repositories/:id/analyze` | Queue a re-analysis (409 if one is already active) |
| `GET /api/repositories/:id/report?kind=…` | `summary`, `monthly`, `developers`, `hotspots`, `coupling&minJaccard=`, `commits&q=`, `similar&q=`, `collaboration`, `silos` |
| `GET /api/jobs/:id` · `POST /api/jobs/:id/cancel` | Status with live progress / cancel |
| `PATCH /api/admin/users/:id` | Admin: `{role?, isActive?}` |

## Security notes

- Passwords are hashed with bcrypt (cost 12). Sessions are random 256-bit tokens, and only their SHA-256 is stored. Cookies are `HttpOnly` and `SameSite=Lax`, and mutating API calls are origin-checked.
- Login and registration are rate-limited per IP and per account. Failed logins are written to the audit log.
- Clone URLs must be plain https on an allow-listed host: no credentials, ports, IP literals or query strings. Git runs without a shell, with only the https transport, without following redirects and without prompting for credentials. Local paths are resolved with `realpath` and must stay inside `LOCAL_REPO_ROOT`. Branch names are validated before they reach git.
- Every SQL value is a bound parameter.

## Project layout

```
app/                Next.js pages and API route handlers
components/         Client components (forms, job progress, charts)
db/migrations/      SQL schema
lib/                db, redis, neo4j clients · auth · queries · validation
lib/git/            git runner and output parsers
lib/analysis/       pipeline, change-coupling and embedding algorithms
lib/graph/          Neo4j projection
workers/            analysis worker
scripts/            migrate, reset, seed, neo4j-init, fixture repository
tests/              unit and integration tests
docs/               database design
```

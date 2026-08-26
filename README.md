# Minibase

<p align="center">
  <img src="./assets/minibase-logo.png" alt="Minibase logo" width="220">
</p>

[English](./README.md) | [简体中文](./README.zh-CN.md)

**Deploy an existing Supabase project on your own server in minutes, without bringing the full
Supabase local stack.**

Minibase is a compact, Supabase-compatible deployment runtime. It reads the project you already
have, including `supabase/migrations`, `supabase/seed.sql`, `supabase/functions`, and
`supabase/config.toml`, and serves the commonly used Database, Auth, REST, Storage, and Edge
Functions APIs from one distribution. Existing applications keep using `supabase-js`; the normal
migration work is changing the service URL and keys, plus a small, explicitly documented set of
project-specific incompatibilities when `doctor` finds one.

Minibase is not a full reimplementation or repackaging of Supabase. Realtime, Studio, Analytics,
full PostgREST/GoTrue behavior, OAuth/MFA/SAML, and arbitrary PostgreSQL extensions are outside the
current scope. The goal is a small migration surface and an operationally simple self-hosted runtime
for the common Supabase backend path.

## Contents

- [Project at a glance](#project-at-a-glance)
- [Quick start](#quick-start)
- [What Minibase provides](#what-minibase-provides)
- [Choose an edition](#choose-an-edition)
- [Migrate an existing project](#migrate-an-existing-project)
- [Configuration and operations](#configuration-and-operations)
- [Real-project acceptance](#real-project-acceptance)
- [Performance report](#performance-report)
- [Compatibility boundaries](#compatibility-boundaries)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Project at a glance

- Reuse an existing Supabase project without rewriting its migrations, seed, or Function source.
- Keep the normal `supabase-js` Auth, REST, Storage, and Functions request paths.
- Run Embedded with bundled PGlite, or Server with bundled/external PostgreSQL 18.4.
- Ship without a production dependency on Docker, Node.js, Supabase CLI, or a separate Deno install.
- Detect known SQL, Extension, Function, configuration, and engine incompatibilities before startup.
- Store generated state under `.minibase/`, separate from the `supabase/` source tree.

## Quick start

Start from a project root containing at least `supabase/config.toml`. Migrations, `seed.sql`, and
Functions are optional:

```text
your-project/
  supabase/
    config.toml
    migrations/
    seed.sql
    functions/
```

Every route below first runs `doctor`, then starts Minibase in the foreground. The default endpoint
is `http://127.0.0.1:54321`; readiness is `GET /health/ready`.

### Executable: Embedded / PGlite

Copy `minibase-embedded-windows-x64.exe` into the project and run:

```powershell
.\minibase-embedded-windows-x64.exe doctor --project . --engine pglite
.\minibase-embedded-windows-x64.exe start --project . --engine pglite
```

This is the smallest route: PGlite and the Function runtime are included, and no database service is
required.

### Executable: Server / PostgreSQL

Copy `minibase-server-windows-x64.exe` into the project and run:

```powershell
.\minibase-server-windows-x64.exe doctor --project . --engine postgres
.\minibase-server-windows-x64.exe start --project . --engine postgres
```

The Server executable extracts and manages its bundled PostgreSQL 18.4 Runtime. To use an existing
PostgreSQL database instead, set `MINIBASE_DATABASE_URL` before starting. Linux and macOS use the
same arguments with the corresponding release filename; run `chmod 755 <binary>` first.

### Source: Embedded / PGlite

Install the repository-pinned Deno version, clone this repository, and point `--project` at the
Supabase project:

```powershell
deno run -A src/main.ts doctor --project C:\apps\your-project --engine pglite
deno run -A src/main.ts start --project C:\apps\your-project --engine pglite
```

### Source: Server / PostgreSQL

Source mode does not embed the release archive. Connect a prepared PostgreSQL database:

```powershell
$env:MINIBASE_DATABASE_URL = "postgres://minibase:password@127.0.0.1:5432/minibase"
deno run -A src/main.ts doctor --project C:\apps\your-project --engine postgres
deno run -A src/main.ts start --project C:\apps\your-project --engine postgres
```

Alternatively, set `MINIBASE_POSTGRES_RUNTIME_DIR` to an audited PostgreSQL 18.4 Runtime root and
omit `MINIBASE_DATABASE_URL` to let source mode manage that local Runtime.

In another terminal, confirm readiness and inspect or stop the runtime:

```powershell
Invoke-WebRequest http://127.0.0.1:54321/health/ready
.\minibase-embedded-windows-x64.exe status --project . --engine pglite --json
.\minibase-embedded-windows-x64.exe stop --project . --engine pglite
```

For source mode, replace the executable in the last two commands with `deno run -A src/main.ts`.
Continue with [Migrate an existing project](#migrate-an-existing-project) for public URL, key, smoke
test, and production deployment settings.

Connect the application through the same Supabase client API. For local development, the client key
only needs to be a non-empty client identifier; after login, `supabase-js` sends the Minibase access
token for RLS and protected Functions:

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient("http://127.0.0.1:54321", "minibase-local", {
  auth: { persistSession: false },
});

const { data, error } = await supabase.auth.signInWithPassword({
  email: "alice@example.com",
  password: "correct horse battery staple",
});
if (error) throw error;
console.log(data.user);
```

## What Minibase provides

| Module           | Current capability                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Migration / Seed | timestamp-ordered SQL migrations, SHA-256 history, transactional recovery, and first-run `seed.sql`                   |
| Database         | common PostgreSQL SQL, JSONB, PL/pgSQL triggers, foreign keys, policies, `auth.uid()`, `auth.role()`, and RLS         |
| Auth             | signup, password and anonymous login, users, sessions, refresh, update, sign-out, basic Admin, and JWKS               |
| REST             | common insert/select/update/delete/upsert, filters, relationships, counts, range/order, schema headers, and RLS       |
| Storage          | local or S3-compatible objects, buckets, upload/download/delete/list, signed/public URLs, streaming, and repair       |
| Edge Functions   | `Deno.serve`, default Fetch exports, Deno config/lockfiles, JWT, CORS, workers, logs, egress policy, and OpenAPI docs |
| Operations       | `doctor`, dual-engine migration checks, health, structured logs, backup/restore, upgrades, repair, and key rotation   |

Requests keep their familiar Supabase paths:

| Path                              | Capability                                          |
| --------------------------------- | --------------------------------------------------- |
| `/auth/v1/*`                      | Auth and session APIs                               |
| `/rest/v1/*`                      | REST, PostgreSQL queries, and RLS                   |
| `/storage/v1/*`                   | Storage APIs                                        |
| `/functions/v1/<name>`            | Edge Functions                                      |
| `/functions/v1/docs`              | generated Function documentation and Try it console |
| `/functions/v1/docs/openapi.json` | generated OpenAPI 3.0.3 specification               |
| `/health/live`, `/health/ready`   | liveness and traffic readiness                      |

Function responses support normal JSON and OpenAI-compatible SSE streams. Storage uses local files
by default and can be switched to an S3-compatible Storage backend.

Minibase uses one implementation of every upper-layer API. Only the database adapter changes:

```mermaid
flowchart LR
  App["Application / supabase-js"] --> API["Minibase API gateway"]
  Project["Existing supabase/ project"] --> Migrate["Migration and seed runner"]
  Project --> Functions["Deno Function workers"]
  API --> Auth["Auth"]
  API --> REST["REST and RLS"]
  API --> Storage["Storage"]
  API --> Functions
  Auth --> DB["DatabaseEngine"]
  REST --> DB
  Storage --> DB
  Migrate --> DB
  DB --> PGlite["Embedded: PGlite"]
  DB --> Postgres["Server: PostgreSQL 18.4 or external PostgreSQL"]
  Storage --> Objects["Local files or S3-compatible storage"]
```

Runtime data is isolated in `.minibase/`; Minibase does not write generated state into the
`supabase/` source tree.

## Choose an edition

| Dimension                      | Embedded                                                                                       | Server                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Database                       | bundled PGlite                                                                                 | bundled PostgreSQL 18.4 or external PostgreSQL                                             |
| Best fit                       | evaluation, local development, desktop apps, personal services, NAS, low-to-medium concurrency | ordinary servers, team services, sustained concurrent writes, native PostgreSQL operations |
| Write concurrency              | one PGlite Worker protects transactions                                                        | pooled, parallel PostgreSQL backends                                                       |
| PostgreSQL TCP                 | not exposed                                                                                    | managed DB is loopback-only by default; external DB is operator-managed                    |
| Extensions                     | only capabilities verified in the pinned PGlite distribution                                   | capabilities installed in the bundled or external PostgreSQL runtime                       |
| Application API/project layout | the same                                                                                       | the same                                                                                   |

Start with Embedded when the smallest deployment is the priority. Use Server for a normal multi-user
service, higher write concurrency, PostgreSQL tooling/TCP, logical replication, or a required
extension. Physical PGlite and PostgreSQL directories are not interchangeable; edition changes use
logical backup and restore. See [Editions](./docs/EDITIONS.md).

## Migrate an existing project

### 1. Keep the Supabase project layout

```text
your-project/
  supabase/
    config.toml
    migrations/
    seed.sql
    functions/
```

Migrations, seed, and Functions are individually optional. No conversion step rewrites them.

### 2. Add the release binary

Use `minibase-embedded-<platform>` or `minibase-server-<platform>` from the release archive. Both
editions include Deno; Server also includes the audited PostgreSQL runtime. Production execution
does not require Docker, Node.js, Supabase CLI, or a separate Deno installation. On Linux/macOS:

Windows x64 releases are named `minibase-embedded-windows-x64.exe` and
`minibase-server-windows-x64.exe`.

```sh
chmod 755 ./minibase-server-linux-x64
```

### 3. Check compatibility before writing data

```sh
./minibase-server-linux-x64 doctor --project .
./minibase-server-linux-x64 migration check --project .
```

`doctor` checks layout, configuration, migrations, Function entrypoints and dependencies, database
capabilities, Storage, and known incompatibilities. `migration check` executes migrations in
isolated PGlite and PostgreSQL databases. Exit code `0` permits startup; exit code `2` identifies a
compatibility or safety item that must be reviewed.

### 4. Configure the public endpoint and secrets

Keep Supabase-compatible settings in `supabase/config.toml`; place Minibase-only settings in
`minibase.toml` and secrets in a protected Secret file or environment variables.

```toml
format_version = 1

[server]
host = "0.0.0.0"
port = 54321
public_url = "https://api.example.com"

[server.cors]
allowed_origins = ["https://app.example.com"]

[database]
engine = "postgres"
```

Change the application's Supabase URL to `public_url` and provide its Minibase client key. Existing
Functions continue reading `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`;
Minibase injects the current values according to Function policy. Do not commit
`.minibase/secrets.json`, database credentials, or service-role keys.

### 5. Start and verify

```sh
./minibase-server-linux-x64 start --project .
./minibase-server-linux-x64 status --project . --json
curl --fail http://127.0.0.1:54321/health/ready
```

Run the application's real smoke path after readiness, not only a health check. For the medium-sized
project acceptance, that path was signup -> login -> invoke `create_workflow` -> query the inserted
row -> verify RLS rejection.

Existing client code remains conventional:

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://api.example.com",
  process.env.SUPABASE_ANON_KEY!,
);

const { data, error } = await supabase.functions.invoke("create_workflow", {
  body: { name: "First workflow", icon: "workflow", workflow: {} },
});
if (error) throw error;
```

For a public server, terminate TLS at Minibase or a trusted reverse proxy, set an exact
`public_url`, restrict CORS and trusted proxies, protect Secret files, configure Function egress,
and rehearse backup/restore. See [Deployment](./docs/DEPLOYMENT.md) and
[Security](./docs/SECURITY.md).

## Configuration and operations

Configuration precedence is CLI arguments, environment variables, Secret file, `minibase.toml`,
`supabase/config.toml`, then defaults. A minimal local configuration is:

```toml
format_version = 1

[server]
host = "127.0.0.1"
port = 54321
public_url = "http://127.0.0.1:54321"

[database]
engine = "pglite"

[storage]
driver = "local"

[functions.network]
outbound = "allow"
allow_supabase_url = true
block_private_networks = false
```

Storage can use the project-local `.minibase/storage/` directory or an S3-compatible backend.
Function egress supports `allow`, `allowlist`, and `deny`; public deployments should normally use an
allowlist and `block_private_networks = true`.

| Command                                    | Purpose                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| `start` / `stop` / `status`                | control and inspect the runtime                                 |
| `doctor`                                   | preflight project, engine, Storage, and Function compatibility  |
| `migration check`                          | run migrations against isolated PGlite and PostgreSQL databases |
| `backup export` / `backup restore`         | logical database backup, optionally with Storage                |
| `reset --force` / `upgrade`                | safety-backed rebuild and data-format upgrade                   |
| `functions cache` / `functions logs`       | prepare dependencies and inspect persistent Function logs       |
| `storage check` / `storage repair --force` | verify or repair metadata/content consistency                   |
| `auth keys list/rotate/activate/remove`    | operate ES256 signing keys without printing private keys        |
| `version --json`                           | stable machine-readable build and runtime identity              |

Destructive commands require a stopped service, a validated target, and explicit `--force` where
applicable. Managed database listeners stay on loopback by default.

## Real-project acceptance

The strict acceptance run on 2026-08-26 used an isolated copy of a completed, medium-sized
Supabase-based project, not a purpose-built demo. The original source tree was left untouched.

| Acceptance input                           |                                         Measured value |
| ------------------------------------------ | -----------------------------------------------------: |
| Source/configuration baseline              |                                              279 files |
| SQL migrations                             |                                                     18 |
| Edge Function directories                  |                    73 (71 registered in `config.toml`) |
| Public schema                              |           10 tables, 16 policies, 7 RLS-enabled tables |
| Install-to-ready                           |                           **68,694.41 ms / 1.145 min** |
| Source/configuration changes after the run |                               **0 changed, 0 deleted** |
| Readiness                                  | Database, migrations, Storage, and Functions all ready |

The timer started when the Minibase Embedded executable was copied into a clean project copy and
stopped when `GET /health/ready` returned HTTP 200. The source-integrity comparison covered
`supabase/**`, `.env`, `deno.lock`, README, and project configuration by SHA-256. Runtime state and
generated Auth keys lived under `.minibase/` and were removed after the experiment.

| Workflow                              | Result                        | What was verified                                                |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Email registration and password login | PASS                          | HTTP 200 and stable user identity                                |
| CRUD                                  | PASS on the service-role path | insert/select/update/delete = 201/200/200/204                    |
| RLS isolation                         | PASS                          | authenticated access without a table grant was rejected with 403 |
| Storage                               | PASS on the service-role path | bucket, upload, download, and content verification               |
| `wf_echo`                             | PASS                          | GET and POST returned 200; response body matched                 |
| `create_workflow`                     | PASS                          | Function returned success and the inserted row was queried back  |

The two direct authenticated calls returned 403 because this medium-sized project's authorization
was not properly designed: its table grants and corresponding RLS/Storage Policies did not permit
authenticated direct writes. This project Policy defect is explicitly recorded and is not a Minibase
compatibility failure. The intended service-role Function path succeeded, while RLS still prevented
unauthorized reads. The run did not claim that all 71 Functions or external providers were
exercised.

The measured host was Windows 11, Intel Core Ultra 7 265K (20 logical CPUs), 32 GiB RAM, and Deno
2.9.2. The result has ample margin against the fifteen-minute criterion, but it is still one host;
run `doctor`, a fresh startup, and the application's own smoke test on the actual target server.

## Performance report

There are two complementary measurements. The fixed-runner suite compares startup and resources
using the same small compatibility project. The real-project suite compares the same representative
write Function and JSON payload from the medium-sized project on all three backends. They answer
different questions and must not be mixed.

### From a clean local project to ready

Fixed runner: Windows 11, Intel Core Ultra 7 265K, 20 logical CPUs, 32 GiB RAM. Minibase reports use
20 measured iterations, 5 warmups, 100 requests at concurrency 1/10/50/100, and process-tree RSS
sampling every 500 ms. The Supabase report uses Supabase CLI 2.110.0, Docker Desktop 4.43.2 / Engine
28.3.2, PostgreSQL 17.6.1.143, the same workload, and running-container working sets.

| Local backend                     | Fresh-project cold start | Retained-data warm start |         Idle application memory | Runtime shape                                              |
| --------------------------------- | -----------------------: | -----------------------: | ------------------------------: | ---------------------------------------------------------- |
| Minibase Embedded / PGlite        |              **3.177 s** |              **0.872 s** |                   291.6 MiB RSS | one Minibase process plus Function workers                 |
| Minibase Server / PostgreSQL 18.4 |              **5.895 s** |              **0.959 s** |       74.9 MiB process-tree RSS | Minibase plus managed PostgreSQL                           |
| Supabase local stack              |             **31.012 s** |             **23.569 s** | 467.5 MiB container working set | Docker services for DB/Auth/REST/Storage/Functions/gateway |

The Server cold start includes a first `initdb` (4.326 s). The Supabase comparison deliberately
excludes Realtime, Studio, Analytics/logging, imgproxy, mail UI, postgres-meta, Vector, and
Supavisor, so the table compares the services Minibase actually targets rather than claiming a
comparison with every Supabase feature. Docker container working set and native process-tree RSS are
different accounting systems; Docker Desktop's shared VM overhead is not included.

On this controlled workload, Minibase/PGlite used 96.3% less warm-start time and 37.6% less measured
idle application memory than the comparable Supabase local stack. Supabase was faster on the small
CRUD/RLS request-latency median (2.852 ms versus 3.726 ms), so this evidence supports Minibase's
startup and operational-footprint positioning, not a universal latency claim.

Raw evidence: [Minibase/PGlite](./benchmarks/supabase/minibase-windows-lab-01/minibase.json),
[Supabase local stack](./benchmarks/supabase/minibase-windows-lab-01/supabase.json),
[comparison](./benchmarks/supabase/minibase-windows-lab-01/comparison.json), and
[fixed-runner PGlite](./benchmarks/fixed/minibase-windows-lab-01/current/pglite.json) and
[PostgreSQL](./benchmarks/fixed/minibase-windows-lab-01/current/postgres.json) reports. The full
methodology is documented in [Performance](./docs/PERFORMANCE.md).

### Medium-sized project `create_workflow` workload

All three rows used the same host, Function source, JSON body, and client-to-response timing. Each
backend received 5 warmups, 40 sequential samples, then 5 batches of 10 concurrent requests (50
requests total). The request includes the gateway, Function execution, Auth validation, and a
database write; initial dependency downloads and service startup are excluded.

| Backend                                 |        Mean |         P50 |          P95 |          P99 | Concurrency 10 throughput | Concurrent mean latency |
| --------------------------------------- | ----------: | ----------: | -----------: | -----------: | ------------------------: | ----------------------: |
| Minibase + PGlite                       |    10.95 ms |    10.81 ms |     12.07 ms |     12.76 ms |                57.5 req/s |                149.5 ms |
| Minibase + PostgreSQL                   | **9.20 ms** | **8.94 ms** | **10.15 ms** | **12.32 ms** |           **171.0 req/s** |             **42.2 ms** |
| Supabase local stack, full project copy |    33.02 ms |    32.89 ms |     35.09 ms |     35.69 ms |               147.6 req/s |                 61.4 ms |

PGlite is the zero-external-database choice and was entirely adequate for this workflow. Managed
PostgreSQL reduced sequential P50 by 17.3% and delivered about 2.97x PGlite's concurrent throughput,
which is why Server is the better default for sustained concurrent writes. The Supabase local stack
remains the right option when an application requires the services Minibase does not implement.

The official Supabase comparison copy needed two recorded compatibility fixes: a placeholder for a
missing local module that its all-Function scanner followed from a commented import, and an explicit
`GRANT ALL ON public.workflow TO service_role`. Minibase required neither source change because its
bootstrap provides the intended service-role table path. These results describe this machine and
this lightweight JSON workflow; they are not a ranking for every SQL workload or production network.

## Compatibility boundaries

The traceable compatibility targets are Supabase CLI 2.110.0 project layout, `supabase-js` 2.110.9,
and the tested `@supabase/server` 1.4.1 Context subset on both engines. See the complete
[compatibility matrix](./docs/COMPATIBILITY.md).

Currently out of scope:

- Realtime protocol and broadcast/presence;
- Studio, Analytics, Logs Explorer, and the full Supabase management plane;
- full PostgREST or GoTrue parity, OAuth providers, MFA, SAML, CAPTCHA, and hosted email delivery;
- arbitrary PostgreSQL extensions; PGlite specifically has no PostgreSQL TCP, logical replication,
  PostGIS, `pgcrypto`, or `uuid-ossp` in the pinned distribution;
- automatic conversion of a PGlite physical directory into PostgreSQL;
- an OS security sandbox for mutually untrusted Function tenants.

Minibase reports unsupported behavior instead of silently rewriting SQL semantics. A project that
depends on an unlisted Supabase/PostgreSQL behavior must run `doctor`, `migration check`, and its
own end-to-end smoke tests before migration is accepted.

## Development

The source toolchain is pinned in `deno.json` and `toolchain.json`.

```sh
deno task fmt:check
deno task lint
deno task check
deno task test
deno task verify:baseline
```

Fixed-runner regression and 30-minute dual-engine soak evidence are committed under `benchmarks/`.
The soak run completed 1,787 cycles / 16,113 operations per engine with zero failures. Native
Rust/WASM optimization is profiling-gated and is not currently part of the product.

## Documentation

- [Getting started](./docs/GETTING_STARTED.md)
- [Production deployment](./docs/DEPLOYMENT.md)
- [Compatibility matrix](./docs/COMPATIBILITY.md)
- [Performance methodology and evidence](./docs/PERFORMANCE.md)
- [Embedded and Server editions](./docs/EDITIONS.md)
- [Security model](./docs/SECURITY.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Upgrade guide](./docs/UPGRADING.md)
- [Version and support policy](./docs/VERSIONS.md)

## License

Minibase is licensed under the [Apache License 2.0](./LICENSE). Release archives retain the
applicable Deno, PGlite, PostgreSQL, OpenSSL, ICU, and other third-party notices.

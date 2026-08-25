# Performance benchmark contract

Minibase performance results come from a real foreground CLI process, its real HTTP API, the
official pinned `supabase-js` client, and the unchanged `fixtures/supabase-basic` project. The fixed
correctness baseline does not enforce wall-clock budgets; performance has a separate raw report and
comparison path.

## Commands

- `deno task bench` benchmarks Embedded/PGlite.
- `deno task bench:postgres` benchmarks managed PostgreSQL 18.4. Set `MINIBASE_POSTGRES_RUNTIME_DIR`
  when the Runtime is not in the audited Windows development cache.
- `deno task bench:supabase` benchmarks the pinned Supabase CLI 2.110.0 local Docker stack on
  Windows x64. It requires the verified CLI archive at
  `.benchmarks/tooling/supabase-2.110.0/supabase_windows_amd64.tar.gz` or
  `MINIBASE_SUPABASE_CLI_ARCHIVE`, prewarms images outside the timed region, and excludes Realtime,
  Studio, analytics, image transformation, mail capture, metadata UI and Supavisor.
- `deno task bench:supabase:compare --minibase <pglite.json> --supabase <supabase.json>` requires
  clean reports from the same commit, fixed runner, hardware, fixture scale and concurrency matrix.
- `deno task bench:supabase:promote --minibase <pglite.json> --supabase <supabase.json>
  --output-dir benchmarks/supabase/<runner>`
  writes the two raw reports, recomputed comparison and SHA-256 manifest. Existing evidence is
  replaced only with explicit `--force`.
- `deno task bench:supabase:evidence:check` rehashes and recomputes every committed comparison and
  requires the full 20 iteration, 5 warmup and 100 request-per-concurrency scale.
- `deno task bench:compare --baseline <file> --current <file>` compares two results from the same
  fixed runner and engine.
- `deno task bench:gate --current-dir <dir> --baseline-dir <dir> --history <file> --output <file>`
  validates a fixed-runner PGlite/PostgreSQL pair, compares both engines, and writes an auditable
  gate result. Add `--promote` only after review; add `--accept-regressions` only with promotion
  when deliberately accepting reported regressions.
- `deno task soak:pglite` and `deno task soak:postgres` run the long-running reliability workload.
  The default and minimum gate duration is 30 minutes per engine.
- `deno task soak:promote --pglite <file> --postgres <file> --output-dir <dir>` promotes a validated
  pair from the same clean commit, fixed runner and hardware fingerprint. Replacing evidence
  requires the explicit `--force` flag.
- Add `--allow-unpinned-hardware` only for exploratory local comparisons. Such a comparison is not
  release or CI evidence.
- `deno task optimization:check` rejects tracked Rust, WebAssembly, Cargo or Rust toolchain files
  unless `optimization-policy.json` classifies every file. A native optimization must include a
  committed profiling report and distinct schema-3 before/after benchmark reports from the same
  clean fixed runner, hardware fingerprint, engine and workload configuration. Non-optimization
  native fixtures or third-party runtimes require an explicit purpose, reason and tracked license
  document instead of being silently treated as performance work.

The runner accepts `--output`, `--iterations`, `--warmups`, and `--concurrency-requests`. Defaults
are 20 measured iterations, 5 warmups, 100 requests at every concurrency level, and a timestamped
file under `.benchmarks/local/`. That directory is ignored by Git so repeated local runs do not
dirty the repository.

The Supabase Docker runner uses the same options and the same official `supabase-js` workload. It
records exact running container images and immutable digests, Docker Desktop/Engine/API/Compose
versions, fresh-volume and retained-volume startup, and five sums of the running containers' working
sets from `docker stats`. Secrets returned by `supabase status` remain process-local and are never
written to the report or included in command failures. Because the unchanged compatibility migration
grants table access only to `authenticated`, the temporary benchmark database adds `service_role`
table and sequence grants after startup so the existing cross-engine admin workload can run through
PostgREST; it does not modify the fixture files, data, RLS policies or timed startup.

## What is measured

Every report contains the raw latency samples as well as count, total, min, mean, p50, p95, p99,
max, and throughput:

- cold start on a fresh copied project and warm start against the initialized project;
- process-tree RSS sampled every 500 ms, including separate idle samples and the full-run peak;
- password sign-in;
- service-role insert, single select, list select, update, and delete;
- authenticated RLS select;
- local Storage upload and download with 4 KiB objects;
- the first and hot `echo` Edge Function invocation;
- authenticated RLS selects at concurrency 1, 10, 50, and 100;
- for PostgreSQL, raw `pg_stat_activity` samples during every concurrency level, the configured pool
  minimum/maximum, and a hard assertion that observed Minibase connections never exceed that
  maximum; the observer uses a separately named connection and is not counted as a pool member;
- Server also keeps one separately named `minibase-ownership` control connection outside the
  configured business pool; capacity planning must reserve it, while benchmark pool samples
  intentionally exclude it;
- for PostgreSQL, a simultaneous native `postgres.js` baseline against the same managed cluster,
  same seeded user and same authenticated RLS context: single-select latency plus 1/10/50/100
  concurrency raw samples. Its connections use the distinct application name
  `minibase-benchmark-direct`; the report stores raw `pg_stat_activity` observations and asserts
  that its separately recorded warm-pool maximum is not exceeded;
- a same-platform `deno compile` candidate size, SHA-256, and `version --json` smoke.

The compiled candidate is a size probe, not a release artifact. Compiled Function subprocess
execution and final distribution packaging remain release work and are stated as a limitation in
every raw report.

Functions additionally emit `function_startup_metric` JSONL records for:

- dependency cache preparation during server startup;
- the complete Deno TypeScript/import-graph check before a Function Worker starts;
- subprocess spawn through the Worker ready signal.

There is deliberately no successful-type-check cache yet. Each cold Worker start checks the full
dependency graph, so an incomplete fingerprint cannot hide a changed transitive dependency. A future
cache must prove complete dependency-graph invalidation before this behavior can change.

## Fixed-runner rule

Set `MINIBASE_BENCHMARK_RUNNER` to a stable identifier only on a dedicated machine or stable CI
runner. A report is eligible for regression gating only when:

- that identifier is present and valid;
- the Git worktree is clean;
- baseline and current reports have the same runner identifier, hardware fingerprint, engine, and
  schema version.

The hardware fingerprint covers OS/release, architecture, CPU model, logical CPU count, total
memory, and the recorded power-source field. Hostnames and credentials are not recorded. Local
results without a runner identifier are still useful for profiling, but the report labels them
exploratory and the comparison command rejects them by default.

Stable CI should retain the timestamped raw JSON as an artifact and promote an accepted result to a
runner/engine-specific historical baseline. PGlite and PostgreSQL baselines must never be mixed.
PostgreSQL reports with different configured Minibase or native-driver pool limits are also not
comparable. Benchmark report schema 3 requires both connection-pool evidence and a same-run native
PostgreSQL baseline for PostgreSQL, while marking both as not applicable to PGlite.

The repository also preserves the first promoted baseline and an immediate comparison from the fixed
Windows lab runner `minibase-windows-lab-01` under `benchmarks/fixed/minibase-windows-lab-01/`. Both
report pairs reference clean commit `1945e073aba09f9294da1d9fb79bca778e5eb74d`, share one hardware
fingerprint and use the full default 20 iterations, 5 warmups and 100 requests at concurrency
1/10/50/100. The comparison passed 28 PGlite and 37 PostgreSQL metrics without accepting
regressions. `deno task benchmark:evidence:check` recomputes all file hashes, repeats the gate
evaluation and enforces the committed warm-start, CRUD and hot Function budgets during the normal
`check` task.

The same runner also preserves a same-commit Supabase Docker comparison under
`benchmarks/supabase/minibase-windows-lab-01/`. Both reports reference clean commit
`751250a5876ba336d972421bab3f419952184b52`, use hardware fingerprint
`462f93fae9a13eb665edced36888eacdf83a2e6584f39522b0c8f19bd5e35511`, and run 20 measured iterations,
5 warmups and 100 requests at concurrency 1/10/50/100. Supabase CLI 2.110.0 ran on Docker Desktop
4.43.2 / Engine 28.3.2 with PostgreSQL 17.6.1.143, Kong, GoTrue, PostgREST, Storage API and Edge
Runtime image digests fixed in the raw report. Minibase warm startup was 1,008.464 ms versus
24,545.29 ms and idle application memory was 300,638,208 versus 488,853,472 bytes, passing the 30%
material-advantage threshold in two categories. Supabase was faster for the simple CRUD/RLS p95
median, 1.808 ms versus Minibase's 3.7615 ms; the committed comparison retains that result rather
than treating the overall gate as a request-latency win. The normal `check` task rehashes and
recomputes this evidence.

The repository currently contains no tracked Rust/WASM product implementation. The profiling-first
gate therefore records zero native optimizations instead of claiming an unmeasured cross-language
speedup. Adding a `.rs`, `.wasm`, `.wat`, Cargo manifest/lockfile, Rust toolchain file or `.cargo`
configuration without the required evidence makes the normal `check` task fail closed.

The repository workflow `.github/workflows/fixed-benchmark.yml` is deliberately limited to weekly
schedule, authorized manual dispatch, and version-toolchain changes already merged to `main`; it
never runs pull-request code on the self-hosted machine. Version changes run format/lint/check, the
full test suite, the fixed PGlite baseline, the real PostgreSQL 18.4 tests, and then both
performance benchmarks. Provision one Windows x64 runner with labels `self-hosted`, `Windows`,
`X64`, and `minibase-benchmark`, exact GitHub Actions Runner 2.335.1, Deno 2.9.2, and PostgreSQL
18.4. Configure these repository variables:

- `MINIBASE_BENCHMARK_RUNNER`: a stable logical machine id that does not change between runs;
- `MINIBASE_POSTGRES_RUNTIME_DIR`: the audited PostgreSQL 18.4 Runtime root containing
  `bin/postgres.exe`.

Every successful run restores the latest runner-specific cache state, runs both engines, appends an
entry to a 500-record bounded JSONL trend, and saves a new immutable cache key. It also uploads the
two full current reports, complete promoted baseline with its SHA-256 manifest, gate result, and
trend as a 90-day workflow artifact. The first baseline requires manual `promote_baseline`; later
promotion is also manual. A detected regression fails by default and can be promoted only when
`accept_regressions` is explicitly enabled in the same dispatch, leaving the accepted regression
visible in the result and trend.

## Long-running reliability gate

The separate soak gate continuously runs a cleanup-bounded cycle through the real CLI/API and the
official pinned `supabase-js` client:

- `/health/ready`;
- periodic password sign-in;
- service-role insert/update/delete plus authenticated RLS select;
- 4 KiB local Storage upload/download/remove;
- a hot `echo` Edge Function invocation.

Each engine must run for at least 1,800 seconds and finish at least 300 complete cycles. Every cycle
operation has a 10-second timeout. The report fails if any operation fails, the final readiness
probe fails, a row or Storage object remains, the server exits unsuccessfully, or stderr is not
empty. Process-tree RSS is sampled every 30 seconds; the gate fails only when the median of the last
20% of samples exceeds the first 20% median by both more than 64 MiB and more than 25%. Raw memory
samples, operation latency summaries, runner/hardware/toolchain identity and Git cleanliness are
stored in the report.

Committed evidence under `benchmarks/soak/minibase-windows-lab-01/` comes from clean commit
`eb0d5c847e9afc4d39c1ecdd046f21af7befa4fc`. PGlite and managed PostgreSQL 18.4 each completed 1,788
cycles and 16,122 operations in just over 30 minutes with zero failures, successful final cleanup
and zero stderr. PGlite process-tree RSS grew 59,994,112 bytes (13.6352%) with a 795,463,680-byte
peak; PostgreSQL grew 27,389,952 bytes (13.4945%) with a 245,096,448-byte peak. The manifest pins
both report SHA-256 values, and `deno task soak:evidence:check` revalidates the pair during normal
`check` runs.

`.github/workflows/fixed-soak.yml` repeats the two 30-minute gates on the audited Windows fixed
runner for weekly schedules, authorized manual dispatches and relevant changes already merged to
`main`. It runs the full correctness closure before the soak and uploads both reports for 90 days;
it never executes pull-request code on the self-hosted runner.

## Regression thresholds

`bench:compare` currently fails on:

- artifact growth above 10%;
- idle/peak RSS growth above 15%;
- cold/warm startup, Function startup phases, workload p95, or concurrency p95 growth above 20%;
- concurrency throughput loss above 15%.

The comparison reports every failing metric and exits with code 2. Thresholds are intentionally
coarse until a stable runner has enough history to characterize normal variance.

## Interpretation boundaries

- Cold-start peak RSS may include Deno dependency-cache and type-check subprocesses; use idle RSS
  for steady-state memory and retain the full peak for capacity planning.
- Managed PostgreSQL cold start includes first `initdb`; the raw runtime metrics separately record
  initialization and PostgreSQL process startup.
- Function latency excludes user remote-network work in the local `echo` fixture.
- The concurrency matrix exercises the Supabase-compatible HTTP/RLS path, not a direct database
  driver. PostgreSQL reports publish a second matrix using `postgres.js` directly against the same
  database and authenticated RLS context, so HTTP-path latency can be interpreted beside the native
  database floor instead of against a different dataset or run.
- A Supabase comparison counts a category as a significant Minibase advantage only when the
  Minibase/Supabase ratio is at most 0.70. The three categories are retained-volume warm startup,
  idle application memory, and the median p95 across insert, single/list select, update, delete and
  authenticated RLS select. At least two categories must pass. Container working-set memory and a
  native process-tree RSS are not identical accounting systems, so the raw scope remains explicit
  and Docker Desktop's shared VM overhead is deliberately excluded.

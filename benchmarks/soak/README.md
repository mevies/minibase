# Fixed-runner soak evidence

This directory stores promoted dual-engine reliability reports from a clean fixed runner.

The gate requires both Embedded/PGlite and Server/PostgreSQL reports from the same commit, runner,
hardware fingerprint and Deno toolchain. Each engine must run the mixed Auth, CRUD/RLS, Storage,
Functions and readiness workload continuously for at least 30 minutes, complete at least 300 full
cycles, finish ready with no leaked rows or objects, exit without stderr, and keep process-tree RSS
growth within either 64 MiB or 25% between the first and last sample windows.

Local and CI output belongs under `.benchmarks/soak/`. Promote a verified pair with
`deno task soak:promote --pglite <path> --postgres <path> --output-dir
benchmarks/soak/<runner-id>`;
overwriting existing evidence requires the explicit `--force` flag.

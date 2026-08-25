# Windows lab benchmark evidence

This directory preserves the first promoted schema 3 benchmark baseline for the fixed runner
`minibase-windows-lab-01` and an immediate second run evaluated against it.

- Source commit: `1945e073aba09f9294da1d9fb79bca778e5eb74d`
- Hardware fingerprint: `462f93fae9a13eb665edced36888eacdf83a2e6584f39522b0c8f19bd5e35511`
- Windows: 10.0.26200 x86_64
- CPU: Intel Core Ultra 7 265K, 20 logical CPUs
- Memory: 33,663,070,208 bytes
- Benchmark configuration: 20 measured iterations, 5 warmups, 100 requests at concurrency
  1/10/50/100

The second run passed all 28 PGlite and 37 PostgreSQL regression checks without accepting any
regression. Its headline results were:

| Metric                         | PGlite      | PostgreSQL 18.4 |
| ------------------------------ | ----------- | --------------- |
| Cold start                     | 2,889.315ms | 4,448.864ms     |
| Warm start                     | 744.435ms   | 1,020.288ms     |
| Idle process-tree RSS          | 302,034,944 | 69,140,480      |
| Peak process-tree RSS          | 754,409,472 | 256,630,784     |
| Candidate executable           | 115,923,977 | 115,923,979     |
| Authenticated RLS p95          | 3.920ms     | 3.503ms         |
| Native PostgreSQL RLS p95      | N/A         | 0.780ms         |
| Maximum observed business pool | N/A         | 8 of 8          |

PGlite hot-path p95 values were at most 3.942ms across insert/select/list/update/delete and 4.055ms
for the hot `echo` Function. The committed evidence therefore satisfies the current Embedded warm
start, CRUD and hot Function budgets, and the Server warm-start budget.

This is Minibase fixed-runner evidence, not a Supabase comparison. Docker Desktop 28.3.2 was
installed when the reports were captured, but its Linux engine pipe was unavailable. No comparative
advantage over Supabase is claimed until the same runner records a pinned local Supabase stack.

`deno task benchmark:evidence:check` verifies every recorded file size and SHA-256, report identity,
baseline manifest, raw history, fresh gate evaluation and the stated performance budgets.

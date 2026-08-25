# Minibase Security Model and Threat Boundaries

[English](./SECURITY.md) | [简体中文](./SECURITY.zh-CN.md)

Minibase targets single-machine, self-hosted, and trusted Supabase project code. Its security goal
is to protect the data, identity, secrets, Storage, and runtime boundaries of one project against
untrusted remote requests, malicious input, forged proxy headers, common credential leaks, path
traversal, SQL injection, and bounded SSRF. It is not an untrusted multi-tenant Function platform,
and it does not treat project migrations, seeds, or Functions as hostile code.

## 1. Security assumptions

The following are part of the trusted computing base:

- The host, operating system, service account, and administrator running Minibase;
- The project's `supabase/migrations`, `supabase/seed.sql`, `supabase/functions`, and explicit
  configuration;
- Configured TLS termination proxies, external PostgreSQL, S3-compatible services, and secret
  managers;
- EXEs, `release-manifest.json`, SHA-256 files, and license manifests in the official release set.

The following inputs must be treated as untrusted:

- Remote client URLs, headers, JWTs, JSON, multipart and streaming bodies, and disconnect behavior;
- Unvalidated `Forwarded`, `X-Forwarded-*`, Origin, and client IP values;
- Auth user-writable fields, REST identifiers/filters, Storage bucket/object names, and user
  metadata;
- Error bodies returned by S3, external PostgreSQL, proxies, and external HTTP APIs;
- DNS results, redirect targets, and remote responses accessed by Functions.

If multiple mutually untrusted tenants can modify Functions, migrations, seeds, the project `.env`,
or `minibase.toml`, this model no longer holds. Such deployments need separate operating-system
identities, containers/VMs, per-request execution units, or equivalent strong isolation.

## 2. Protected assets

- PGlite/PostgreSQL data, RLS identity context, and migration history;
- Local or S3 Storage bodies, metadata, recovery journals, and consistency state;
- Auth private keys, legacy HS256 secrets, service-role tokens, refresh tokens, and sessions;
- External PostgreSQL URLs, S3 credentials, Function secrets, and proxy credentials;
- Logical/physical backups, runtime logs, diagnostic reports, and upgrade state;
- Versioned Deno/PostgreSQL runtime caches and final release artifacts.

## 3. Trust boundaries

```text
Remote client
    |
TLS / reverse proxy (optional and must be explicitly trusted)
    |
Minibase single HTTP listener
    |-- Auth / REST / Storage / Functions gateway
    |-- DatabaseEngine -> PGlite Worker or PostgreSQL
    |-- ObjectStore -> local filesystem or S3-compatible service
    `-- FunctionManager -> restricted Deno subprocess -> external HTTP(S)

Administrator / CI
    `-- CLI, project directory, secrets, backups, release manifest, and runtime cache
```

Every authenticated database request sets the role and JWT claims in a request-scoped transaction,
then rolls back or commits and clears the context. REST is not forwarded through an internal HTTP or
PostgREST subprocess. Function subprocesses are separated from the main process, but one Function
process can still serve multiple trusted requests; this is not a strict per-request sandbox.

## 4. Default security configuration

| Boundary                          | Default             | Meaning                                                                                  |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| API listener                      | `127.0.0.1:54321`   | Not directly exposed to the LAN or public internet by default                            |
| CORS origins                      | Empty list          | Browser preflight returns 403 by default; non-browser requests still require normal auth |
| Trusted proxies                   | Empty list          | An untrusted peer cannot use forwarding headers to override client IP, protocol, or Host |
| Request body                      | 64 MiB              | Both declared and streaming bodies are bounded                                           |
| Request timeout                   | 60 seconds          | Cancels body, Function proxy, and cancellable database work on timeout                   |
| Global concurrency                | 256                 | A slot is held until the response completes; excess requests return 503                  |
| Auth password                     | 12-256 characters   | New passwords reject control characters and use a uniform policy                         |
| Auth recent-auth                  | 300 seconds         | Email or password changes require a recent password login                                |
| Auth rate limits                  | Enabled per process | Registration, password, refresh, and user updates use bounded IP/identity buckets        |
| Function processes                | 2 per Function      | Bounded pool with timeout and crash recycling; not a tenant-isolation boundary           |
| Function outbound                 | `allow`             | Compatibility default for existing Supabase Functions; tighten explicitly in production  |
| Function private-network blocking | `false`             | Evaluate the topology and enable this in production                                      |
| Service-role injection            | Enabled by default  | Functions that do not need admin privileges should disable it explicitly                 |
| Storage                           | Local filesystem    | No S3 dependency by default; paths are confined to the configured root                   |

Defaults balance local migration compatibility and are not the least-privilege configuration for
every production topology. Before launch, tighten the deployment according to the
[production deployment guide](./DEPLOYMENT.md).

## 5. Network exposure, proxies, and client identity

- The default listener binds to loopback; public deployments should terminate TLS through a
  same-host reverse proxy.
- Configure `server.trusted_proxies` / `MINIBASE_TRUSTED_PROXIES` only with actual proxy IPs or
  CIDRs. Minibase walks the trusted proxy chain from right to left and selects the first untrusted
  address; malformed protocol, Host, port, or address values fail closed.
- A connection outside the trusted-proxy list cannot spoof the client IP through `Forwarded` or
  `X-Forwarded-*`. Rate limiting and audit records use only the normalized address.
- Direct public listeners must use HTTPS, an exact public URL, exact CORS origins, and entry-layer
  connection and bandwidth limits.
- Managed PostgreSQL listens on the local host by default; PGlite does not expose a PostgreSQL TCP
  listener.

## 6. CORS and CSRF

Minibase Auth, REST, Storage, and Functions use explicit `Authorization: Bearer ...` and `apikey`
headers. The server does not create authentication cookies, so browsers do not automatically attach
a Minibase session and common cookie-based CSRF does not apply to this authentication protocol. CORS
has no allowed origins by default; the allowlist controls browser cross-origin calls, not server
authorization.

The following boundaries still apply:

- Do not use `*` as a production origin list; allow only the actual frontend origins.
- A request passing CORS must not skip JWT, RLS, service-role, or Storage policy checks.
- If a reverse proxy or upper layer converts tokens to cookies, that layer must add `SameSite`,
  `Secure`, `HttpOnly`, Origin/Referer validation, and CSRF tokens. Minibase does not provide
  implicit CSRF protection for cookies introduced outside the service.
- Non-browser clients are not subject to CORS and must always rely on authentication, RLS, rate
  limits, and request boundaries.

## 7. Auth, authorization, and service role

- An ES256 keyring is generated by default and the public JWKS contains only public keys. Legacy
  HS256 tokens may continue to be verified according to the migration policy.
- Passwords, sensitive fields, recent-auth, session revocation, refresh rotation, and audit
  boundaries are described in [Auth security](./AUTH_SECURITY.md) and [Auth keys](./AUTH_KEYS.md).
- Ordinary database requests allow only `anon`, `authenticated`, or `service_role`, with role and
  claims set inside the transaction.
- `service_role` bypasses RLS and must be treated as a master key. A public Function should set:

```toml
[functions.public-api]
inject_service_role_key = false
```

- The Function gateway normalizes the internal publishable/secret key only after validating the
  caller identity; a forged JWT cannot be downgraded or upgraded into a different privilege level.
- Auth and Function rate limiters are bounded in-process memory implementations. They reset on
  restart and do not coordinate across Minibase instances. Public deployments still need
  reverse-proxy, WAF, or gateway-wide limits.

## 8. SQL, RLS, and input handling

- REST, Auth, Storage, and system queries use bound parameters for runtime values. Dynamic
  identifiers go through a shared quoting function, and limited syntax fragments come from code
  enumerations.
- `deno task sql:check` audits dynamic-SQL boundaries; malicious identifiers, filters, and values
  are verified in dual-engine fixtures.
- Migrations and seeds are trusted project scripts and execute as written. Minibase does not
  silently rewrite unsupported SQL; incompatible capabilities are reported before execution or fail
  explicitly.
- Each identity request uses a transaction-level role/JWT context. Failed requests roll back, and
  neither a connection nor the PGlite queue can leak identity to a later request.
- Request body size, complex selects, result counts, multipart streams, and timeouts must remain
  bounded; see [request protection](./REQUEST_PROTECTION.md).

## 9. Storage and filesystem

- Bucket and object names are checked for characters, empty segments, backslashes, `..`, NUL, and
  containment under the resolved root. Local objects cannot escape the Storage root.
- Storage metadata remains authorized by database RLS/policies. Public buckets, signed URLs, and
  service role are explicit exceptions and do not bypass authorization merely because the filesystem
  is local.
- Upload bodies stream into temporary objects. A database commit failure is compensated, and the
  recovery journal rolls back or completes the switch at startup.
- Bucket size and MIME limits, the global body limit, and disk-space errors jointly bound uploads.
- S3 endpoints and responses are external trust boundaries. Error bodies, credentials, and
  signatures must not enter client responses or ordinary logs. Real AWS S3/R2/MinIO
  dual-implementation acceptance is not complete. A second Minibase writer connected to the same
  PostgreSQL database is rejected by an ownership advisory lock. Different databases/clusters
  sharing an S3 root bucket use an internal control object with `If-None-Match` acquisition and
  `If-Match` heartbeat/release mutual exclusion. Backends missing ETags or ignoring 412 conditional
  semantics fail closed.

## 10. Edge Functions, SSRF, and secret exfiltration

The Function runtime uses a separate Deno subprocess with the host environment cleared. It injects
only Minibase built-ins, project Function secrets, and required system/TLS/proxy variables. Read
access is limited to `supabase/`, versioned caches, and explicitly configured certificate paths.
Network permissions are the intersection of project and Function-level policies.

Start production deployments with the least privilege:

```toml
[functions.network]
outbound = "allowlist"
allowed_hosts = ["api.openai.com:443"]
allow_supabase_url = true
block_private_networks = true
```

Use `outbound = "deny"` to disable external networking completely. Function-level policies can
preserve or further tighten the project policy. Private-network blocking checks known cloud-metadata
hosts, IP/CIDR ranges, DNS A/AAAA results, and redirect targets; a 307/308 private redirect that
would preserve the request body fails closed. Proxy environment variables also need a separately
restricted proxy reachability range.

Residual risks must remain explicit:

- The defaults `functions.network.outbound = "allow"` and `block_private_networks = false` preserve
  compatibility and are not suitable for unaudited Functions.
- SSRF hardening covers the HTTP(S) paths of standard `fetch`; it is not an operating-system network
  sandbox and does not claim to cover future Node compatibility layers, raw sockets, FFI, or new
  protocols.
- One Function process can serve multiple trusted requests. Timeout and crash handling recycle the
  affected process, but do not provide strict per-request memory isolation.
- A Function can deliberately send any secret it receives to an allowed remote. Log redaction
  reduces accidental recording but cannot constrain malicious trusted code; minimal secret injection
  and minimal outbound allowlists are the primary controls.

## 11. Secrets, logs, and diagnostics

- Auth secret files managed by Minibase reject symlinks and non-regular files. Unix permissions are
  tightened to `0600`; on Windows, only the current account and SYSTEM retain Full Control.
- External secret files are limited to 1 MiB and to importable variables. Kubernetes-style symlinks
  are the deployment's responsibility for target permissions and atomic rotation; Doctor reports
  risks but does not modify user files.
- Logs record method, module, status, request ID, and duration, but not URL queries, headers, or
  bodies. Loaded database URLs and Auth, Function, and S3 secrets are part of one redaction set.
- Doctor never prints secret values and reports remediation advice for weak or placeholder values,
  permissions, owners, and link risks.
- Redaction is not a data-loss-prevention boundary. Do not place `.minibase/`, backups, or logs in
  public download directories, and do not upload raw diagnostic bundles to public tickets.

## 12. Supply chain, releases, and runtime integrity

- Before deployment, verify EXE SHA-256 values against `release-manifest.json` and keep the license
  files for an edition as an inseparable release set.
- Deno and PostgreSQL runtimes use versioned caches and per-file/directory manifests. Missing,
  modified, extra files, extra directories, or symlinks cause startup to be rejected.
- The six direct packages and 37 transitive/license packages for the PostgreSQL 18.4 Linux x64
  runtime have fixed HTTPS URLs, sizes, and SHA-256 values before build. Except at the glibc
  boundary, dynamic dependencies and licenses must resolve inside the fixed package root; the build
  host cannot supply them.
- Dependency versions, release dates, and the six-month non-latest policy are audited by
  `deno task versions:check`.
- Function remote dependencies must be in the lockfile and offline cache; production startup must
  not depend on temporary public-network resolution.

## 13. Backups, upgrades, and recovery

- Offline logical backups exclude project secrets by default. When Storage is included, bodies,
  sizes, and SHA-256 values are verified.
- Local physical backups and upgrade copies inherit restricted permissions. A failed upgrade
  restores state, the database, local Storage, and Minibase-managed secrets.
- External PostgreSQL permits only a manifest-declared format v1-to-v2 metadata-only upgrade when
  database, Storage, and secrets are all read-only. The actual major version is checked with
  read-only queries; on failure, local state is restored and the external database is not written.
  Future database-write steps are rejected until transactions or verifiable snapshots exist.
- S3 Storage can perform a metadata-only upgrade declared `read-only` in the current manifest; that
  path does not list, read, or write remote objects. An upgrade plan declaring `storage: "write"`
  must first hold root ownership, stream all non-control objects to a local backup, and verify them
  again. Write failures restore and verify objects individually; an incomplete rollback retains the
  backup and fails closed. Do not edit manifests or effects by hand to bypass the actual upgrade and
  recovery boundaries.
- S3 reset is allowed only in a maintenance window with the project stopped and root bucket
  ownership acquired before the snapshot. Before deleting remote objects, all original backend keys
  and bodies except the ownership control object are streamed to a restricted local backup with
  size, MIME, and SHA-256 recorded, then the remote inventory is verified again. Partial deletion or
  database rebuild failure restores every key, verifies each object, and restores the database's
  physical directory. Reset fails before any remote mutation if another Minibase writer holds the
  lock.
- Backups must be encrypted, stored off-host, and restored in a real exercise. Successfully
  generating a backup does not prove that it is recoverable.

## 14. Known incomplete boundaries

- No untrusted multi-tenant or strict per-request Function sandbox is provided.
- No distributed Auth/Function rate limiting is provided across multiple Minibase instances.
- Real cloud-provider authentication for AWS S3, Cloudflare R2, and MinIO is optional follow-up
  validation. Without credentials, controlled protocol tests must not be presented as provider
  certification.
- The S3 reset local full snapshot and automatic rollback have passed controlled protocol fault
  injection. Shared bucket Minibase writers have conditional ownership, but an administrator using
  `storage unlock --force` can still break this boundary; the deployment layer must confirm that
  every writer has stopped before running that command. The current metadata-only upgrade does not
  access remote objects; generic Storage write-upgrade snapshots have been verified against a
  controlled-protocol service. Read-only external PostgreSQL upgrades likewise do not imply that
  future database writes have transaction or snapshot support.
- The fixed benchmark runner and 30-minute dual-engine long-run gate have repository evidence; a
  same-host Supabase Docker comparison is not complete.
- Native Linux x64 Embedded/Server release smoke tests passed on WSL2 Ubuntu 24.04.2; macOS
  arm64/x64 have not yet been validated on real target machines.

These limits must remain in the compatibility matrix, release notes, and deployment reviews. They
must not be silently weakened through configuration or wording.

## 15. Production security checklist

- [ ] Verify release SHA-256 values, the manifest, runtime cache, and Doctor with the production
      service account.
- [ ] Keep the default loopback listener; give public entry points TLS, exact CORS origins, exact
      trusted proxies, and global rate limiting.
- [ ] Set `inject_service_role_key = false` for every Function that does not need admin privileges.
- [ ] Review `functions.network.outbound`, its allowlist, and `block_private_networks` per Function.
- [ ] Keep secrets, `.minibase/`, logs, and backups out of the repository, public directories, and
      broadly shared disks.
- [ ] Exercise Auth key rotation, backup recovery, event-log retention, and revocation procedures.
- [ ] Confirm that S3, external PostgreSQL, multiple instances, and custom proxies remain within the
      verified boundaries in this document.

When a suspected leak is found, first stop the exposed entry point, preserve redacted logs and
manifests, rotate the affected Auth/S3/database/Function secrets, revoke sessions and refresh
tokens, check database and Storage consistency, and restore from a verified backup. Do not run reset
or repair, or manually delete runtime/data directories, until evidence has been preserved.

import { assertEquals, assertNotEquals } from "@std/assert";
import { assertLinuxPostgresPackageManifest } from "./postgres_linux_policy.ts";
import { assertMacosPostgresSourceRecords } from "./postgres_macos_source.ts";

interface AuditedVersion {
  required: string | null;
  latestAtAudit?: string;
  publishedAt?: string;
  latestPublishedAt?: string;
  windowsX64ExecutableSha256?: string;
  windowsX64ArchiveSha256?: string;
  windowsX64ArchiveBytes?: number;
  windowsX64ArchiveUpdatedAt?: string;
  linuxX64ExecutableSha256?: string;
  macosX64ExecutableSha256?: string;
  macosArm64ExecutableSha256?: string;
  macosX64ArchiveSha256?: string;
  macosX64ArchiveBytes?: number;
  macosX64ArchiveUpdatedAt?: string;
  macosArm64ArchiveSha256?: string;
  macosArm64ArchiveBytes?: number;
  macosArm64ArchiveUpdatedAt?: string;
  linuxX64ArchiveSha256?: string;
  linuxX64ArchiveBytes?: number;
  linuxX64ArchiveUpdatedAt?: string;
  linuxX64NpmPackage?: string;
  linuxX64NpmTarballBytes?: number;
  linuxX64NpmTarballSha1?: string;
  linuxX64NpmTarballSha512?: string;
  linuxX64NpmPublishedAt?: string;
  linuxX64BuildOs?: string;
  linuxX64PgdgKeyFingerprint?: string;
  linuxX64Packages?: Array<{
    name: string;
    version: string;
    fileName: string;
    url: string;
    bytes: number;
    sha256: string;
  }>;
  linuxX64DependencyPackages?: Array<{
    name: string;
    version: string;
    fileName: string;
    url: string;
    bytes: number;
    sha256: string;
  }>;
  macosMinimumVersion?: string;
  macosSource?: {
    fileName: string;
    url: string;
    bytes: number;
    sha256: string;
    updatedAt: string;
  };
  sourceFileName?: string;
  sourceUrl?: string;
  sourceBytes?: number;
  sourceSha256?: string;
  sourceUpdatedAt?: string;
  commitSha?: string;
}

interface Toolchain {
  auditedAt: string;
  policy: {
    maximumAgeDays: number;
    allowLatest: boolean;
    rustMayUseLatest: boolean;
    databaseMayUseLatest: boolean;
  };
  runtimes: {
    deno: AuditedVersion;
    githubActionsRunner: AuditedVersion;
  };
  components: {
    pglite: AuditedVersion;
    postgres: AuditedVersion;
    postgresMacosOpenSsl: AuditedVersion;
    postgresDriver: AuditedVersion;
    stdPath: AuditedVersion;
    smolToml: AuditedVersion;
    supabaseJs: AuditedVersion;
    supabaseServer: AuditedVersion;
    supabaseCli: AuditedVersion;
    githubActionsCheckout: AuditedVersion;
    githubActionsCache: AuditedVersion;
    githubActionsUploadArtifact: AuditedVersion;
  };
}

const toolchain = JSON.parse(
  await Deno.readTextFile(new URL("../toolchain.json", import.meta.url)),
) as Toolchain;
const denoConfig = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { imports?: Record<string, string> };
const fixedBenchmarkWorkflow = await Deno.readTextFile(
  new URL("../.github/workflows/fixed-benchmark.yml", import.meta.url),
);
const fixedSoakWorkflow = await Deno.readTextFile(
  new URL("../.github/workflows/fixed-soak.yml", import.meta.url),
);
const macosEmbeddedReleaseWorkflow = await Deno.readTextFile(
  new URL("../.github/workflows/macos-embedded-release.yml", import.meta.url),
);
const macosServerReleaseWorkflow = await Deno.readTextFile(
  new URL("../.github/workflows/macos-server-release.yml", import.meta.url),
);
const officialReleaseWorkflow = await Deno.readTextFile(
  new URL("../.github/workflows/official-release.yml", import.meta.url),
);
const fixedRunnerWorkflows = [fixedBenchmarkWorkflow, fixedSoakWorkflow, officialReleaseWorkflow];
const auditedWorkflows = [
  ...fixedRunnerWorkflows,
  macosEmbeddedReleaseWorkflow,
  macosServerReleaseWorkflow,
];

const requiredDeno = toolchain.runtimes.deno.required;
if (requiredDeno === null) {
  throw new Error("toolchain.json must pin a Deno version");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.windowsX64ExecutableSha256 ?? "")) {
  throw new Error("toolchain.json must pin the Windows x64 Deno executable SHA-256");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.windowsX64ArchiveSha256 ?? "")) {
  throw new Error("toolchain.json must pin the Windows x64 Deno archive SHA-256");
}
if (toolchain.runtimes.deno.windowsX64ArchiveBytes !== 42_721_120) {
  throw new Error("toolchain.json must pin the audited Windows x64 Deno archive size");
}
if (toolchain.runtimes.deno.windowsX64ArchiveUpdatedAt !== "2026-07-08T12:35:52Z") {
  throw new Error("toolchain.json must pin the audited Windows x64 Deno archive timestamp");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.linuxX64ExecutableSha256 ?? "")) {
  throw new Error("toolchain.json must pin the Linux x64 Deno executable SHA-256");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.macosX64ExecutableSha256 ?? "")) {
  throw new Error("toolchain.json must pin the macOS x64 Deno executable SHA-256");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.macosArm64ExecutableSha256 ?? "")) {
  throw new Error("toolchain.json must pin the macOS arm64 Deno executable SHA-256");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.macosX64ArchiveSha256 ?? "")) {
  throw new Error("toolchain.json must pin the macOS x64 Deno archive SHA-256");
}
if (toolchain.runtimes.deno.macosX64ArchiveBytes !== 42_336_919) {
  throw new Error("toolchain.json must pin the audited macOS x64 Deno archive size");
}
if (toolchain.runtimes.deno.macosX64ArchiveUpdatedAt !== "2026-07-08T13:18:58Z") {
  throw new Error("toolchain.json must pin the audited macOS x64 Deno archive timestamp");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.macosArm64ArchiveSha256 ?? "")) {
  throw new Error("toolchain.json must pin the macOS arm64 Deno archive SHA-256");
}
if (toolchain.runtimes.deno.macosArm64ArchiveBytes !== 37_981_362) {
  throw new Error("toolchain.json must pin the audited macOS arm64 Deno archive size");
}
if (toolchain.runtimes.deno.macosArm64ArchiveUpdatedAt !== "2026-07-08T13:07:40Z") {
  throw new Error("toolchain.json must pin the audited macOS arm64 Deno archive timestamp");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.runtimes.deno.linuxX64ArchiveSha256 ?? "")) {
  throw new Error("toolchain.json must pin the Linux x64 Deno archive SHA-256");
}
if (toolchain.runtimes.deno.linuxX64ArchiveBytes !== 43_926_976) {
  throw new Error("toolchain.json must pin the audited Linux x64 Deno archive size");
}
if (toolchain.runtimes.deno.linuxX64ArchiveUpdatedAt !== "2026-07-08T12:48:38Z") {
  throw new Error("toolchain.json must pin the audited Linux x64 Deno archive timestamp");
}
if (toolchain.runtimes.deno.linuxX64NpmPackage !== `@deno/linux-x64-glibc@${requiredDeno}`) {
  throw new Error("toolchain.json must pin the matching official Linux x64 Deno npm package");
}
if (toolchain.runtimes.deno.linuxX64NpmTarballBytes !== 44_958_740) {
  throw new Error("toolchain.json must pin the audited Linux x64 Deno npm tarball size");
}
if (!/^[0-9a-f]{40}$/u.test(toolchain.runtimes.deno.linuxX64NpmTarballSha1 ?? "")) {
  throw new Error("toolchain.json must pin the Linux x64 Deno npm tarball SHA-1");
}
if (
  toolchain.runtimes.deno.linuxX64NpmTarballSha512 !==
    "bOmdYLSydi5E4m6V7/9OHVFnvmwbrPAYXunuMoZO3Tik7NOhwyv551HIbBmliADwXlj7/Na9B3elmA3+AZ7X9w=="
) {
  throw new Error("toolchain.json must pin the Linux x64 Deno npm tarball SHA-512");
}
if (toolchain.runtimes.deno.linuxX64NpmPublishedAt !== "2026-07-08T14:43:13.355Z") {
  throw new Error("toolchain.json must pin the Linux x64 Deno npm publication timestamp");
}

assertEquals(
  Deno.version.deno,
  requiredDeno,
  `Deno ${requiredDeno} is required; current runtime is ${Deno.version.deno}`,
);

if (!toolchain.policy.allowLatest) {
  assertNotEquals(
    requiredDeno,
    toolchain.runtimes.deno.latestAtAudit,
    "Deno must not be pinned to the latest version recorded by the audit",
  );
}
assertRecentNonLatest("Deno", toolchain.runtimes.deno);

const requiredActionsRunner = toolchain.runtimes.githubActionsRunner.required;
if (requiredActionsRunner === null) {
  throw new Error("toolchain.json must pin a GitHub Actions Runner version");
}
if (
  !/^[0-9a-f]{64}$/u.test(
    toolchain.runtimes.githubActionsRunner.windowsX64ArchiveSha256 ?? "",
  )
) {
  throw new Error("toolchain.json must pin the Windows x64 GitHub Actions Runner archive SHA-256");
}
assertRecentNonLatest("GitHub Actions Runner", toolchain.runtimes.githubActionsRunner);
for (const workflow of fixedRunnerWorkflows) {
  assertEquals(
    workflow.includes(`Runner ${requiredActionsRunner} is required`),
    true,
    "fixed-runner workflows must enforce the audited GitHub Actions Runner version",
  );
}

const requiredPglite = toolchain.components.pglite.required;
if (requiredPglite === null) {
  throw new Error("toolchain.json must pin a PGlite version");
}

assertEquals(
  denoConfig.imports?.["@electric-sql/pglite"],
  `npm:@electric-sql/pglite@${requiredPglite}`,
  "deno.json must use the audited PGlite version",
);

if (!toolchain.policy.databaseMayUseLatest) {
  assertNotEquals(
    requiredPglite,
    toolchain.components.pglite.latestAtAudit,
    "PGlite must not be pinned to the latest version recorded by the audit",
  );
}

const requiredSupabaseJs = toolchain.components.supabaseJs.required;
if (requiredSupabaseJs === null) {
  throw new Error("toolchain.json must pin a supabase-js compatibility-test version");
}
assertEquals(
  denoConfig.imports?.["@supabase/supabase-js"],
  `npm:@supabase/supabase-js@${requiredSupabaseJs}`,
  "deno.json must use the audited supabase-js version",
);
assertNotEquals(
  requiredSupabaseJs,
  toolchain.components.supabaseJs.latestAtAudit,
  "supabase-js compatibility tests must not use the latest audited version",
);
assertRecentNonLatest("supabase-js", toolchain.components.supabaseJs);

const requiredSupabaseServer = toolchain.components.supabaseServer.required;
if (requiredSupabaseServer === null) {
  throw new Error("toolchain.json must pin an @supabase/server compatibility-test version");
}
assertEquals(
  denoConfig.imports?.["@supabase/server"],
  `npm:@supabase/server@${requiredSupabaseServer}`,
  "deno.json must use the audited @supabase/server version",
);
assertRecent("@supabase/server", toolchain.components.supabaseServer, true);

const requiredSupabaseCli = toolchain.components.supabaseCli.required;
if (requiredSupabaseCli === null) {
  throw new Error("toolchain.json must pin a Supabase CLI layout-audit version");
}
if (!/^[0-9a-f]{64}$/u.test(toolchain.components.supabaseCli.windowsX64ArchiveSha256 ?? "")) {
  throw new Error("toolchain.json must pin the Windows x64 Supabase CLI archive SHA-256");
}
if (
  !Number.isSafeInteger(toolchain.components.supabaseCli.windowsX64ArchiveBytes) ||
  (toolchain.components.supabaseCli.windowsX64ArchiveBytes ?? 0) <= 0
) {
  throw new Error("toolchain.json must pin the Windows x64 Supabase CLI archive size");
}
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
    toolchain.components.supabaseCli.windowsX64ArchiveUpdatedAt ?? "",
  )
) {
  throw new Error("toolchain.json must pin the Windows x64 Supabase CLI asset update time");
}
assertRecentNonLatest("Supabase CLI", toolchain.components.supabaseCli);

const requiredPostgres = toolchain.components.postgres.required;
if (requiredPostgres === null) {
  throw new Error("toolchain.json must pin the PostgreSQL Server runtime version");
}
assertEquals(
  requiredPostgres,
  toolchain.components.postgres.latestAtAudit,
  "PostgreSQL must match the latest tested stable database release recorded by the audit",
);
if (toolchain.components.postgres.linuxX64BuildOs !== "Ubuntu 24.04.4 LTS") {
  throw new Error("PostgreSQL Linux x64 Runtime must pin its audited Ubuntu build OS");
}
if (
  toolchain.components.postgres.linuxX64PgdgKeyFingerprint !==
    "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"
) {
  throw new Error("PostgreSQL Linux x64 Runtime must pin the PGDG signing key fingerprint");
}
const linuxPostgresPackages = toolchain.components.postgres.linuxX64Packages;
const linuxPostgresDependencyPackages = toolchain.components.postgres.linuxX64DependencyPackages;
if (linuxPostgresPackages === undefined || linuxPostgresDependencyPackages === undefined) {
  throw new Error("PostgreSQL Linux x64 Runtime package manifests are missing");
}
assertLinuxPostgresPackageManifest(linuxPostgresPackages, linuxPostgresDependencyPackages);
if (toolchain.components.postgres.macosMinimumVersion !== "15.0") {
  throw new Error("PostgreSQL macOS Runtime must pin its minimum macOS version");
}
const macosPostgresSource = toolchain.components.postgres.macosSource;
const macosOpenSsl = toolchain.components.postgresMacosOpenSsl;
if (
  macosPostgresSource === undefined || macosOpenSsl.required === null ||
  macosOpenSsl.sourceFileName === undefined || macosOpenSsl.sourceUrl === undefined ||
  macosOpenSsl.sourceBytes === undefined || macosOpenSsl.sourceSha256 === undefined ||
  macosOpenSsl.sourceUpdatedAt === undefined
) {
  throw new Error("PostgreSQL macOS Runtime fixed source records are missing");
}
assertRecentNonLatest("PostgreSQL macOS OpenSSL", macosOpenSsl);
assertMacosPostgresSourceRecords(macosPostgresSource, {
  fileName: macosOpenSsl.sourceFileName,
  url: macosOpenSsl.sourceUrl,
  bytes: macosOpenSsl.sourceBytes,
  sha256: macosOpenSsl.sourceSha256,
  updatedAt: macosOpenSsl.sourceUpdatedAt,
});

const requiredPostgresDriver = toolchain.components.postgresDriver.required;
if (requiredPostgresDriver === null) {
  throw new Error("toolchain.json must pin the PostgreSQL driver version");
}
assertEquals(
  denoConfig.imports?.postgres,
  `npm:postgres@${requiredPostgresDriver}`,
  "deno.json must use the audited PostgreSQL driver version",
);

const requiredStdPath = toolchain.components.stdPath.required;
if (requiredStdPath === null) {
  throw new Error("toolchain.json must pin the Deno Standard Library path version");
}
assertEquals(
  denoConfig.imports?.["@std/path"],
  `jsr:@std/path@${requiredStdPath}`,
  "deno.json must use the audited @std/path version",
);
assertRecentNonLatest("@std/path", toolchain.components.stdPath);

const requiredSmolToml = toolchain.components.smolToml.required;
if (requiredSmolToml === null) {
  throw new Error("toolchain.json must pin the smol-toml version");
}
assertEquals(
  denoConfig.imports?.["smol-toml"],
  `npm:smol-toml@${requiredSmolToml}`,
  "deno.json must use the audited smol-toml version",
);
assertRecentNonLatest("smol-toml", toolchain.components.smolToml);

const ciActions = [
  [
    "GitHub Actions checkout",
    ["actions/checkout"],
    toolchain.components.githubActionsCheckout,
  ],
  [
    "GitHub Actions cache",
    ["actions/cache/restore", "actions/cache/save"],
    toolchain.components.githubActionsCache,
  ],
  [
    "GitHub Actions upload-artifact",
    ["actions/upload-artifact"],
    toolchain.components.githubActionsUploadArtifact,
  ],
] as const;
for (const [name, references, component] of ciActions) {
  if (component.required === null) throw new Error(`${name} must be pinned`);
  if (!/^[0-9a-f]{40}$/u.test(component.commitSha ?? "")) {
    throw new Error(`${name} must pin a full Git commit SHA`);
  }
  assertRecentNonLatest(name, component);
  for (const reference of references) {
    for (const workflow of auditedWorkflows) {
      if (!workflow.includes(`${reference}@`)) continue;
      assertEquals(
        workflow.includes(`${reference}@${component.commitSha}`),
        true,
        `${name} workflow reference must match toolchain.json`,
      );
    }
  }
}

console.log(
  JSON.stringify({
    ok: true,
    auditedAt: toolchain.auditedAt,
    deno: requiredDeno,
    pglite: requiredPglite,
    postgres: requiredPostgres,
    postgresDriver: requiredPostgresDriver,
    stdPath: requiredStdPath,
    smolToml: requiredSmolToml,
    supabaseJs: requiredSupabaseJs,
    supabaseServer: requiredSupabaseServer,
    supabaseCli: requiredSupabaseCli,
    githubActionsRunner: requiredActionsRunner,
    githubActionsCheckout: toolchain.components.githubActionsCheckout.required,
    githubActionsCache: toolchain.components.githubActionsCache.required,
    githubActionsUploadArtifact: toolchain.components.githubActionsUploadArtifact.required,
  }),
);

function assertRecentNonLatest(name: string, component: AuditedVersion): void {
  assertRecent(name, component, false);
}

function assertRecent(
  name: string,
  component: AuditedVersion,
  compatibilityTargetMayBeLatest: boolean,
): void {
  if (component.required === null) throw new Error(`${name} must be pinned`);
  if (
    component.publishedAt === undefined || component.latestAtAudit === undefined ||
    component.latestPublishedAt === undefined
  ) {
    throw new Error(`${name} must record publishedAt, latestAtAudit and latestPublishedAt`);
  }
  const audit = parseAuditDate(toolchain.auditedAt, "toolchain auditedAt");
  const published = parseAuditDate(component.publishedAt, `${name} publishedAt`);
  const latestPublished = parseAuditDate(
    component.latestPublishedAt,
    `${name} latestPublishedAt`,
  );
  const ageDays = Math.floor((audit.getTime() - published.getTime()) / 86_400_000);
  if (ageDays < 0 || ageDays > toolchain.policy.maximumAgeDays) {
    throw new Error(
      `${name} ${component.required} is ${ageDays} days old at audit; maximum is ${toolchain.policy.maximumAgeDays}`,
    );
  }
  if (latestPublished.getTime() > audit.getTime()) {
    throw new Error(`${name} latestPublishedAt cannot be after the audit date`);
  }
  if (!toolchain.policy.allowLatest && !compatibilityTargetMayBeLatest) {
    assertNotEquals(
      component.required,
      component.latestAtAudit,
      `${name} must not use the latest version recorded by the audit`,
    );
  }
}

function parseAuditDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

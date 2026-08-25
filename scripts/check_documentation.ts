import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import compatibility from "../fixtures/supabase-basic/compatibility.json" with { type: "json" };
import toolchain from "../toolchain.json" with { type: "json" };

const root = fromFileUrl(new URL("../", import.meta.url));
const documents = {
  projectLicense: await readDocument("LICENSE"),
  apacheLicense: await readDocument("release/APACHE-2.0.txt"),
  readme: await readDocument("README.md"),
  readmeChinese: await readDocument("README.zh-CN.md"),
  gettingStarted: await readDocument("docs/GETTING_STARTED.md"),
  editions: await readDocument("docs/EDITIONS.md"),
  compatibility: await readDocument("docs/COMPATIBILITY.md"),
  versions: await readDocument("docs/VERSIONS.md"),
  deployment: await readDocument("docs/DEPLOYMENT.md"),
  troubleshooting: await readDocument("docs/TROUBLESHOOTING.md"),
  thirdPartyLicenses: await readDocument("docs/THIRD_PARTY_LICENSES.md"),
  security: await readDocument("docs/SECURITY.md"),
  upgrading: await readDocument("docs/UPGRADING.md"),
  performance: await readDocument("docs/PERFORMANCE.md"),
};

for (
  const required of [
    "supabase/functions",
    "supabase/migrations",
    "supabase/seed.sql",
    "@supabase/supabase-js",
    "minibase-embedded-windows-x64.exe",
    "minibase-server-windows-x64.exe",
    "/functions/v1/<name>",
    "/functions/v1/docs",
    "/functions/v1/docs/openapi.json",
    "OpenAPI 3.0.3",
    "OpenAI-compatible SSE",
    "S3-compatible Storage",
    "docs/COMPATIBILITY.md",
    "deno task verify:baseline",
    "[Apache License 2.0](./LICENSE)",
  ]
) {
  assertStringIncludes(documents.readme, required);
}

for (const required of ["assets/minibase-logo.png", "README.zh-CN.md"]) {
  assertStringIncludes(documents.readme, required);
}
for (
  const required of ["assets/minibase-logo.png", "README.md", "[Apache License 2.0](./LICENSE)"]
) {
  assertStringIncludes(documents.readmeChinese, required);
}

assertEquals(
  documents.projectLicense,
  documents.apacheLicense,
  "root LICENSE must match the Apache License 2.0 text distributed with releases",
);

assertEquals(
  compatibility.verifiedWith.supabaseCli.version,
  toolchain.components.supabaseCli.required,
  "compatibility fixture and toolchain must use the same Supabase CLI version",
);
assertEquals(
  compatibility.verifiedWith.supabaseJs.version,
  toolchain.components.supabaseJs.required,
  "compatibility fixture and toolchain must use the same supabase-js version",
);
assertEquals(
  compatibility.verifiedWith.supabaseServer.version,
  toolchain.components.supabaseServer.required,
  "compatibility fixture and toolchain must use the same @supabase/server version",
);

for (
  const required of [
    "minibase-embedded-windows-x64.exe",
    "doctor --project .",
    "start --project .",
    "supabase/migrations",
    "supabase/seed.sql",
    ".auth.signUp",
    ".functions.invoke",
    ".storage.from",
    "COMPATIBILITY.md",
  ]
) {
  assertStringIncludes(documents.gettingStarted, required);
}

for (
  const required of [
    "minibase-embedded-windows-x64.exe",
    "minibase-server-windows-x64.exe",
    "backup export",
    "backup restore",
    "--engine pglite",
    "--engine postgres",
    "--include-storage",
  ]
) {
  assertStringIncludes(documents.editions, required);
}

for (
  const required of [
    "release-manifest.json",
    "THIRD_PARTY_LICENSES.txt",
    "doctor --project",
    "/health/live",
    "/health/ready",
    "MINIBASE_TRUSTED_PROXIES",
    "backup export",
    "TROUBLESHOOTING.md",
  ]
) {
  assertStringIncludes(documents.deployment, required);
}

for (
  const required of [
    "status --project",
    "doctor --project",
    "migration recover",
    "storage check",
    "storage repair",
    "functions logs",
    "release-manifest.json",
  ]
) {
  assertStringIncludes(documents.troubleshooting, required);
}

for (
  const required of [
    "Deno",
    toolchain.runtimes.deno.required,
    "PGlite",
    toolchain.components.pglite.required,
    "Apache-2.0",
    "PostgreSQL License",
    "postgres.js",
    toolchain.components.postgresDriver.required,
    "smol-toml",
    toolchain.components.smolToml.required,
    "@supabase/supabase-js",
    toolchain.components.supabaseJs.required,
    "@supabase/server",
    toolchain.components.supabaseServer.required,
    "THIRD_PARTY_LICENSES.txt",
  ]
) {
  assertStringIncludes(documents.thirdPartyLicenses, required);
}

for (
  const required of [
    "可信 Supabase 项目代码",
    "127.0.0.1:54321",
    "Authorization: Bearer",
    "CORS 与 CSRF",
    "inject_service_role_key = false",
    "functions.network.outbound",
    "block_private_networks",
    "SSRF",
    "不可信多租户",
    "分布式限流",
  ]
) {
  assertStringIncludes(documents.security, required);
}

for (
  const required of [
    "server_version_num",
    'effects: "read-only"',
    "metadata-only",
    "外部 PostgreSQL",
    "未来任何会写数据库",
    "S3-compatible Storage",
    "Storage effect 声明为 `write`",
    "逐对象恢复",
  ]
) {
  assertStringIncludes(documents.upgrading, required);
}

for (
  const required of [
    "deno task optimization:check",
    "optimization-policy.json",
    "schema-3 before/after benchmark reports",
    "zero native optimizations",
  ]
) {
  assertStringIncludes(documents.performance, required);
}

assertStringIncludes(
  documents.compatibility,
  `Supabase CLI ${compatibility.verifiedWith.supabaseCli.version}`,
);
assertStringIncludes(
  documents.compatibility,
  `supabase-js ${compatibility.verifiedWith.supabaseJs.version}`,
);
assertStringIncludes(
  documents.compatibility,
  `@supabase/server\` ${compatibility.verifiedWith.supabaseServer.version}`,
);
assertStringIncludes(
  documents.compatibility,
  compatibility.projectLayout.functionDenoConfig,
);
assertStringIncludes(documents.compatibility, "@supabase/server");
assertStringIncludes(documents.compatibility, "Deno.serve");
assertStringIncludes(documents.compatibility, "server_version_num");
assertStringIncludes(documents.compatibility, "未来会写数据库的升级");
assertStringIncludes(documents.compatibility, "全部本地 `file:` 依赖");
assertStringIncludes(documents.compatibility, "完整依赖图作为失效依据");
assertStringIncludes(documents.compatibility, "执行用户代码前明确拒绝");
assertStringIncludes(documents.compatibility, "deno task s3:real:probe");
assertStringIncludes(documents.compatibility, "AWS S3");
assertStringIncludes(documents.compatibility, "Cloudflare R2");
assertStringIncludes(documents.compatibility, "evidence/s3/");
assertStringIncludes(documents.compatibility, "Storage-mutating upgrade");
assertStringIncludes(documents.compatibility, "二次复核");
assertStringIncludes(documents.deployment, "deno task s3:evidence:promote");

const supportLabels: Record<string, string> = {
  supported: "支持",
  partial: "部分支持",
  experimental: "实验性",
  "not-in-mvp": "MVP 不支持",
};
const matrixRows = documents.compatibility.split(/\r?\n/u)
  .filter((line) => line.startsWith("|"))
  .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
for (const module of compatibility.modules) {
  const actual = matrixRows.find((row) => row[0] === module.label);
  const overall = supportLabels[module.overall];
  const embedded = supportLabels[module.embedded];
  const server = supportLabels[module.server];
  assert(overall !== undefined && embedded !== undefined && server !== undefined);
  assertEquals(
    actual,
    [
      module.label,
      overall,
      embedded,
      server,
      module.summary,
    ],
    `compatibility matrix row for ${module.id} is stale`,
  );
}

for (
  const version of [
    toolchain.runtimes.deno.required,
    toolchain.components.pglite.required,
    toolchain.components.postgres.required,
    toolchain.components.supabaseJs.required,
    toolchain.components.supabaseServer.required,
    toolchain.components.supabaseCli.required,
  ]
) {
  assert(version !== null);
  assertStringIncludes(documents.versions, version);
}

await validateLocalMarkdownLinks();

console.log(JSON.stringify({
  ok: true,
  documents: Object.keys(documents).length,
  matrixRows: compatibility.modules.length,
  supabaseCli: compatibility.verifiedWith.supabaseCli.version,
  supabaseJs: compatibility.verifiedWith.supabaseJs.version,
  supabaseServer: compatibility.verifiedWith.supabaseServer.version,
}));

async function readDocument(relativePath: string): Promise<string> {
  return await Deno.readTextFile(join(root, relativePath));
}

async function validateLocalMarkdownLinks(): Promise<void> {
  const paths = [
    "README.md",
    "README.zh-CN.md",
    "docs/GETTING_STARTED.md",
    "docs/EDITIONS.md",
    "docs/COMPATIBILITY.md",
    "docs/VERSIONS.md",
    "docs/DEPLOYMENT.md",
    "docs/TROUBLESHOOTING.md",
    "docs/THIRD_PARTY_LICENSES.md",
    "docs/SECURITY.md",
    "docs/UPGRADING.md",
    "docs/PERFORMANCE.md",
  ];
  for (const relativePath of paths) {
    const contents = await readDocument(relativePath);
    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]!;
      if (/^[a-z]+:/iu.test(target) || target.startsWith("#")) continue;
      const withoutAnchor = target.split("#", 1)[0]!;
      if (withoutAnchor.length === 0) continue;
      const resolved = join(root, dirname(relativePath), withoutAnchor);
      assert((await Deno.stat(resolved)).isFile, `${relativePath} has a broken link to ${target}`);
    }
  }
}

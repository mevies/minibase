import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, relative } from "@std/path";
import { loadOrCreateAuthSecrets } from "../src/auth/secrets.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { runDoctor } from "../src/diagnostics/doctor.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import {
  inspectWindowsSecretAcl,
  unauthorizedWindowsAclSids,
} from "../src/security/windows_acl.ts";
import toolchain from "../toolchain.json" with { type: "json" };

const POSTGRES_MAJOR = toolchain.components.postgres.required.split(".", 1)[0]!;

Deno.test("doctor reports unsupported Embedded SQL with structured severity and locations", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-test-" });
  try {
    const migrationsDir = join(temp, "supabase", "migrations");
    await Deno.mkdir(migrationsDir, { recursive: true });
    const migrationFile = join(migrationsDir, "20260804000100_unsupported.sql");
    await Deno.writeTextFile(
      migrationFile,
      "create extension postgis;\ncreate publication events for all tables;\nvacuum;\n",
    );
    const project = await discoverProject(temp);
    const report = await runDoctor(await loadConfig(project));
    assertEquals(report.ok, false);

    const extension = report.checks.find((check) =>
      check.code === "migration.extension.unavailable"
    );
    assertEquals(extension?.severity, "error");
    assertEquals(extension?.file, migrationFile);
    assertEquals(extension?.line, 1);
    assertEquals(extension?.column, 1);

    const replication = report.checks.find((check) => check.code === "migration.replication");
    assertEquals(replication?.severity, "error");
    assertEquals(replication?.line, 2);
    assert(replication?.fix?.includes("Server distribution"));

    const transaction = report.checks.find((check) =>
      check.code === "migration.transaction.required"
    );
    assertEquals(transaction?.severity, "error");
    assertEquals(transaction?.line, 3);
    assert(report.checks.some((check) => check.severity === "warning"));
    assert(report.checks.some((check) => check.severity === "info"));
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reports missing Function entrypoints and ignores _shared", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-functions-test-" });
  try {
    const functionsDir = join(temp, "supabase", "functions");
    const missingEntry = join(functionsDir, "missing-entry", "index.ts");
    await Deno.mkdir(join(functionsDir, "missing-entry"), { recursive: true });
    await Deno.mkdir(join(functionsDir, "_shared"), { recursive: true });
    const functionLock = join(functionsDir, "missing-entry", "deno.lock");
    await Deno.writeTextFile(functionLock, '{"version":"4","specifiers":{},"jsr":{}}\n');

    const project = await discoverProject(temp);
    const report = await runDoctor(await loadConfig(project));
    assertEquals(report.ok, false);

    const entrypoint = report.checks.find((check) => check.code === "functions.entrypoint.missing");
    assertEquals(entrypoint?.severity, "error");
    assertEquals(entrypoint?.file, missingEntry);
    assertStringIncludes(entrypoint?.message ?? "", "missing-entry");
    assertStringIncludes(entrypoint?.fix ?? "", missingEntry);
    assertEquals(
      report.checks.filter((check) => check.code === "functions.entrypoint.missing").length,
      1,
    );
    const lockfile = report.checks.find((check) => check.code === "functions.lockfile");
    assertEquals(lockfile?.severity, "info");
    assertStringIncludes(lockfile?.message ?? "", functionLock);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor checks occupied ports and gives every failure a repair action", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-port-test-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    const project = await discoverProject(temp);
    const report = await runDoctor(await loadConfig(project, { port }));
    const portCheck = report.checks.find((check) => check.code === "server.port");
    assertEquals(portCheck?.severity, "error");
    assertStringIncludes(portCheck?.message ?? "", String(port));
    assert((portCheck?.fix?.length ?? 0) > 0);
    assert(
      report.checks.filter((check) => check.severity !== "info").every((check) =>
        (check.fix?.length ?? 0) > 0
      ),
    );
  } finally {
    listener.close();
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reports unusable runtime and local Storage paths", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-path-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    await Deno.writeTextFile(join(temp, ".minibase"), "not-a-directory");
    const storagePath = join(temp, "storage-blocked");
    await Deno.writeTextFile(storagePath, "not-a-directory");
    const project = await discoverProject(temp);
    const report = await runDoctor(
      await loadConfig(project, { port: availablePort(), storagePath }),
    );
    for (const code of ["data.writable", "storage.health"]) {
      const check = report.checks.find((item) => item.code === code);
      assertEquals(check?.severity, "error", code);
      assert((check?.fix?.length ?? 0) > 0, code);
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor probes S3-compatible Storage without exposing backend failures", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-s3-test-" });
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  let available = true;
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    (request) => {
      const url = new URL(request.url);
      assertEquals(url.searchParams.get("list-type"), "2");
      return available
        ? new Response(
          "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated></ListBucketResult>",
        )
        : new Response("backend-secret-must-not-appear", { status: 503 });
    },
  );
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    const project = await discoverProject(temp);
    const config = await loadConfig(project, { storageDriver: "s3", port: availablePort() }, {
      MINIBASE_S3_ENDPOINT: `http://127.0.0.1:${await listening.promise}`,
      MINIBASE_S3_REGION: "test-region-1",
      MINIBASE_S3_BUCKET: "doctor-bucket",
      MINIBASE_S3_ACCESS_KEY_ID: "doctor-access-7Xq4mN2vP9cR6tY3",
      MINIBASE_S3_SECRET_ACCESS_KEY: "doctor-secret-7Xq4mN2vP9cR6tY3aB8dF5hJ1kL0",
    });
    const healthy = await runDoctor(config);
    assertEquals(
      healthy.checks.find((check) => check.code === "storage.health")?.severity,
      "info",
    );

    available = false;
    const failed = await runDoctor(config);
    const storage = failed.checks.find((check) => check.code === "storage.health");
    assertEquals(storage?.severity, "error");
    assert((storage?.fix?.length ?? 0) > 0);
    assertEquals(JSON.stringify(failed).includes("backend-secret-must-not-appear"), false);
  } finally {
    abort.abort();
    await server.finished;
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reports an unreachable external database without leaking its URL", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-database-test-" });
  const password = "doctor-database-password-never-appear";
  const databaseUrl = `postgres://minibase:${password}@127.0.0.1:1/minibase`;
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    await Deno.writeTextFile(
      join(temp, "minibase.toml"),
      "format_version = 1\n[database]\nconnect_timeout_ms = 100\n",
    );
    const project = await discoverProject(temp);
    const report = await runDoctor(
      await loadConfig(project, { engine: "postgres", port: availablePort() }, {
        MINIBASE_DATABASE_MANAGED: "false",
        MINIBASE_DATABASE_URL: databaseUrl,
      }),
    );
    const database = report.checks.find((check) => check.code === "database.health");
    assertEquals(database?.severity, "error");
    assert((database?.fix?.length ?? 0) > 0);
    const serialized = JSON.stringify(report);
    assertEquals(serialized.includes(password), false);
    assertEquals(serialized.includes(databaseUrl), false);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reads extensions from a bundled Linux PostgreSQL Runtime layout", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-linux-runtime-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    const runtime = join(temp, "runtime");
    const extensionDir = join(
      runtime,
      "usr",
      "share",
      "postgresql",
      POSTGRES_MAJOR,
      "extension",
    );
    await Deno.mkdir(extensionDir, { recursive: true });
    await Deno.writeTextFile(join(extensionDir, "pgcrypto.control"), "comment = 'pgcrypto'\n");
    await Deno.writeTextFile(join(extensionDir, "uuid-ossp.control"), "comment = 'uuid-ossp'\n");

    const project = await discoverProject(temp);
    const report = await runDoctor(
      await loadConfig(project, { engine: "postgres", port: availablePort() }, {
        MINIBASE_POSTGRES_RUNTIME_DIR: runtime,
      }),
    );
    for (const extension of ["pgcrypto", "uuid-ossp"]) {
      assertEquals(
        report.checks.find((check) => check.code === `database.extension.${extension}`)?.severity,
        "info",
      );
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reports corrupted database control data without modifying the directory", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-corruption-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase"), { recursive: true });
    const project = await discoverProject(temp);
    await prepareProject(project, "pglite");
    const engine = new PGliteEngine(project.pgliteDataDir);
    await engine.start();
    await engine.close();
    const controlFile = join(project.pgliteDataDir, "global", "pg_control");
    await Deno.writeFile(controlFile, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const before = await directoryFingerprint(project.pgliteDataDir);

    const report = await runDoctor(await loadConfig(project, { port: availablePort() }));
    const corruption = report.checks.find((check) => check.code === "database.integrity.corrupt");
    assertEquals(corruption?.severity, "error");
    assertStringIncludes(corruption?.message ?? "", "left the data directory unchanged");
    assertStringIncludes(corruption?.fix ?? "", "do not reset it in place");
    assertEquals(corruption?.file, controlFile);
    assertEquals(await directoryFingerprint(project.pgliteDataDir), before);
    assertEquals(
      report.checks.some((check) => check.code === "database.health"),
      false,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor CLI provides stable human and JSON reports", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-cli-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase", "functions", "missing-entry"), {
      recursive: true,
    });
    const port = availablePort();
    const json = await runDoctorCli(temp, port, true);
    assertEquals(json.code, 2, json.stderr);
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      checks: Array<{ severity: string; fix?: string }>;
    };
    assertEquals(report.ok, false);
    assert(
      report.checks.filter((check) => check.severity !== "info").every((check) =>
        (check.fix?.length ?? 0) > 0
      ),
    );
    assertEquals(json.stdout.trim().split(/\r?\n/u).length, 1);

    const human = await runDoctorCli(temp, port, false);
    assertEquals(human.code, 2, human.stderr);
    assertStringIncludes(human.stdout, "Minibase doctor: FAILED");
    assertStringIncludes(human.stdout, "[ERROR] functions.entrypoint.missing");
    assertStringIncludes(human.stdout, "  Fix:");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor reports Secret links and platform permissions without modifying user files", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-secrets-test-" });
  try {
    const functionsDir = join(temp, "supabase", "functions");
    await Deno.mkdir(functionsDir, { recursive: true });
    const rootEnv = join(temp, ".env");
    const target = join(temp, "functions-secrets-target.env");
    const functionsEnv = join(functionsDir, ".env");
    const authSecrets = join(temp, ".minibase", "secrets.json");
    await Deno.mkdir(join(temp, ".minibase"), { recursive: true });
    await Deno.writeTextFile(rootEnv, "ROOT_SECRET=not-printed\n");
    if (Deno.build.os === "windows") await grantWindowsReadToEveryone(rootEnv);
    await Deno.writeTextFile(target, "FUNCTION_SECRET=not-printed\n");
    await Deno.symlink(target, functionsEnv, { type: "file" });
    await Deno.symlink(target, authSecrets, { type: "file" });
    if (Deno.build.os !== "windows") await Deno.chmod(rootEnv, 0o644);

    const project = await discoverProject(temp);
    const report = await runDoctor(await loadConfig(project));
    const symlink = report.checks.find((check) => check.code === "secrets.env.functions.symlink");
    assertEquals(symlink?.severity, "warning");
    assertEquals(symlink?.file, functionsEnv);
    const authSymlink = report.checks.find((check) => check.code === "secrets.auth.symlink");
    assertEquals(authSymlink?.severity, "error");
    assertEquals(authSymlink?.file, authSecrets);
    assertEquals(
      report.checks.some((check) => check.code.startsWith("secrets.env.functions.value.")),
      false,
    );
    assertEquals(report.ok, false);
    assertEquals(JSON.stringify(report).includes("not-printed"), false);
    assertEquals(await Deno.readTextFile(target), "FUNCTION_SECRET=not-printed\n");
    if (Deno.build.os !== "windows") {
      const permissions = report.checks.find((check) =>
        check.code === "secrets.env.root.permissions"
      );
      assertEquals(permissions?.severity, "warning");
      assertEquals(((await Deno.lstat(rootEnv)).mode ?? 0) & 0o777, 0o644);
    } else {
      const acl = report.checks.find((check) => check.code === "secrets.env.root.acl");
      assertEquals(acl?.severity, "warning");
      assert(
        unauthorizedWindowsAclSids(await inspectWindowsSecretAcl(rootEnv)).includes("S-1-1-0"),
      );
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor detects missing, placeholder and weak Secrets without exposing values", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-secret-quality-test-" });
  const envPlaceholder = "your-api-key-here";
  const envWeak = "short";
  const authPlaceholder = "replace-me-with-a-random-auth-secret-now";
  const authWeak = "tiny";
  const s3Access = "AKIAIOSFODNN7EXAMPLE";
  const s3Secret = "short-s3";
  const sessionToken = "session-token-7Xq4mN2vP9cR6tY3";
  try {
    const functionsDir = join(temp, "supabase", "functions");
    await Deno.mkdir(functionsDir, { recursive: true });
    await Deno.writeTextFile(
      join(temp, ".env"),
      [
        `OPENAI_API_KEY=${envPlaceholder}`,
        `WEBHOOK_SECRET=${envWeak}`,
        "PAYMENT_TOKEN=",
        "PUBLIC_LABEL=not-a-secret",
      ].join("\n") + "\n",
    );
    await Deno.writeTextFile(
      join(functionsDir, ".env"),
      "STRONG_API_KEY=sk-project-7Xq4mN2vP9cR6tY3aB8dF5hJ1kL0\n",
    );
    await Deno.mkdir(join(temp, ".minibase"), { recursive: true });
    const authSecrets = join(temp, ".minibase", "secrets.json");
    await Deno.writeTextFile(
      authSecrets,
      JSON.stringify({
        formatVersion: 1,
        activeKid: "first",
        signingKeys: [
          {
            kid: "first",
            secret: authPlaceholder,
            createdAt: "2026-08-04T00:00:00.000Z",
          },
          {
            kid: "second",
            secret: authWeak,
            createdAt: "2026-08-04T00:00:00.000Z",
          },
          {
            kid: "third",
            secret: authPlaceholder,
            createdAt: "2026-08-04T00:00:00.000Z",
          },
        ],
      }) + "\n",
    );
    if (Deno.build.os === "windows") await grantWindowsReadToEveryone(authSecrets);

    const project = await discoverProject(temp);
    const report = await runDoctor(
      await loadConfig(project, { engine: "postgres", storageDriver: "s3" }, {
        MINIBASE_DATABASE_URL: "postgres://minibase@db.example.invalid/minibase",
        MINIBASE_S3_ENDPOINT: "https://s3.example.invalid",
        MINIBASE_S3_REGION: "test-region-1",
        MINIBASE_S3_BUCKET: "test-bucket",
        MINIBASE_S3_ACCESS_KEY_ID: s3Access,
        MINIBASE_S3_SECRET_ACCESS_KEY: s3Secret,
        MINIBASE_S3_SESSION_TOKEN: sessionToken,
      }),
    );

    for (
      const code of [
        "secrets.env.root.value.placeholder",
        "secrets.env.root.value.weak",
        "secrets.env.root.value.missing",
        "secrets.auth.key.placeholder",
        "secrets.auth.key.weak",
        "secrets.auth.key.duplicate",
        "secrets.s3.access_key_id.placeholder",
        "secrets.s3.secret_access_key.weak",
        "secrets.database.url.password.missing",
      ]
    ) {
      assert(report.checks.some((check) => check.code === code), code);
    }
    if (Deno.build.os === "windows") {
      assert(report.checks.some((check) => check.code === "secrets.auth.acl"));
    }
    const serialized = JSON.stringify(report);
    for (
      const secret of [
        envPlaceholder,
        envWeak,
        authPlaceholder,
        authWeak,
        s3Access,
        s3Secret,
        sessionToken,
      ]
    ) {
      assertEquals(serialized.includes(secret), false, secret);
    }
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

async function grantWindowsReadToEveryone(path: string): Promise<void> {
  const output = await new Deno.Command("icacls.exe", {
    args: [path, "/grant", "*S-1-1-0:(R)"],
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
}

Deno.test("doctor accepts strong Secret values and treats absent Auth state as uninitialized", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-strong-secret-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase", "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(temp, ".env"),
      "OPENAI_API_KEY=sk-project-7Xq4mN2vP9cR6tY3aB8dF5hJ1kL0\n",
    );
    const project = await discoverProject(temp);
    const report = await runDoctor(await loadConfig(project, {}, {}));

    assertEquals(
      report.checks.some((check) => check.code.startsWith("secrets.env.root.value.")),
      false,
    );
    assertEquals(
      report.checks.some((check) => check.code.startsWith("secrets.auth.key.")),
      false,
    );
    const uninitialized = report.checks.find((check) =>
      check.code === "secrets.auth.uninitialized"
    );
    assertEquals(uninitialized?.severity, "info");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor validates ES256 Auth key pairs without exposing private material", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-es256-auth-test-" });
  try {
    await Deno.mkdir(join(temp, "supabase", "functions"), { recursive: true });
    const project = await discoverProject(temp);
    const secrets = await loadOrCreateAuthSecrets(project.secretsFile);
    const key = secrets.signingKeys[0]!;
    assert("algorithm" in key);

    const healthy = await runDoctor(await loadConfig(project));
    assertEquals(
      healthy.checks.some((check) => check.code.startsWith("secrets.auth.key.")),
      false,
    );
    assertEquals(
      healthy.checks.some((check) => check.code === "secrets.auth.jwk.invalid"),
      false,
    );

    key.publicJwk = { ...key.publicJwk, x: "invalid-public-coordinate" };
    await Deno.writeTextFile(project.secretsFile, JSON.stringify(secrets, null, 2) + "\n");
    const damaged = await runDoctor(await loadConfig(project));
    assertEquals(
      damaged.checks.find((check) => check.code === "secrets.auth.jwk.invalid")?.severity,
      "error",
    );
    const serialized = JSON.stringify(damaged);
    assertEquals(serialized.includes(key.privateJwk.d!), false);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("doctor inspects external Secret files without creating a local Auth keyring", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-doctor-external-secret-test-" });
  const placeholder = "replace-me-with-an-external-auth-secret-now";
  try {
    await Deno.mkdir(join(temp, "supabase", "functions"), { recursive: true });
    const secretFile = join(temp, "external-secrets.env");
    await Deno.writeTextFile(
      secretFile,
      `MINIBASE_AUTH_JWT_SECRET=${placeholder}\n`,
    );
    if (Deno.build.os === "windows") await grantWindowsReadToEveryone(secretFile);
    else await Deno.chmod(secretFile, 0o644);

    const project = await discoverProject(temp);
    const report = await runDoctor(
      await loadConfig(project, {}, { MINIBASE_SECRETS_FILE: secretFile }),
    );
    const placeholderCheck = report.checks.find((check) =>
      check.code === "secrets.auth.key.placeholder"
    );
    assertEquals(placeholderCheck?.severity, "error");
    assertEquals(report.checks.some((check) => check.code === "secrets.auth.uninitialized"), false);
    assertEquals(await fileExists(project.secretsFile), false);
    assertEquals(JSON.stringify(report).includes(placeholder), false);
    if (Deno.build.os === "windows") {
      assertEquals(
        report.checks.find((check) => check.code === "secrets.external.acl")?.severity,
        "warning",
      );
    } else {
      assertEquals(
        report.checks.find((check) => check.code === "secrets.external.permissions")?.severity,
        "warning",
      );
    }

    const linkedSecretFile = join(temp, "linked-external-secrets.env");
    await Deno.symlink(secretFile, linkedSecretFile, { type: "file" });
    const linkedReport = await runDoctor(
      await loadConfig(project, {}, { MINIBASE_SECRETS_FILE: linkedSecretFile }),
    );
    assertEquals(
      linkedReport.checks.find((check) => check.code === "secrets.external.symlink")?.severity,
      "warning",
    );
    assertEquals(await fileExists(project.secretsFile), false);
    assertEquals(JSON.stringify(linkedReport).includes(placeholder), false);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function directoryFingerprint(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(path: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      if (entry.isDirectory) {
        entries.push(`d:${relative(root, child).replaceAll("\\", "/")}`);
        await walk(child);
      } else if (entry.isFile) {
        const bytes = await Deno.readFile(child);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        entries.push(`f:${relative(root, child).replaceAll("\\", "/")}:${bytes.length}:${hash}`);
      } else {
        entries.push(`l:${relative(root, child).replaceAll("\\", "/")}`);
      }
    }
  }
  await walk(root);
  return entries.sort();
}

async function runDoctorCli(
  project: string,
  port: number,
  json: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "doctor",
      "--project",
      project,
      "--port",
      String(port),
      ...(json ? ["--json"] : []),
    ],
    cwd: project,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

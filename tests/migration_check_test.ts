import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { MigrationCheckReport } from "../src/migrations/check.ts";
import {
  offlineMigrationCapabilities,
  scanMigrationCompatibility,
} from "../src/migrations/compatibility.ts";
import { discoverProject } from "../src/project/discover.ts";

const runtimeDir = await findPostgresRuntime();

Deno.test("migration check verifies both isolated engines and reports exact failures", async () => {
  assert(runtimeDir !== null, "PostgreSQL 18.4 runtime is required for migration check tests");
  const root = await Deno.makeTempDir({ prefix: "minibase-migration-check-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const project = await discoverProject(root);

    const valid = await runMigrationCheck(root, runtimeDir);
    assertEquals(valid.code, 0, valid.stderr);
    assertEquals(valid.stderr, "");
    assertEquals(valid.stdoutLines, 1);
    assertEquals(valid.report.ok, true);
    assertEquals(valid.report.complete, true);
    assertEquals(valid.report.engines.map((engine) => engine.engine), ["pglite", "postgres"]);
    for (const engine of valid.report.engines) {
      assertEquals(engine.compatible, true);
      assertEquals(engine.executed, true);
      assertEquals(engine.appliedMigrations.length, 3);
    }
    assertEquals(await exists(project.pgliteDataDir), false);
    assertEquals(await exists(project.postgresDataDir), false);

    const requirementsFile = join(project.migrationsDir, "20260803000400_requirements.sql");
    await Deno.writeTextFile(
      requirementsFile,
      "create extension postgis;\ncreate index concurrently probe_idx on public.notes(id);\n",
    );
    const requirements = await scanMigrationCompatibility(
      project,
      offlineMigrationCapabilities("pglite"),
    );
    const extension = requirements.find((item) => item.code === "migration.extension.unavailable");
    assertEquals(extension?.line, 1);
    assertEquals(extension?.column, 1);
    const transaction = requirements.find((item) => item.code === "migration.transaction.required");
    assertEquals(transaction?.line, 2);
    assertEquals(transaction?.column, 1);
    await Deno.writeTextFile(
      requirementsFile,
      "-- create extension postgis;\n" +
        "do $$ begin raise notice 'create publication; vacuum;'; end $$;\n",
    );
    const commentsAndBodies = await scanMigrationCompatibility(
      project,
      offlineMigrationCapabilities("pglite"),
    );
    assertEquals(commentsAndBodies.map((item) => item.code), ["migration.compatibility"]);
    await Deno.writeTextFile(
      requirementsFile,
      "-- minibase:no-transaction\ncreate index concurrently probe_idx on public.notes(id);\n",
    );
    const nonTransactional = await runMigrationCheck(root, runtimeDir);
    assertEquals(
      nonTransactional.code,
      0,
      JSON.stringify(nonTransactional.report, null, 2),
    );
    for (const engine of nonTransactional.report.engines) {
      assertEquals(engine.compatible, true);
      assertEquals(engine.appliedMigrations.length, 4);
    }
    await Deno.remove(requirementsFile);

    const invalidFile = join(project.migrationsDir, "20260803000400_invalid.sql");
    await Deno.writeTextFile(
      invalidFile,
      "create table public.valid_probe(id integer);\nselect * from ;\n",
    );
    const invalid = await runMigrationCheck(root, runtimeDir);
    assertEquals(invalid.code, 2, invalid.stderr);
    assertEquals(invalid.stderr, "");
    assertEquals(invalid.stdoutLines, 1);
    assertEquals(invalid.report.ok, false);
    assertEquals(invalid.report.complete, true);
    for (const engine of invalid.report.engines) {
      assertEquals(engine.compatible, false);
      const diagnostic = engine.diagnostics.find((item) =>
        item.code.startsWith("migration.execution")
      );
      assert(diagnostic !== undefined);
      assertStringIncludes(diagnostic.file ?? "", "20260803000400_invalid.sql");
      assertEquals(diagnostic.line, 2);
      assert((diagnostic.column ?? 0) > 0);
    }
    assertEquals(await exists(project.pgliteDataDir), false);
    assertEquals(await exists(project.postgresDataDir), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function runMigrationCheck(
  project: string,
  postgresRuntime: string,
): Promise<{
  code: number;
  stderr: string;
  stdoutLines: number;
  report: MigrationCheckReport;
}> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "migration",
      "check",
      "--project",
      project,
      "--json",
    ],
    env: { MINIBASE_POSTGRES_RUNTIME_DIR: postgresRuntime },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  return {
    code: output.code,
    stderr,
    stdoutLines: stdout.length === 0 ? 0 : stdout.split(/\r?\n/u).length,
    report: JSON.parse(stdout) as MigrationCheckReport,
  };
}

async function findPostgresRuntime(): Promise<string | null> {
  const candidates = [
    Deno.env.get("MINIBASE_POSTGRES_RUNTIME_DIR"),
    "C:\\Users\\admin\\AppData\\Local\\minibase-dev-cache\\postgresql-18.4-windows-x64\\pgsql",
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (await exists(join(candidate, "bin", "postgres.exe"))) return candidate;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile || (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

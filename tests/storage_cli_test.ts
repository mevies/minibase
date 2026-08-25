import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import type { DoctorReport } from "../src/diagnostics/doctor.ts";
import { applyMigrations } from "../src/migrations/runner.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject } from "../src/project/state.ts";
import type { StorageConsistencyReport } from "../src/storage/consistency.ts";
import { LocalObjectStore } from "../src/storage/local.ts";

Deno.test("Storage CLI reports by default and repairs only with explicit force", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-storage-cli-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.storage.driver, "local");
    assertEquals(config.storage.path, project.storageDir);
    await prepareProject(project, "pglite");

    const engine = new PGliteEngine(project.pgliteDataDir);
    const store = new LocalObjectStore(config.storage.path);
    try {
      await engine.start();
      await applyMigrations(engine, project);
      await engine.query(
        "insert into storage.buckets(id, name) values ('checks', 'checks')",
      );
      await engine.query(
        `insert into storage.objects(id, bucket_id, name, metadata)
         values
           ($1, 'checks', 'missing.txt', '{"size":7}'::jsonb),
           ($2, 'checks', 'wrong-size.txt', '{"size":99}'::jsonb)`,
        [crypto.randomUUID(), crypto.randomUUID()],
      );
      await committedWrite(store, "checks", "wrong-size.txt", "abc");
      await committedWrite(store, "checks", "orphan.txt", "orphan");
      await committedWrite(store, "checks", "stale.minibase-upload-dead", "temporary");
    } finally {
      await engine.close();
    }
    assert((await Deno.stat(store.path("checks", "orphan.txt"))).isFile);

    const doctor = await runCliProcess(["doctor", "--project", root, "--json"], root);
    assertEquals(doctor.code, 2, doctor.stderr);
    assertEquals(doctor.stderr, "");
    assertEquals(doctor.stdout.split(/\r?\n/u).length, 1);
    const doctorReport = JSON.parse(doctor.stdout) as DoctorReport;
    assertEquals(doctorReport.ok, false);
    assert(
      doctorReport.checks.some((check) => check.code === "storage.consistency.missing_files"),
    );
    assert(
      doctorReport.checks.some((check) => check.code === "storage.consistency.orphan_files"),
    );
    assert(
      doctorReport.checks.some((check) => check.code === "storage.consistency.temporary_files"),
    );
    assert(
      doctorReport.checks.some((check) => check.code === "storage.consistency.size_mismatches"),
    );

    const checked = await runCliProcess(
      ["storage", "check", "--project", root, "--json"],
      root,
    );
    assertEquals(checked.code, 3, checked.stderr);
    assertEquals(checked.stderr, "");
    assertEquals(checked.stdout.split(/\r?\n/u).length, 1);
    const checkedReport = JSON.parse(checked.stdout) as StorageConsistencyReport;
    assertEquals(checkedReport.ok, false);
    assertEquals(checkedReport.repaired, false);
    assertEquals(checkedReport.missingFiles[0]?.name, "missing.txt");
    assertEquals(checkedReport.orphanFiles[0]?.name, "orphan.txt");
    assertEquals(checkedReport.temporaryFiles[0]?.name, "stale.minibase-upload-dead");
    assertEquals(checkedReport.sizeMismatches[0]?.name, "wrong-size.txt");

    const unchanged = new PGliteEngine(project.pgliteDataDir);
    try {
      await unchanged.start();
      assertEquals(
        (await unchanged.query<{ count: number }>(
          "select count(*)::int as count from storage.objects where name = 'missing.txt'",
        )).rows,
        [{ count: 1 }],
      );
    } finally {
      await unchanged.close();
    }
    assert((await Deno.stat(store.path("checks", "orphan.txt"))).isFile);

    const unconfirmed = await runCliProcess(
      ["storage", "repair", "--project", root, "--json"],
      root,
    );
    assertEquals(unconfirmed.code, 1);
    assertEquals(unconfirmed.stdout, "");
    assertStringIncludes(unconfirmed.stderr, "requires --force");

    const repaired = await runCliProcess(
      ["storage", "repair", "--project", root, "--force", "--json"],
      root,
    );
    assertEquals(repaired.code, 0, repaired.stderr);
    assertEquals(repaired.stderr, "");
    assertEquals((JSON.parse(repaired.stdout) as StorageConsistencyReport).repaired, true);

    const finalCheck = await runCliProcess(
      ["storage", "check", "--project", root, "--json"],
      root,
    );
    assertEquals(finalCheck.code, 0, finalCheck.stderr);
    assertEquals((JSON.parse(finalCheck.stdout) as StorageConsistencyReport).ok, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function committedWrite(
  store: LocalObjectStore,
  bucket: string,
  name: string,
  value: string,
): Promise<void> {
  const write = await store.write(bucket, name, new Blob([value]).stream());
  await write.commit();
  await write.finalize();
}

async function runCliProcess(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
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

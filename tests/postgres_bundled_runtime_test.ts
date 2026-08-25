import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import {
  ensureBundledPostgresRuntime,
  POSTGRES_RUNTIME_ARCHIVE_MAGIC,
  type PostgresRuntimeFileRecord,
  type PostgresRuntimeManifest,
  postgresRuntimeTreeSha256,
} from "../src/database/postgres_bundled.ts";

Deno.test("bundled PostgreSQL Runtime extracts once and rejects cache tampering", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-runtime-test-" });
  try {
    const archive = join(temp, "postgres.mbpg.gz");
    const manifestPath = join(temp, "postgres.json");
    const sources = new Map([
      ["bin/initdb.exe", new TextEncoder().encode("controlled-initdb")],
      ["bin/pg_ctl.exe", new TextEncoder().encode("controlled-pg-ctl")],
      ["bin/postgres.exe", new TextEncoder().encode("controlled-postgres")],
      ["lib/plpgsql.dll", new TextEncoder().encode("controlled-plpgsql")],
      ["share/postgres.bki", new TextEncoder().encode("controlled-catalog")],
    ]);
    const files = [...sources].map(([path, contents]) => ({
      path,
      bytes: contents.byteLength,
      sha256: sha256Bytes(contents),
    })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    await writeArchive(archive, files, sources);
    const manifest: PostgresRuntimeManifest = {
      formatVersion: 1,
      product: "postgresql-runtime",
      version: "18.4",
      platform: "windows-x64",
      archiveSha256: await sha256File(archive),
      treeSha256: postgresRuntimeTreeSha256(files),
      files,
    };
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const options = { cacheRoot: join(temp, "cache"), archive, manifest: manifestPath };

    const [first, concurrent] = await Promise.all([
      ensureBundledPostgresRuntime(options),
      ensureBundledPostgresRuntime(options),
    ]);
    assertEquals(concurrent, first);
    const executable = join(first, "bin", "postgres.exe");
    const before = await record(executable);
    assertEquals(await ensureBundledPostgresRuntime(options), first);
    assertEquals(await record(executable), before);

    await Deno.writeTextFile(executable, "tampered-postgres");
    const error = await assertRejects(
      () => ensureBundledPostgresRuntime(options),
      Error,
      "Bundled PostgreSQL Runtime integrity check failed",
    );
    assertStringIncludes(error.message, `remove ${first}`);

    await Deno.writeFile(executable, sources.get("bin/postgres.exe")!);
    await Deno.writeTextFile(join(first, "bin", "version.dll"), "unlisted-dll");
    const unexpected = await assertRejects(
      () => ensureBundledPostgresRuntime(options),
      Error,
      "Bundled PostgreSQL Runtime integrity check failed",
    );
    assertStringIncludes(unexpected.message, "unexpected file bin/version.dll");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("bundled PostgreSQL Runtime accepts the controlled Linux PGDG layout", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-linux-runtime-test-" });
  try {
    const archive = join(temp, "postgres.mbpg.gz");
    const manifestPath = join(temp, "postgres.json");
    const sources = new Map([
      ["usr/lib/postgresql/18/bin/initdb", new TextEncoder().encode("controlled-initdb")],
      ["usr/lib/postgresql/18/bin/pg_ctl", new TextEncoder().encode("controlled-pg-ctl")],
      ["usr/lib/postgresql/18/bin/postgres", new TextEncoder().encode("controlled-postgres")],
      ["usr/lib/postgresql/18/lib/plpgsql.so", new TextEncoder().encode("controlled-plpgsql")],
      ["usr/lib/x86_64-linux-gnu/libpq.so.5", new TextEncoder().encode("controlled-libpq")],
      ["usr/share/postgresql/18/postgres.bki", new TextEncoder().encode("controlled-catalog")],
    ]);
    const files = [...sources].map(([path, contents]) => ({
      path,
      bytes: contents.byteLength,
      sha256: sha256Bytes(contents),
    })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    await writeArchive(archive, files, sources);
    const manifest: PostgresRuntimeManifest = {
      formatVersion: 1,
      product: "postgresql-runtime",
      version: "18.4",
      platform: "linux-x64",
      archiveSha256: await sha256File(archive),
      treeSha256: postgresRuntimeTreeSha256(files),
      files,
    };
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const runtime = await ensureBundledPostgresRuntime({
      cacheRoot: join(temp, "cache"),
      archive,
      manifest: manifestPath,
    });
    assertEquals(
      await Deno.readTextFile(join(runtime, "usr", "share", "postgresql", "18", "postgres.bki")),
      "controlled-catalog",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("bundled PostgreSQL Runtime accepts the controlled macOS source layout", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-macos-runtime-test-" });
  try {
    const archive = join(temp, "postgres.mbpg.gz");
    const manifestPath = join(temp, "postgres.json");
    const sources = new Map([
      ["bin/initdb", new TextEncoder().encode("controlled-initdb")],
      ["bin/pg_ctl", new TextEncoder().encode("controlled-pg-ctl")],
      ["bin/postgres", new TextEncoder().encode("controlled-postgres")],
      ["lib/pgcrypto.so", new TextEncoder().encode("controlled-pgcrypto")],
      ["lib/uuid-ossp.so", new TextEncoder().encode("controlled-uuid-ossp")],
      ["share/postgres.bki", new TextEncoder().encode("controlled-catalog")],
    ]);
    const files = [...sources].map(([path, contents]) => ({
      path,
      bytes: contents.byteLength,
      sha256: sha256Bytes(contents),
    })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    await writeArchive(archive, files, sources);
    const manifest: PostgresRuntimeManifest = {
      formatVersion: 1,
      product: "postgresql-runtime",
      version: "18.4",
      platform: "macos-arm64",
      archiveSha256: await sha256File(archive),
      treeSha256: postgresRuntimeTreeSha256(files),
      files,
    };
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const runtime = await ensureBundledPostgresRuntime({
      cacheRoot: join(temp, "cache"),
      archive,
      manifest: manifestPath,
    });
    assertEquals(
      await Deno.readTextFile(join(runtime, "share", "postgres.bki")),
      "controlled-catalog",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("bundled PostgreSQL Runtime rejects Linux archive path traversal", async () => {
  const temp = await Deno.makeTempDir({ prefix: "minibase-postgres-linux-path-test-" });
  try {
    const archive = join(temp, "postgres.mbpg.gz");
    const manifestPath = join(temp, "postgres.json");
    const sources = new Map([
      ["usr/lib/postgresql/18/bin/initdb", new TextEncoder().encode("controlled-initdb")],
      ["usr/lib/postgresql/18/bin/pg_ctl", new TextEncoder().encode("controlled-pg-ctl")],
      ["usr/lib/postgresql/18/bin/postgres", new TextEncoder().encode("controlled-postgres")],
      ["usr/lib/postgresql/18/bin/../escaped", new TextEncoder().encode("escaped")],
    ]);
    const files = [...sources].map(([path, contents]) => ({
      path,
      bytes: contents.byteLength,
      sha256: sha256Bytes(contents),
    })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    await writeArchive(archive, files, sources);
    const manifest: PostgresRuntimeManifest = {
      formatVersion: 1,
      product: "postgresql-runtime",
      version: "18.4",
      platform: "linux-x64",
      archiveSha256: await sha256File(archive),
      treeSha256: postgresRuntimeTreeSha256(files),
      files,
    };
    await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assertRejects(
      () =>
        ensureBundledPostgresRuntime({
          cacheRoot: join(temp, "cache"),
          archive,
          manifest: manifestPath,
        }),
      Error,
      "Bundled PostgreSQL Runtime file record is invalid",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

async function writeArchive(
  destination: string,
  files: PostgresRuntimeFileRecord[],
  sources: Map<string, Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const output = await Deno.open(destination, { createNew: true, write: true });
  const compression = new CompressionStream("gzip");
  const piping = compression.readable.pipeTo(output.writable);
  const writer = compression.writable.getWriter();
  await writer.write(new TextEncoder().encode(POSTGRES_RUNTIME_ARCHIVE_MAGIC));
  for (const file of files) {
    const path = new TextEncoder().encode(file.path);
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    view.setUint32(0, path.byteLength);
    view.setBigUint64(4, BigInt(file.bytes));
    header.set(digestBytes(file.sha256), 12);
    await writer.write(header);
    await writer.write(path);
    await writer.write(sources.get(file.path)!);
  }
  await writer.write(new Uint8Array(4));
  await writer.close();
  await piping;
}

function digestBytes(value: string): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function sha256Bytes(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await Deno.readFile(path)).digest("hex");
}

async function record(path: string): Promise<{ sha256: string; modified: number | null }> {
  const stat = await Deno.stat(path);
  return { sha256: await sha256File(path), modified: stat.mtime?.getTime() ?? null };
}

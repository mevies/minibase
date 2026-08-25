import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { runRealS3Probe, validateProviderEndpoint } from "../scripts/s3_real_probe.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";
import {
  createRealS3EvidenceManifest,
  REAL_S3_LARGE_OBJECT_BYTES,
  type RealS3ProbeReport,
  validateRealS3EvidenceDirectory,
} from "../scripts/s3_real_report.ts";

Deno.test("real S3 probe exercises copies, ownership, streaming and cleanup", async () => {
  const fixture = startConditionalS3Fixture();
  const endpoint = `http://127.0.0.1:${await fixture.port}`;
  try {
    const report = await runRealS3Probe({
      provider: "cloudflare-r2",
      runnerId: "real-s3-fixture",
      config: {
        endpoint,
        region: "auto",
        bucket: "root-bucket",
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret-never-report",
        pathStyle: true,
      },
      git: { commit: "1".repeat(40), dirty: false },
      allowTestEndpoint: true,
    });
    assertEquals(report.provider, "cloudflare-r2");
    assertEquals(report.configuration.largeObjectBytes, REAL_S3_LARGE_OBJECT_BYTES);
    assertEquals(report.checks.cleanupVerified, true);
    assertEquals(report.observations.listedDataObjects, 2);
    assertEquals(fixture.objects.size, 1);
    const ownership = fixture.objects.get(".minibase/ownership-v1.json");
    assertEquals(
      JSON.parse(new TextDecoder().decode(ownership?.body)).state,
      "released",
    );
    const serialized = JSON.stringify(report);
    assertEquals(serialized.includes("fixture-access"), false);
    assertEquals(serialized.includes("fixture-secret-never-report"), false);
    assertEquals(serialized.includes("root-bucket"), false);
    assertEquals(fixture.conditionalRequests >= 5, true);
    assertEquals(fixture.copyRequests >= 5, true);
  } finally {
    await fixture.close();
  }
});

Deno.test("real S3 evidence pairs AWS and R2 reports and rejects tampering", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-real-s3-evidence-test-" });
  try {
    const awsPath = join(root, "source-aws.json");
    const r2Path = join(root, "source-r2.json");
    await writeReport(awsPath, validReport("aws-s3"));
    await writeReport(r2Path, validReport("cloudflare-r2"));
    const evidence = join(root, "evidence");
    await Deno.mkdir(evidence);
    await Deno.copyFile(awsPath, join(evidence, "aws-s3.json"));
    await Deno.copyFile(r2Path, join(evidence, "cloudflare-r2.json"));
    await Deno.writeTextFile(
      join(evidence, "evidence.json"),
      JSON.stringify(await createRealS3EvidenceManifest(awsPath, r2Path), null, 2) + "\n",
    );
    const summary = await validateRealS3EvidenceDirectory(evidence);
    assertEquals(summary.runnerId, "fixed-real-s3-test");
    assertEquals(summary.awsS3.provider, "aws-s3");
    assertEquals(summary.cloudflareR2.provider, "cloudflare-r2");

    await Deno.writeTextFile(join(evidence, "cloudflare-r2.json"), "{}\n");
    await assertRejects(
      () => validateRealS3EvidenceDirectory(evidence),
      Error,
      "Cloudflare R2 evidence checksum does not match",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("real S3 evidence rejects reports with incomplete check sets", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-real-s3-incomplete-test-" });
  try {
    const awsPath = join(root, "aws-s3.json");
    const r2Path = join(root, "cloudflare-r2.json");
    const aws = validReport("aws-s3") as unknown as Record<string, unknown>;
    const checks = aws.checks as Record<string, unknown>;
    delete checks.cleanupVerified;
    await Deno.writeTextFile(awsPath, JSON.stringify(aws, null, 2) + "\n");
    await writeReport(r2Path, validReport("cloudflare-r2"));
    await assertRejects(
      () => createRealS3EvidenceManifest(awsPath, r2Path),
      Error,
      "cleanupVerified",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("real S3 probe never deletes an active foreign ownership record", async () => {
  const fixture = startConditionalS3Fixture();
  const endpoint = `http://127.0.0.1:${await fixture.port}`;
  const ownershipKey = ".minibase/ownership-v1.json";
  const timestamp = "2026-08-06T00:00:00.000Z";
  fixture.objects.set(ownershipKey, {
    etag: '"foreign-owner"',
    body: new TextEncoder().encode(JSON.stringify({
      formatVersion: 1,
      state: "active",
      instanceId: "foreign-instance",
      projectId: "foreign-project",
      processId: 1234,
      acquiredAt: timestamp,
      observedAt: timestamp,
    })),
  });
  try {
    await assertRejects(
      () =>
        runRealS3Probe({
          provider: "cloudflare-r2",
          runnerId: "real-s3-fixture",
          config: {
            endpoint,
            region: "auto",
            bucket: "root-bucket",
            accessKeyId: "fixture-access",
            secretAccessKey: "fixture-secret-never-report",
            pathStyle: true,
          },
          git: { commit: "1".repeat(40), dirty: false },
          allowTestEndpoint: true,
        }),
      Error,
      "already owned by another Minibase writer",
    );
    assertEquals(fixture.objects.has(ownershipKey), true);
    assertEquals(fixture.objects.get(ownershipKey)?.etag, '"foreign-owner"');
  } finally {
    await fixture.close();
  }
});

Deno.test("S3 ownership release rejects a concurrent writer takeover", async () => {
  const fixture = startConditionalS3Fixture();
  const endpoint = `http://127.0.0.1:${await fixture.port}`;
  const ownershipKey = ".minibase/ownership-v1.json";
  const store = new S3ObjectStore({
    endpoint,
    region: "auto",
    bucket: "root-bucket",
    accessKeyId: "fixture-access",
    secretAccessKey: "fixture-secret-never-report",
    pathStyle: true,
  }, { ownershipRequired: true, ownershipHeartbeatMs: 60_000 });
  try {
    await store.acquireOwnership("release-race-owner");
    const timestamp = "2026-08-06T00:00:00.000Z";
    fixture.objects.set(ownershipKey, {
      etag: '"foreign-takeover"',
      body: new TextEncoder().encode(JSON.stringify({
        formatVersion: 1,
        state: "active",
        instanceId: "foreign-instance",
        projectId: "foreign-project",
        processId: 4321,
        acquiredAt: timestamp,
        observedAt: timestamp,
      })),
    });
    await assertRejects(
      () => store.releaseOwnership(),
      Error,
      "changed while Minibase was releasing it",
    );
    assertEquals(fixture.objects.get(ownershipKey)?.etag, '"foreign-takeover"');
    assertEquals(
      JSON.parse(new TextDecoder().decode(fixture.objects.get(ownershipKey)?.body)).state,
      "active",
    );
  } finally {
    await fixture.close();
  }
});

Deno.test("real S3 provider identities reject local and lookalike endpoints", () => {
  assertEquals(
    validateProviderEndpoint(
      "aws-s3",
      "https://s3.us-east-1.amazonaws.com",
      "us-east-1",
    ),
    "amazon-s3",
  );
  assertEquals(
    validateProviderEndpoint(
      "cloudflare-r2",
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
      "auto",
    ),
    "cloudflare-r2",
  );
  assertThrows(
    () => validateProviderEndpoint("aws-s3", "http://127.0.0.1:9000", "us-east-1"),
    Error,
    "HTTPS endpoint",
  );
  assertThrows(
    () =>
      validateProviderEndpoint(
        "aws-s3",
        "https://s3.us-east-1.amazonaws.com.example.test",
        "us-east-1",
      ),
    Error,
    "official amazonaws.com",
  );
  assertThrows(
    () =>
      validateProviderEndpoint(
        "cloudflare-r2",
        `https://${"a".repeat(32)}.r2.cloudflarestorage.com.example.test`,
        "auto",
      ),
    Error,
    "official r2.cloudflarestorage.com",
  );
});

interface FixtureObject {
  body: Uint8Array;
  etag: string;
}

function startConditionalS3Fixture(): {
  port: Promise<number>;
  objects: Map<string, FixtureObject>;
  readonly conditionalRequests: number;
  readonly copyRequests: number;
  close(): Promise<void>;
} {
  const objects = new Map<string, FixtureObject>();
  let revision = 0;
  let conditionalRequests = 0;
  let copyRequests = 0;
  const abort = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => listening.resolve(address.port),
    },
    async (request) => {
      const authorization = request.headers.get("authorization") ?? "";
      assertStringIncludes(authorization, "AWS4-HMAC-SHA256 Credential=fixture-access/");
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.replace(/^\/root-bucket\/?/u, ""));
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        const contents = [...objects.entries()].toSorted(([left], [right]) =>
          left.localeCompare(right, "en")
        ).map(([name, object]) =>
          `<Contents><Key>${
            escapeXml(encodeURIComponent(name))
          }</Key><Size>${object.body.byteLength}</Size></Contents>`
        ).join("");
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      if (request.method === "PUT") {
        const current = objects.get(key);
        const ifNoneMatch = request.headers.get("if-none-match");
        const ifMatch = request.headers.get("if-match");
        if (ifNoneMatch !== null || ifMatch !== null) conditionalRequests++;
        if (ifNoneMatch === "*" && current !== undefined) {
          return new Response("precondition failed", { status: 412 });
        }
        if (ifMatch !== null && current?.etag !== ifMatch) {
          return new Response("precondition failed", { status: 412 });
        }
        const copySource = request.headers.get("x-amz-copy-source");
        let body: Uint8Array;
        if (copySource === null) {
          body = new Uint8Array(await request.arrayBuffer());
        } else {
          copyRequests++;
          const sourceKey = decodeURIComponent(copySource.replace(/^\/root-bucket\//u, ""));
          const source = objects.get(sourceKey);
          if (source === undefined) return new Response("missing", { status: 404 });
          body = source.body.slice();
        }
        const etag = `"revision-${++revision}"`;
        objects.set(key, { body, etag });
        return new Response(
          copySource === null ? null : `<CopyObjectResult><ETag>${etag}</ETag></CopyObjectResult>`,
          { status: 200, headers: { etag, "content-type": "application/xml" } },
        );
      }
      if (request.method === "GET") {
        const object = objects.get(key);
        return object === undefined
          ? new Response("missing", { status: 404 })
          : new Response(object.body.slice(), {
            headers: { etag: object.etag, "content-length": String(object.body.byteLength) },
          });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("unsupported", { status: 405 });
    },
  );
  return {
    port: listening.promise,
    objects,
    get conditionalRequests() {
      return conditionalRequests;
    },
    get copyRequests() {
      return copyRequests;
    },
    close: async () => {
      abort.abort();
      await server.finished;
    },
  };
}

function validReport(provider: "aws-s3" | "cloudflare-r2"): RealS3ProbeReport {
  return {
    schemaVersion: 1,
    runId: provider === "aws-s3"
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222",
    recordedAt: "2026-08-06T00:00:00.000Z",
    provider,
    endpointClass: provider === "aws-s3" ? "amazon-s3" : "cloudflare-r2",
    git: { commit: "3".repeat(40), dirty: false },
    runner: { id: "fixed-real-s3-test" },
    toolchain: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
    },
    configuration: {
      region: provider === "aws-s3" ? "us-east-1" : "auto",
      pathStyle: provider === "cloudflare-r2",
      bucketSha256: "4".repeat(64),
      largeObjectBytes: REAL_S3_LARGE_OBJECT_BYTES,
      chunkBytes: 256 * 1_024,
    },
    execution: {
      startedAt: "2026-08-06T00:00:00.000Z",
      endedAt: "2026-08-06T00:00:01.000Z",
      durationMs: 1_000,
    },
    checks: {
      tlsEndpoint: true,
      emptyBefore: true,
      health: true,
      ownershipAcquired: true,
      ownershipConflictRejected: true,
      copyCommit: true,
      rollbackRestored: true,
      overwriteFinalized: true,
      largeStreamRoundTrip: true,
      listClean: true,
      ownershipHandoff: true,
      cleanupVerified: true,
      credentialsExcluded: true,
    },
    observations: {
      initialObjectSha256: "5".repeat(64),
      replacementObjectSha256: "6".repeat(64),
      largeObjectSha256: "7".repeat(64),
      listedDataObjects: 2,
    },
  };
}

async function writeReport(path: string, report: RealS3ProbeReport): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

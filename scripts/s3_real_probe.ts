import { dirname, resolve } from "@std/path";
import { ObjectStoreError, type StoredObject } from "../src/storage/contract.ts";
import { S3ObjectStore } from "../src/storage/s3.ts";
import {
  REAL_S3_CHUNK_BYTES,
  REAL_S3_LARGE_OBJECT_BYTES,
  type RealS3EndpointClass,
  type RealS3ProbeReport,
  type RealS3Provider,
  sha256Bytes,
  validateRealS3ProbeReport,
} from "./s3_real_report.ts";

interface S3ProbeConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle: boolean;
}

export interface RunRealS3ProbeOptions {
  provider: RealS3Provider;
  runnerId: string;
  config: S3ProbeConfig;
  git: { commit: string; dirty: false };
  allowTestEndpoint?: boolean;
}

export async function runRealS3Probe(
  options: RunRealS3ProbeOptions,
): Promise<RealS3ProbeReport> {
  validateRunnerId(options.runnerId);
  const allowTestEndpoint = options.allowTestEndpoint ?? false;
  validateProbeConfig(options.provider, options.config, allowTestEndpoint);
  const endpointClass = validateProviderEndpoint(
    options.provider,
    options.config.endpoint,
    options.config.region,
    allowTestEndpoint,
  );
  const runId = crypto.randomUUID();
  const projectId = `real-s3-${options.provider}-${runId}`;
  const probeBucket = `probe-${runId}`;
  const firstName = "objects/space and unicode-测试.txt";
  const largeName = "objects/large-stream.bin";
  const firstBytes = new TextEncoder().encode(`minibase real S3 probe ${runId}`);
  const replacementBytes = new TextEncoder().encode(`minibase replacement ${runId}`);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const primary = new S3ObjectStore(options.config, {
    ownershipRequired: true,
    ownershipHeartbeatMs: 60_000,
  });
  const contender = new S3ObjectStore(options.config, {
    ownershipRequired: true,
    ownershipHeartbeatMs: 60_000,
  });
  let primaryOwned = false;
  let contenderOwned = false;
  let listedDataObjects = 0;
  let largeObjectSha256 = "";
  let failure: unknown;
  let completedReport: RealS3ProbeReport | undefined;
  try {
    const initial = await primary.list();
    if (initial.length !== 0) {
      throw new Error(
        "Real S3 evidence requires a dedicated root bucket with no data or temporary objects",
      );
    }
    await primary.acquireOwnership(projectId);
    primaryOwned = true;
    if (!(await primary.health())) throw new Error("Real S3 health probe failed");

    try {
      await contender.acquireOwnership(`${projectId}-contender`);
      contenderOwned = true;
      throw new Error("Real S3 backend allowed two simultaneous Minibase writers");
    } catch (error) {
      if (
        !(error instanceof ObjectStoreError) || error.code !== "StorageOwnershipConflict"
      ) {
        throw error;
      }
    }

    const firstWrite = await primary.write(probeBucket, firstName, streamBytes(firstBytes));
    assert(firstWrite.size === firstBytes.byteLength, "Real S3 staged size is incorrect");
    await firstWrite.commit();
    await firstWrite.finalize();
    await assertObject(primary, probeBucket, firstName, firstBytes);

    const rollbackWrite = await primary.write(
      probeBucket,
      firstName,
      streamBytes(replacementBytes),
    );
    await rollbackWrite.commit();
    await rollbackWrite.rollback();
    await assertObject(primary, probeBucket, firstName, firstBytes);

    const replacementWrite = await primary.write(
      probeBucket,
      firstName,
      streamBytes(replacementBytes),
    );
    await replacementWrite.commit();
    await replacementWrite.finalize();
    await assertObject(primary, probeBucket, firstName, replacementBytes);

    const largeWrite = await primary.write(
      probeBucket,
      largeName,
      deterministicLargeStream(),
    );
    assert(
      largeWrite.size === REAL_S3_LARGE_OBJECT_BYTES,
      "Real S3 large streamed size is incorrect",
    );
    await largeWrite.commit();
    await largeWrite.finalize();
    const largeObject = await primary.read(probeBucket, largeName);
    const largeBytes = await readObjectBytes(largeObject);
    assert(
      largeBytes.byteLength === REAL_S3_LARGE_OBJECT_BYTES,
      "Real S3 large object length changed",
    );
    assertDeterministicLargeBytes(largeBytes);
    largeObjectSha256 = await sha256Bytes(largeBytes);

    const listed = await primary.list();
    const data = listed.filter((object) => object.kind === "data");
    const temporary = listed.filter((object) => object.kind === "temporary");
    listedDataObjects = data.length;
    assert(data.length === 2, "Real S3 listing did not return exactly two data objects");
    assert(temporary.length === 0, "Real S3 listing found unfinished temporary objects");

    await primary.remove(probeBucket, firstName);
    await primary.remove(probeBucket, largeName);
    assert((await primary.list()).length === 0, "Real S3 data cleanup did not empty the bucket");

    await primary.releaseOwnership();
    primaryOwned = false;
    await contender.acquireOwnership(`${projectId}-handoff`);
    contenderOwned = true;
    if (!(await contender.health())) throw new Error("Real S3 handoff health probe failed");
    await contender.releaseOwnership();
    contenderOwned = false;
    assert((await primary.list()).length === 0, "Real S3 final cleanup left visible objects");
    const endedAt = new Date().toISOString();
    const report: RealS3ProbeReport = {
      schemaVersion: 1,
      runId,
      recordedAt: endedAt,
      provider: options.provider,
      endpointClass,
      git: options.git,
      runner: { id: options.runnerId },
      toolchain: {
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        typescript: Deno.version.typescript,
      },
      configuration: {
        region: options.config.region,
        pathStyle: options.config.pathStyle,
        bucketSha256: await sha256Bytes(new TextEncoder().encode(options.config.bucket)),
        largeObjectBytes: REAL_S3_LARGE_OBJECT_BYTES,
        chunkBytes: REAL_S3_CHUNK_BYTES,
      },
      execution: {
        startedAt,
        endedAt,
        durationMs: Math.max(0.001, performance.now() - started),
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
        initialObjectSha256: await sha256Bytes(firstBytes),
        replacementObjectSha256: await sha256Bytes(replacementBytes),
        largeObjectSha256,
        listedDataObjects,
      },
    };
    const serialized = JSON.stringify(report);
    for (
      const secret of [
        options.config.accessKeyId,
        options.config.secretAccessKey,
        options.config.sessionToken,
        options.config.bucket,
        new URL(options.config.endpoint).hostname.split(".", 1)[0],
      ]
    ) {
      if (secret !== undefined && secret.length >= 4) {
        assert(
          !serialized.includes(secret),
          "Real S3 report contains a credential or account value",
        );
      }
    }
    completedReport = validateRealS3ProbeReport(report, options.provider);
  } catch (error) {
    failure = error;
  }
  const cleanupErrors: string[] = [];
  if (primaryOwned) {
    await deleteProbeObjects(primary, probeBucket).catch((error) =>
      cleanupErrors.push(errorMessage(error))
    );
    await primary.releaseOwnership().catch((error) => cleanupErrors.push(errorMessage(error)));
  }
  if (contenderOwned) {
    await deleteProbeObjects(contender, probeBucket).catch((error) =>
      cleanupErrors.push(errorMessage(error))
    );
    await contender.releaseOwnership().catch((error) => cleanupErrors.push(errorMessage(error)));
  }
  if (cleanupErrors.length > 0) {
    if (failure === undefined) {
      throw new Error(`Real S3 cleanup failed: ${cleanupErrors.join("; ")}`);
    }
    throw new AggregateError(
      [failure, ...cleanupErrors.map((message) => new Error(message))],
      "Real S3 probe failed and cleanup was incomplete",
    );
  }
  if (failure !== undefined) throw failure;
  assert(completedReport !== undefined, "Real S3 probe did not produce a report");
  return completedReport;
}

export function validateProviderEndpoint(
  provider: RealS3Provider,
  endpointValue: string,
  region: string,
  allowTestEndpoint = false,
): RealS3EndpointClass {
  const endpoint = new URL(endpointValue);
  if (!allowTestEndpoint) {
    assert(endpoint.protocol === "https:", "Real S3 evidence requires an HTTPS endpoint");
    assert(
      endpoint.username === "" && endpoint.password === "",
      "S3 endpoint cannot contain userinfo",
    );
    assert(
      endpoint.search === "" && endpoint.hash === "",
      "S3 endpoint cannot contain query or fragment",
    );
    assert(endpoint.port === "" || endpoint.port === "443", "Real S3 endpoint must use port 443");
    assert(endpoint.pathname === "/", "Real S3 endpoint cannot contain a path prefix");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (provider === "aws-s3") {
    if (!allowTestEndpoint) {
      assert(
        /^s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/u.test(hostname),
        "AWS S3 evidence must use an official amazonaws.com S3 endpoint",
      );
      assert(region !== "auto", "AWS S3 evidence requires an AWS region");
    }
    return "amazon-s3";
  }
  if (!allowTestEndpoint) {
    assert(
      /^[0-9a-f]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/u.test(hostname),
      "Cloudflare R2 evidence must use an official r2.cloudflarestorage.com endpoint",
    );
    assert(region === "auto", "Cloudflare R2 evidence requires region auto");
  }
  return "cloudflare-r2";
}

function deterministicLargeStream(): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === REAL_S3_LARGE_OBJECT_BYTES) {
        controller.close();
        return;
      }
      const length = Math.min(REAL_S3_CHUNK_BYTES, REAL_S3_LARGE_OBJECT_BYTES - offset);
      const chunk = new Uint8Array(length);
      for (let index = 0; index < length; index++) chunk[index] = (offset + index) % 251;
      offset += length;
      controller.enqueue(chunk);
    },
  });
}

function assertDeterministicLargeBytes(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== index % 251) {
      throw new Error(`Real S3 large object changed at byte ${index}`);
    }
  }
}

async function assertObject(
  store: S3ObjectStore,
  bucket: string,
  name: string,
  expected: Uint8Array,
): Promise<void> {
  const actual = await readObjectBytes(await store.read(bucket, name));
  assert(actual.byteLength === expected.byteLength, "Real S3 object length changed");
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`Real S3 object changed at byte ${index}`);
    }
  }
}

async function readObjectBytes(object: StoredObject): Promise<Uint8Array> {
  if (object.body === null) return new Uint8Array();
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = bytes.slice();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

async function deleteProbeObjects(store: S3ObjectStore, probeBucket: string): Promise<void> {
  for (const object of await store.list()) {
    const ownedData = object.kind === "data" && object.bucket === probeBucket;
    const ownedTemporary = object.kind === "temporary" &&
      object.backendKey?.split("/").includes(probeBucket) === true;
    if (ownedData || ownedTemporary) await store.removeListed(object);
  }
}

async function gitState(): Promise<{ commit: string; dirty: false }> {
  const commitOutput = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(commitOutput.success, "Real S3 evidence requires a Git commit");
  const commit = new TextDecoder().decode(commitOutput.stdout).trim();
  const statusOutput = await new Deno.Command("git", {
    args: ["status", "--porcelain"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(statusOutput.success, "Real S3 evidence could not inspect the Git checkout");
  assert(statusOutput.stdout.byteLength === 0, "Real S3 evidence checkout must be clean");
  assert(/^[0-9a-f]{40}$/u.test(commit), "Real S3 evidence commit is invalid");
  return { commit, dirty: false };
}

function readProviderConfig(provider: RealS3Provider): S3ProbeConfig {
  const prefix = provider === "aws-s3" ? "MINIBASE_REAL_S3_AWS_" : "MINIBASE_REAL_S3_R2_";
  const sessionToken = Deno.env.get(`${prefix}SESSION_TOKEN`)?.trim();
  return {
    endpoint: requiredEnvironment(`${prefix}ENDPOINT`),
    region: requiredEnvironment(`${prefix}REGION`),
    bucket: requiredEnvironment(`${prefix}BUCKET`),
    accessKeyId: requiredEnvironment(`${prefix}ACCESS_KEY_ID`),
    secretAccessKey: requiredEnvironment(`${prefix}SECRET_ACCESS_KEY`),
    ...(sessionToken === undefined || sessionToken.length === 0 ? {} : { sessionToken }),
    pathStyle: parseBoolean(requiredEnvironment(`${prefix}PATH_STYLE`), `${prefix}PATH_STYLE`),
  };
}

function parseArguments(args: string[]): {
  provider: RealS3Provider;
  runnerId: string;
  output: string;
} {
  let provider: RealS3Provider | undefined;
  let runnerId = Deno.env.get("MINIBASE_S3_EVIDENCE_RUNNER")?.trim();
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--provider") {
      const value = requiredValue(args, ++index, argument);
      if (value !== "aws-s3" && value !== "cloudflare-r2") {
        throw new Error("--provider must be aws-s3 or cloudflare-r2");
      }
      provider = value;
    } else if (argument === "--runner-id") runnerId = requiredValue(args, ++index, argument);
    else if (argument === "--output") output = requiredValue(args, ++index, argument);
    else throw new Error(`Unknown real S3 probe option: ${argument}`);
  }
  if (provider === undefined || runnerId === undefined || output === undefined) {
    throw new Error(
      "--provider, --output and --runner-id or MINIBASE_S3_EVIDENCE_RUNNER are required",
    );
  }
  return { provider, runnerId, output: resolve(output) };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function validateRunnerId(value: string): void {
  assert(/^[A-Za-z0-9._-]{1,64}$/u.test(value), "Real S3 runner id is invalid");
}

function validateProbeConfig(
  provider: RealS3Provider,
  config: S3ProbeConfig,
  allowTestEndpoint: boolean,
): void {
  assert(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket) &&
      !config.bucket.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/u.test(config.bucket),
    "Real S3 bucket name is invalid",
  );
  if (provider === "aws-s3") {
    assert(!config.pathStyle, "AWS S3 evidence must use virtual-hosted requests");
    assert(
      !config.bucket.includes("."),
      "AWS S3 virtual-hosted evidence bucket cannot contain dots",
    );
  } else {
    assert(config.pathStyle, "Cloudflare R2 evidence must use path-style requests");
  }
  if (!allowTestEndpoint) {
    assert(
      config.accessKeyId.length >= 8 && config.accessKeyId.length <= 256,
      "Real S3 access key length is invalid",
    );
    assert(
      config.secretAccessKey.length >= 16 && config.secretAccessKey.length <= 256,
      "Real S3 secret key length is invalid",
    );
    if (config.sessionToken !== undefined) {
      assert(
        config.sessionToken.length >= 8 && config.sessionToken.length <= 4_096,
        "Real S3 session token length is invalid",
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (import.meta.main) {
  const options = parseArguments(Deno.args);
  const config = readProviderConfig(options.provider);
  const report = await runRealS3Probe({
    provider: options.provider,
    runnerId: options.runnerId,
    config,
    git: await gitState(),
  });
  const serialized = JSON.stringify(report, null, 2) + "\n";
  await Deno.mkdir(dirname(options.output), { recursive: true });
  await Deno.writeTextFile(options.output, serialized);
  console.log(JSON.stringify({
    ok: true,
    provider: report.provider,
    output: options.output,
    sourceCommit: report.git.commit,
    durationMs: report.execution.durationMs,
    cleanupVerified: report.checks.cleanupVerified,
  }));
}

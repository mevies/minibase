import { join } from "@std/path";
import toolchain from "../toolchain.json" with { type: "json" };

export const REAL_S3_LARGE_OBJECT_BYTES = 16 * 1_024 * 1_024;
export const REAL_S3_CHUNK_BYTES = 256 * 1_024;

export type RealS3Provider = "aws-s3" | "cloudflare-r2";
export type RealS3EndpointClass = "amazon-s3" | "cloudflare-r2";

const REAL_S3_CHECK_NAMES = [
  "tlsEndpoint",
  "emptyBefore",
  "health",
  "ownershipAcquired",
  "ownershipConflictRejected",
  "copyCommit",
  "rollbackRestored",
  "overwriteFinalized",
  "largeStreamRoundTrip",
  "listClean",
  "ownershipHandoff",
  "cleanupVerified",
  "credentialsExcluded",
] as const;

export interface RealS3ProbeReport {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  provider: RealS3Provider;
  endpointClass: RealS3EndpointClass;
  git: { commit: string; dirty: false };
  runner: { id: string };
  toolchain: {
    deno: string;
    v8: string;
    typescript: string;
  };
  configuration: {
    region: string;
    pathStyle: boolean;
    bucketSha256: string;
    largeObjectBytes: number;
    chunkBytes: number;
  };
  execution: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
  checks: {
    tlsEndpoint: true;
    emptyBefore: true;
    health: true;
    ownershipAcquired: true;
    ownershipConflictRejected: true;
    copyCommit: true;
    rollbackRestored: true;
    overwriteFinalized: true;
    largeStreamRoundTrip: true;
    listClean: true;
    ownershipHandoff: true;
    cleanupVerified: true;
    credentialsExcluded: true;
  };
  observations: {
    initialObjectSha256: string;
    replacementObjectSha256: string;
    largeObjectSha256: string;
    listedDataObjects: number;
  };
}

export interface RealS3EvidenceManifest {
  schemaVersion: 1;
  recordedAt: string;
  runnerId: string;
  sourceCommit: string;
  reports: {
    awsS3: { file: "aws-s3.json"; sha256: string };
    cloudflareR2: { file: "cloudflare-r2.json"; sha256: string };
  };
}

export interface RealS3EvidenceSummary {
  runnerId: string;
  sourceCommit: string;
  awsS3: RealS3ProbeReport;
  cloudflareR2: RealS3ProbeReport;
}

export function validateRealS3ProbeReport(
  report: RealS3ProbeReport,
  expectedProvider?: RealS3Provider,
): RealS3ProbeReport {
  assert(report.schemaVersion === 1, "Real S3 report schema version is invalid");
  assert(
    report.provider === "aws-s3" || report.provider === "cloudflare-r2",
    "Real S3 report provider is invalid",
  );
  if (expectedProvider !== undefined) {
    assert(report.provider === expectedProvider, "Real S3 report provider does not match");
  }
  const expectedEndpointClass = report.provider === "aws-s3" ? "amazon-s3" : "cloudflare-r2";
  assert(
    report.endpointClass === expectedEndpointClass,
    "Real S3 report endpoint class is invalid",
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      report.runId,
    ),
    "Real S3 report run id is invalid",
  );
  assert(validTimestamp(report.recordedAt), "Real S3 report timestamp is invalid");
  assert(/^[0-9a-f]{40}$/u.test(report.git.commit), "Real S3 report commit is invalid");
  assert(report.git.dirty === false, "Real S3 report checkout must be clean");
  assert(
    /^[A-Za-z0-9._-]{1,64}$/u.test(report.runner.id),
    "Real S3 report runner id is invalid",
  );
  assert(
    report.toolchain.deno === toolchain.runtimes.deno.required,
    "Real S3 report Deno version is not the audited version",
  );
  assert(report.toolchain.v8.length > 0, "Real S3 report V8 version is missing");
  assert(report.toolchain.typescript.length > 0, "Real S3 report TypeScript version is missing");
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(report.configuration.region),
    "Real S3 report region is invalid",
  );
  if (report.provider === "cloudflare-r2") {
    assert(report.configuration.region === "auto", "Cloudflare R2 report must use region auto");
    assert(report.configuration.pathStyle, "Cloudflare R2 report must use path-style requests");
  } else {
    assert(report.configuration.region !== "auto", "AWS S3 report must use an AWS region");
    assert(!report.configuration.pathStyle, "AWS S3 report must use virtual-hosted requests");
  }
  assert(
    /^[0-9a-f]{64}$/u.test(report.configuration.bucketSha256),
    "Real S3 report bucket hash is invalid",
  );
  assert(
    report.configuration.largeObjectBytes === REAL_S3_LARGE_OBJECT_BYTES,
    "Real S3 report large-object size is invalid",
  );
  assert(
    report.configuration.chunkBytes === REAL_S3_CHUNK_BYTES,
    "Real S3 report chunk size is invalid",
  );
  assert(validTimestamp(report.execution.startedAt), "Real S3 start timestamp is invalid");
  assert(validTimestamp(report.execution.endedAt), "Real S3 end timestamp is invalid");
  assert(
    Date.parse(report.execution.endedAt) >= Date.parse(report.execution.startedAt),
    "Real S3 timestamps are out of order",
  );
  assert(
    Number.isFinite(report.execution.durationMs) && report.execution.durationMs > 0,
    "Real S3 duration is invalid",
  );
  assert(
    report.checks !== null && typeof report.checks === "object",
    "Real S3 checks are missing",
  );
  for (const name of REAL_S3_CHECK_NAMES) {
    assert(report.checks[name] === true, `Real S3 check did not pass: ${name}`);
  }
  assert(
    Object.keys(report.checks).length === REAL_S3_CHECK_NAMES.length,
    "Real S3 report contains an unexpected check set",
  );
  for (const name of Object.keys(report.checks)) {
    assert(
      REAL_S3_CHECK_NAMES.includes(name as (typeof REAL_S3_CHECK_NAMES)[number]),
      `Real S3 report contains an unknown check: ${name}`,
    );
  }
  for (
    const [name, value] of Object.entries({
      initialObjectSha256: report.observations.initialObjectSha256,
      replacementObjectSha256: report.observations.replacementObjectSha256,
      largeObjectSha256: report.observations.largeObjectSha256,
    })
  ) {
    assert(/^[0-9a-f]{64}$/u.test(value), `Real S3 observation hash is invalid: ${name}`);
  }
  assert(
    report.observations.listedDataObjects === 2,
    "Real S3 report must observe exactly two data objects",
  );
  return report;
}

export async function createRealS3EvidenceManifest(
  awsPath: string,
  r2Path: string,
): Promise<RealS3EvidenceManifest> {
  const aws = validateRealS3ProbeReport(
    await readJson<RealS3ProbeReport>(awsPath),
    "aws-s3",
  );
  const r2 = validateRealS3ProbeReport(
    await readJson<RealS3ProbeReport>(r2Path),
    "cloudflare-r2",
  );
  assertPairedReports(aws, r2);
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    runnerId: aws.runner.id,
    sourceCommit: aws.git.commit,
    reports: {
      awsS3: { file: "aws-s3.json", sha256: await sha256File(awsPath) },
      cloudflareR2: { file: "cloudflare-r2.json", sha256: await sha256File(r2Path) },
    },
  };
}

export async function validateRealS3EvidenceDirectory(
  path: string,
): Promise<RealS3EvidenceSummary> {
  const manifest = await readJson<RealS3EvidenceManifest>(join(path, "evidence.json"));
  assert(manifest.schemaVersion === 1, "Real S3 evidence manifest version is invalid");
  assert(validTimestamp(manifest.recordedAt), "Real S3 evidence timestamp is invalid");
  assert(
    /^[A-Za-z0-9._-]{1,64}$/u.test(manifest.runnerId),
    "Real S3 evidence runner id is invalid",
  );
  assert(/^[0-9a-f]{40}$/u.test(manifest.sourceCommit), "Real S3 evidence commit is invalid");
  assert(
    manifest.reports.awsS3.file === "aws-s3.json" &&
      manifest.reports.cloudflareR2.file === "cloudflare-r2.json",
    "Real S3 evidence filenames are invalid",
  );
  const awsPath = join(path, manifest.reports.awsS3.file);
  const r2Path = join(path, manifest.reports.cloudflareR2.file);
  assert(
    await sha256File(awsPath) === manifest.reports.awsS3.sha256,
    "AWS S3 evidence checksum does not match",
  );
  assert(
    await sha256File(r2Path) === manifest.reports.cloudflareR2.sha256,
    "Cloudflare R2 evidence checksum does not match",
  );
  const awsS3 = validateRealS3ProbeReport(
    await readJson<RealS3ProbeReport>(awsPath),
    "aws-s3",
  );
  const cloudflareR2 = validateRealS3ProbeReport(
    await readJson<RealS3ProbeReport>(r2Path),
    "cloudflare-r2",
  );
  assertPairedReports(awsS3, cloudflareR2);
  assert(awsS3.runner.id === manifest.runnerId, "AWS S3 runner does not match manifest");
  assert(
    cloudflareR2.runner.id === manifest.runnerId,
    "Cloudflare R2 runner does not match manifest",
  );
  assert(awsS3.git.commit === manifest.sourceCommit, "AWS S3 commit does not match manifest");
  assert(
    cloudflareR2.git.commit === manifest.sourceCommit,
    "Cloudflare R2 commit does not match manifest",
  );
  return { runnerId: manifest.runnerId, sourceCommit: manifest.sourceCommit, awsS3, cloudflareR2 };
}

function assertPairedReports(aws: RealS3ProbeReport, r2: RealS3ProbeReport): void {
  assert(aws.runner.id === r2.runner.id, "Real S3 reports used different runners");
  assert(aws.git.commit === r2.git.commit, "Real S3 reports used different source commits");
  assert(
    aws.toolchain.deno === r2.toolchain.deno && aws.toolchain.v8 === r2.toolchain.v8 &&
      aws.toolchain.typescript === r2.toolchain.typescript,
    "Real S3 reports used different toolchains",
  );
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    throw new Error(`Invalid real S3 evidence JSON at ${path}: ${errorMessage(error)}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return await sha256Bytes(await Deno.readFile(path));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

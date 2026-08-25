import { join } from "@std/path";
import {
  SOAK_MINIMUM_DURATION_MS,
  type SoakReport,
  type SoakValidationSummary,
  validateSoakReport,
} from "./soak_report.ts";

export interface SoakEvidenceManifest {
  schemaVersion: 1;
  recordedAt: string;
  runnerId: string;
  hardwareFingerprint: string;
  sourceCommit: string;
  minimumDurationMs: number;
  reports: {
    pglite: { file: "pglite.json"; sha256: string };
    postgres: { file: "postgres.json"; sha256: string };
  };
}

export interface SoakEvidenceSummary {
  runnerId: string;
  hardwareFingerprint: string;
  sourceCommit: string;
  pglite: SoakValidationSummary;
  postgres: SoakValidationSummary;
}

export async function validateSoakEvidenceDirectory(path: string): Promise<SoakEvidenceSummary> {
  const manifest = await readJson<SoakEvidenceManifest>(join(path, "evidence.json"));
  assert(manifest.schemaVersion === 1, "Soak evidence manifest version is invalid");
  assert(/^[A-Za-z0-9._-]{1,64}$/u.test(manifest.runnerId), "Soak evidence runner id is invalid");
  assert(
    /^[0-9a-f]{64}$/u.test(manifest.hardwareFingerprint),
    "Soak evidence hardware fingerprint is invalid",
  );
  assert(/^[0-9a-f]{40}$/u.test(manifest.sourceCommit), "Soak evidence commit is invalid");
  assert(
    manifest.minimumDurationMs === SOAK_MINIMUM_DURATION_MS,
    "Soak evidence minimum duration is invalid",
  );
  assert(
    manifest.reports.pglite.file === "pglite.json" &&
      manifest.reports.postgres.file === "postgres.json",
    "Soak evidence report filenames are invalid",
  );

  const pglitePath = join(path, manifest.reports.pglite.file);
  const postgresPath = join(path, manifest.reports.postgres.file);
  assert(
    await sha256File(pglitePath) === manifest.reports.pglite.sha256,
    "PGlite soak evidence checksum does not match",
  );
  assert(
    await sha256File(postgresPath) === manifest.reports.postgres.sha256,
    "PostgreSQL soak evidence checksum does not match",
  );
  const pgliteReport = await readJson<SoakReport>(pglitePath);
  const postgresReport = await readJson<SoakReport>(postgresPath);
  const pglite = validateSoakReport(pgliteReport, "pglite");
  const postgres = validateSoakReport(postgresReport, "postgres");
  for (const report of [pgliteReport, postgresReport]) {
    assert(report.runner.id === manifest.runnerId, "Soak report runner does not match manifest");
    assert(
      report.runner.hardwareFingerprint === manifest.hardwareFingerprint,
      "Soak report hardware does not match manifest",
    );
    assert(
      report.git.commit === manifest.sourceCommit,
      "Soak report commit does not match manifest",
    );
  }
  assert(
    pgliteReport.toolchain.deno === postgresReport.toolchain.deno &&
      pgliteReport.toolchain.v8 === postgresReport.toolchain.v8 &&
      pgliteReport.toolchain.typescript === postgresReport.toolchain.typescript,
    "Paired soak reports used different toolchains",
  );
  return {
    runnerId: manifest.runnerId,
    hardwareFingerprint: manifest.hardwareFingerprint,
    sourceCommit: manifest.sourceCommit,
    pglite,
    postgres,
  };
}

export async function createSoakEvidenceManifest(
  pglitePath: string,
  postgresPath: string,
): Promise<SoakEvidenceManifest> {
  const pglite = await readJson<SoakReport>(pglitePath);
  const postgres = await readJson<SoakReport>(postgresPath);
  validateSoakReport(pglite, "pglite");
  validateSoakReport(postgres, "postgres");
  assert(pglite.runner.id === postgres.runner.id, "Paired soak runners do not match");
  assert(
    pglite.runner.hardwareFingerprint === postgres.runner.hardwareFingerprint,
    "Paired soak hardware fingerprints do not match",
  );
  assert(pglite.git.commit === postgres.git.commit, "Paired soak source commits do not match");
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    runnerId: pglite.runner.id!,
    hardwareFingerprint: pglite.runner.hardwareFingerprint,
    sourceCommit: pglite.git.commit,
    minimumDurationMs: SOAK_MINIMUM_DURATION_MS,
    reports: {
      pglite: { file: "pglite.json", sha256: await sha256File(pglitePath) },
      postgres: { file: "postgres.json", sha256: await sha256File(postgresPath) },
    },
  };
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    throw new Error(`Invalid soak evidence JSON at ${path}: ${errorMessage(error)}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

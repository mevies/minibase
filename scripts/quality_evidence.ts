import { isAbsolute, join, relative } from "@std/path";

interface SupportingSource {
  file: string;
  markers: string[];
}

interface QualityEvidenceEntry {
  id: string;
  kind: "test" | "task";
  file: string;
  name?: string;
  task?: string;
  requiredInCheck?: boolean;
  markers: string[];
  supporting?: SupportingSource[];
  targets: string[];
}

interface QualityEvidence {
  formatVersion: number;
  entries: QualityEvidenceEntry[];
}

export const EXPECTED_QUALITY_CLAIMS = [
  "backup.cross-engine",
  "backup.logical-cli",
  "backup.s3-streaming",
  "performance.dual-engine-soak",
  "performance.fixed-benchmark",
  "performance.supabase-docker-comparison",
  "recovery.capacity-failure",
  "recovery.corrupt-database-readonly",
  "recovery.managed-postgres-s3-reset",
  "recovery.migration-crash",
  "recovery.s3-reset",
  "recovery.storage-crash",
  "security.auth-password-and-reauthentication",
  "security.auth-rate-limits",
  "security.functions-network-policy",
  "security.request-limits-and-timeouts",
  "security.secret-file-permissions",
  "security.secret-redaction",
  "upgrade.external-postgres-readonly",
  "upgrade.managed-postgres",
  "upgrade.pglite-rollback",
  "upgrade.s3-rollback",
] as const;

export async function validateQualityEvidence(
  root: string,
  evidenceValue: unknown,
): Promise<{ claims: number; entries: number; files: number }> {
  if (!isAbsolute(root)) throw new Error("Quality evidence root must be absolute");
  const evidence = parseQualityEvidence(evidenceValue);
  const expected = new Set<string>(EXPECTED_QUALITY_CLAIMS);
  const covered = new Set<string>();
  const files = new Set<string>();
  const denoConfig = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as {
    tasks?: Record<string, string>;
  };
  const tasks = denoConfig.tasks ?? {};
  const defaultTest = tasks.test ?? "";
  const defaultCheck = tasks.check ?? "";
  if (!defaultTest.includes("deno test -A")) {
    throw new Error("Quality evidence requires the default full Deno test task");
  }
  if (!defaultCheck.includes("deno task quality:evidence:check")) {
    throw new Error("Quality evidence is not part of the default check task");
  }

  for (const entry of evidence.entries) {
    for (const target of entry.targets) {
      if (!expected.has(target)) {
        throw new Error(`Quality evidence ${entry.id} references unknown claim ${target}`);
      }
      covered.add(target);
    }
    const source = await readEvidenceSource(root, entry.file, files);
    if (entry.kind === "test") {
      if (entry.name === undefined || !source.includes(entry.name)) {
        throw new Error(`Quality evidence ${entry.id} cannot find test ${entry.name ?? ""}`);
      }
    } else {
      const command = entry.task === undefined ? undefined : tasks[entry.task];
      if (command === undefined) {
        throw new Error(`Quality evidence ${entry.id} references missing task ${entry.task ?? ""}`);
      }
      if (!command.replaceAll("\\", "/").includes(entry.file)) {
        throw new Error(`Quality evidence task ${entry.task} does not execute ${entry.file}`);
      }
      if (entry.requiredInCheck && !defaultCheck.includes(`deno task ${entry.task}`)) {
        throw new Error(`Quality evidence task ${entry.task} is not part of the default check`);
      }
    }
    assertMarkers(entry.id, entry.file, source, entry.markers);
    for (const supporting of entry.supporting ?? []) {
      const supportingSource = await readEvidenceSource(root, supporting.file, files);
      assertMarkers(entry.id, supporting.file, supportingSource, supporting.markers);
    }
  }

  const missing = [...expected].filter((claim) => !covered.has(claim)).sort();
  if (missing.length > 0) {
    throw new Error(`Quality claims lack automated evidence: ${missing.join(", ")}`);
  }
  return { claims: expected.size, entries: evidence.entries.length, files: files.size };
}

function parseQualityEvidence(value: unknown): QualityEvidence {
  if (typeof value !== "object" || value === null) {
    throw new Error("Quality evidence must be an object");
  }
  const evidence = value as Partial<QualityEvidence>;
  if (evidence.formatVersion !== 1 || !Array.isArray(evidence.entries)) {
    throw new Error("Quality evidence format is invalid");
  }
  const ids = new Set<string>();
  for (const raw of evidence.entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Quality evidence entry is invalid");
    }
    const entry = raw as Partial<QualityEvidenceEntry>;
    if (
      typeof entry.id !== "string" || !/^[a-z0-9-]+$/u.test(entry.id) || ids.has(entry.id) ||
      (entry.kind !== "test" && entry.kind !== "task") ||
      typeof entry.file !== "string" || !safeRelativePath(entry.file) ||
      !Array.isArray(entry.markers) || entry.markers.length === 0 ||
      entry.markers.some((marker) => typeof marker !== "string" || marker.length === 0) ||
      !Array.isArray(entry.targets) || entry.targets.length === 0 ||
      entry.targets.some((target) => typeof target !== "string" || target.length === 0) ||
      (entry.kind === "test" && (typeof entry.name !== "string" || entry.name.length === 0)) ||
      (entry.kind === "task" && (typeof entry.task !== "string" || entry.task.length === 0)) ||
      (entry.requiredInCheck !== undefined && typeof entry.requiredInCheck !== "boolean")
    ) {
      throw new Error("Quality evidence entry is invalid");
    }
    ids.add(entry.id);
    for (const supporting of entry.supporting ?? []) {
      if (
        typeof supporting !== "object" || supporting === null ||
        typeof supporting.file !== "string" || !safeRelativePath(supporting.file) ||
        !Array.isArray(supporting.markers) || supporting.markers.length === 0 ||
        supporting.markers.some((marker) => typeof marker !== "string" || marker.length === 0)
      ) {
        throw new Error(`Quality evidence ${entry.id} has invalid supporting source`);
      }
    }
  }
  return evidence as QualityEvidence;
}

async function readEvidenceSource(root: string, relativePath: string, files: Set<string>) {
  const path = join(root, ...relativePath.split("/"));
  const fromRoot = relative(root, path).replaceAll("\\", "/");
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error(`Quality evidence path escaped the repository: ${relativePath}`);
  }
  files.add(relativePath);
  return await Deno.readTextFile(path);
}

function assertMarkers(id: string, file: string, source: string, markers: string[]): void {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`Quality evidence ${id} cannot find marker in ${file}: ${marker}`);
    }
  }
}

function safeRelativePath(path: string): boolean {
  return /^[0-9A-Za-z._/-]+$/u.test(path) && !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

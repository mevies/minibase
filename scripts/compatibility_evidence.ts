import { isAbsolute, join, relative } from "@std/path";

interface CompatibilityContract {
  verifiedWith: {
    supabaseServer: {
      engines: string[];
      supported: string[];
      unsupported: string[];
    };
  };
  engines: Record<
    string,
    {
      supported: string[];
      unsupported: Array<{ capability: string }>;
    }
  >;
  modules: Array<{
    id: string;
    embedded: string;
    server: string;
  }>;
}

interface SupportingSource {
  file: string;
  markers: string[];
}

interface EvidenceEntry {
  id: string;
  kind: "test" | "task";
  file: string;
  name?: string;
  task?: string;
  markers: string[];
  supporting?: SupportingSource[];
  targets: string[];
}

interface CompatibilityEvidence {
  formatVersion: number;
  entries: EvidenceEntry[];
}

export async function validateCompatibilityEvidence(
  root: string,
  compatibilityValue: unknown,
  evidenceValue: unknown,
): Promise<{ claims: number; entries: number; files: number }> {
  if (!isAbsolute(root)) throw new Error("Compatibility evidence root must be absolute");
  const compatibility = compatibilityContract(compatibilityValue);
  const evidence = compatibilityEvidence(evidenceValue);
  const expected = expectedTargets(compatibility);
  const covered = new Set<string>();
  const files = new Set<string>();
  const denoConfig = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as {
    tasks?: Record<string, string>;
  };

  for (const entry of evidence.entries) {
    for (const target of entry.targets) {
      if (!expected.has(target)) {
        throw new Error(`Compatibility evidence ${entry.id} references unknown claim ${target}`);
      }
      covered.add(target);
    }
    const source = await readEvidenceSource(root, entry.file, files);
    if (entry.kind === "test") {
      if (entry.name === undefined || !source.includes(entry.name)) {
        throw new Error(`Compatibility evidence ${entry.id} cannot find test ${entry.name ?? ""}`);
      }
    } else {
      const command = entry.task === undefined ? undefined : denoConfig.tasks?.[entry.task];
      if (command === undefined) {
        throw new Error(
          `Compatibility evidence ${entry.id} references missing task ${entry.task ?? ""}`,
        );
      }
      if (!command.replaceAll("\\", "/").includes(entry.file)) {
        throw new Error(`Compatibility task ${entry.task} does not execute ${entry.file}`);
      }
    }
    assertMarkers(entry.id, entry.file, source, entry.markers);
    for (const supporting of entry.supporting ?? []) {
      const supportingSource = await readEvidenceSource(root, supporting.file, files);
      assertMarkers(entry.id, supporting.file, supportingSource, supporting.markers);
    }
  }

  const missing = [...expected].filter((target) => !covered.has(target)).sort();
  if (missing.length > 0) {
    throw new Error(`Compatibility claims lack automated evidence: ${missing.join(", ")}`);
  }
  return { claims: expected.size, entries: evidence.entries.length, files: files.size };
}

function compatibilityContract(value: unknown): CompatibilityContract {
  if (typeof value !== "object" || value === null) {
    throw new Error("Compatibility contract must be an object");
  }
  return value as CompatibilityContract;
}

function compatibilityEvidence(value: unknown): CompatibilityEvidence {
  if (typeof value !== "object" || value === null) {
    throw new Error("Compatibility evidence must be an object");
  }
  const evidence = value as Partial<CompatibilityEvidence>;
  if (evidence.formatVersion !== 1 || !Array.isArray(evidence.entries)) {
    throw new Error("Compatibility evidence format is invalid");
  }
  const ids = new Set<string>();
  for (const raw of evidence.entries) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Compatibility evidence entry is invalid");
    }
    const entry = raw as Partial<EvidenceEntry>;
    if (
      typeof entry.id !== "string" || !/^[a-z0-9-]+$/u.test(entry.id) ||
      ids.has(entry.id) || (entry.kind !== "test" && entry.kind !== "task") ||
      typeof entry.file !== "string" || !safeRelativePath(entry.file) ||
      !Array.isArray(entry.markers) || entry.markers.length === 0 ||
      entry.markers.some((marker) => typeof marker !== "string" || marker.length === 0) ||
      !Array.isArray(entry.targets) || entry.targets.length === 0 ||
      entry.targets.some((target) => typeof target !== "string" || target.length === 0) ||
      (entry.kind === "test" && (typeof entry.name !== "string" || entry.name.length === 0)) ||
      (entry.kind === "task" && (typeof entry.task !== "string" || entry.task.length === 0))
    ) {
      throw new Error("Compatibility evidence entry is invalid");
    }
    ids.add(entry.id);
    for (const supporting of entry.supporting ?? []) {
      if (
        typeof supporting !== "object" || supporting === null ||
        typeof supporting.file !== "string" || !safeRelativePath(supporting.file) ||
        !Array.isArray(supporting.markers) || supporting.markers.length === 0 ||
        supporting.markers.some((marker) => typeof marker !== "string" || marker.length === 0)
      ) {
        throw new Error(`Compatibility evidence ${entry.id} has invalid supporting source`);
      }
    }
  }
  return evidence as CompatibilityEvidence;
}

function expectedTargets(compatibility: CompatibilityContract): Set<string> {
  const expected = new Set<string>();
  for (const [engine, contract] of Object.entries(compatibility.engines)) {
    for (const capability of contract.supported) {
      expected.add(`engine.${engine}.supported.${capability}`);
    }
    for (const unsupported of contract.unsupported) {
      expected.add(`engine.${engine}.unsupported.${unsupported.capability}`);
    }
  }
  for (const engine of compatibility.verifiedWith.supabaseServer.engines) {
    for (const capability of compatibility.verifiedWith.supabaseServer.supported) {
      expected.add(`supabaseServer.${engine}.supported.${capability}`);
    }
    for (const capability of compatibility.verifiedWith.supabaseServer.unsupported) {
      expected.add(`supabaseServer.${engine}.unsupported.${capability}`);
    }
  }
  for (const module of compatibility.modules) {
    expected.add(`module.${module.id}.embedded.${module.embedded}`);
    expected.add(`module.${module.id}.server.${module.server}`);
  }
  return expected;
}

async function readEvidenceSource(root: string, relativePath: string, files: Set<string>) {
  const path = join(root, ...relativePath.split("/"));
  const fromRoot = relative(root, path).replaceAll("\\", "/");
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error(`Compatibility evidence path escaped the repository: ${relativePath}`);
  }
  files.add(relativePath);
  return await Deno.readTextFile(path);
}

function assertMarkers(id: string, file: string, source: string, markers: string[]): void {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`Compatibility evidence ${id} cannot find marker in ${file}: ${marker}`);
    }
  }
}

function safeRelativePath(path: string): boolean {
  return /^[0-9A-Za-z._/-]+$/u.test(path) && !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

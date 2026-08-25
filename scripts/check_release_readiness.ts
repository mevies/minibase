import { fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import { MINIBASE_VERSION } from "../src/version.ts";

export interface ReleaseReadinessInput {
  version: string;
  denoConfigVersion: string;
  tag: string;
  gitCommit: string;
  gitDirty: boolean;
  tagsAtHead: string[];
  repositoryVisibility: RepositoryVisibility;
  licenseText: string | null;
}

export type RepositoryVisibility = "private" | "public" | "internal";

export interface ReleaseReadinessSummary {
  ok: true;
  version: string;
  tag: string;
  commit: string;
  repositoryVisibility: RepositoryVisibility;
  projectLicense: "included" | "deferred-private";
  licenseSha256: string | null;
}

export function assertReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadinessSummary {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(input.version)) {
    throw new Error("Minibase release version must be a stable semantic version");
  }
  if (input.version === "0.0.0") {
    throw new Error("Minibase release version must not be the development placeholder");
  }
  if (input.denoConfigVersion !== input.version) {
    throw new Error("deno.json version must match the Minibase runtime version");
  }
  if (input.tag !== `v${input.version}`) {
    throw new Error("Release tag must exactly match the Minibase version");
  }
  if (!/^[0-9a-f]{40}$/u.test(input.gitCommit)) {
    throw new Error("Release commit must be a full Git SHA-1");
  }
  if (input.gitDirty) throw new Error("Release checkout must be clean");
  if (!input.tagsAtHead.includes(input.tag)) {
    throw new Error("Release tag must point at the checked-out commit");
  }
  if (input.licenseText === null && input.repositoryVisibility !== "private") {
    throw new Error(
      "Project LICENSE is required for public or internal releases; only private repositories may defer it",
    );
  }
  if (
    input.licenseText !== null &&
    (input.licenseText.trim().length < 100 ||
      /(?:choose a license|placeholder|\btodo\b)/iu.test(input.licenseText))
  ) {
    throw new Error("Project LICENSE must contain the final non-placeholder license text");
  }

  return {
    ok: true,
    version: input.version,
    tag: input.tag,
    commit: input.gitCommit,
    repositoryVisibility: input.repositoryVisibility,
    projectLicense: input.licenseText === null ? "deferred-private" : "included",
    licenseSha256: input.licenseText === null
      ? null
      : createHash("sha256").update(input.licenseText).digest("hex"),
  };
}

if (import.meta.main) {
  try {
    const root = fromFileUrl(new URL("../", import.meta.url));
    const { tag, repositoryVisibility } = parseReleaseArguments(Deno.args);
    const gitCommit = await git(root, ["rev-parse", "HEAD"]);
    const gitDirty = (await git(root, ["status", "--porcelain"])).length > 0;
    const tagsAtHead = splitLines(await git(root, ["tag", "--points-at", "HEAD"]));
    const denoConfig = JSON.parse(await Deno.readTextFile(join(root, "deno.json"))) as {
      version?: string;
    };
    const licenseText = await readProjectLicense(root, repositoryVisibility);
    console.log(JSON.stringify(assertReleaseReadiness({
      version: MINIBASE_VERSION,
      denoConfigVersion: denoConfig.version ?? "",
      tag,
      gitCommit,
      gitDirty,
      tagsAtHead,
      repositoryVisibility,
      licenseText,
    })));
  } catch (error) {
    console.error(releaseReadinessErrorMessage(error));
    Deno.exit(1);
  }
}

export function releaseReadinessErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Release readiness check failed";
}

export async function readProjectLicense(
  root: string,
  repositoryVisibility: RepositoryVisibility,
): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(root, "LICENSE"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      if (repositoryVisibility === "private") return null;
      throw new Error(
        "Project LICENSE is required for public or internal releases; only private repositories may defer it",
        { cause: error },
      );
    }
    throw error;
  }
}

export function parseReleaseArguments(
  args: string[],
): { tag: string; repositoryVisibility: RepositoryVisibility } {
  if (
    args.length !== 4 || args[0] !== "--tag" || args[1] === undefined ||
    args[2] !== "--repository-visibility" || args[3] === undefined
  ) {
    throw new Error(
      "Usage: check_release_readiness.ts --tag v<version> --repository-visibility private|public|internal",
    );
  }
  if (!isRepositoryVisibility(args[3])) {
    throw new Error("Repository visibility must be private, public or internal");
  }
  return { tag: args[1], repositoryVisibility: args[3] };
}

function isRepositoryVisibility(value: string): value is RepositoryVisibility {
  return value === "private" || value === "public" || value === "internal";
}

async function git(root: string, args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    cwd: root,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/u).filter((line) => line.length > 0);
}

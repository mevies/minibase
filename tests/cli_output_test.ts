import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { formatCliHuman, formatCliOutput } from "../src/cli/output.ts";

Deno.test("CLI human output is deterministic, nested and distinct from JSON", () => {
  const value = {
    z: 2,
    a: [
      { beta: "true", alpha: "first" },
      "plain",
    ],
    empty: {},
    omitted: undefined,
  };
  assertEquals(
    formatCliHuman(value),
    'a:\n  -\n    alpha: first\n    beta: "true"\n  - plain\nempty: {}\nz: 2',
  );
  const json = formatCliOutput(value, true);
  assertEquals(json.includes("\n"), false);
  assertEquals(JSON.parse(json), {
    z: 2,
    a: [{ beta: "true", alpha: "first" }, "plain"],
    empty: {},
  });
});

Deno.test("CLI human output escapes terminal controls, ambiguous scalars and unsafe keys", () => {
  const output = formatCliHuman({
    "unsafe\nkey": "line\nvalue",
    ansi: "safe\u001b[31mred",
    bidi: "left\u202eright",
    numeric: "123",
    padded: " value ",
  });
  assertEquals(output.includes("\u001b"), false);
  assertEquals(output.includes("\\u001b"), true);
  assertEquals(output.includes("\\u{202e}"), true);
  assertEquals(output.includes("line\nvalue"), false);
  assertStringIncludes(output, '"unsafe\\nkey": "line\\nvalue"');
  assertStringIncludes(output, 'numeric: "123"');
  assertStringIncludes(output, 'padded: " value "');
});

Deno.test("real CLI version, prepare and status expose stable human and single-line JSON modes", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-cli-output-test-" });
  try {
    await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
    const version = await runCliProcess(["version"]);
    assertEquals(version.code, 0, version.stderr);
    assertEquals(version.stdout, "version: 1.0.0");

    const prepared = await runCliProcess(["prepare", "--project", root]);
    assertEquals(prepared.code, 0, prepared.stderr);
    assertStringIncludes(prepared.stdout, "ok: true");
    assertStringIncludes(prepared.stdout, `projectRoot: ${root}`);
    assertStringIncludes(prepared.stdout, "state:\n  components:\n    minibaseCore: 1.0.0");
    assertStringIncludes(prepared.stdout, "  createdAt:");
    assertStringIncludes(prepared.stdout, "  formatVersion: 2");
    assertEquals(prepared.stdout.trimStart().startsWith("{"), false);

    const status = await runCliProcess(["status", "--project", root]);
    assertEquals(status.code, 0, status.stderr);
    assertStringIncludes(status.stdout, "runtime: null");
    assertStringIncludes(status.stdout, "state:\n  components:");
    assertStringIncludes(status.stdout, "  createdAt:");

    const json = await runCliProcess(["status", "--project", root, "--json"]);
    assertEquals(json.code, 0, json.stderr);
    assertEquals(json.stdout.split(/\r?\n/u).length, 1);
    const parsed = JSON.parse(json.stdout) as { projectRoot: string; runtime: null };
    assertEquals(parsed.projectRoot, root);
    assertEquals(parsed.runtime, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function runCliProcess(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "main.ts"), ...args],
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

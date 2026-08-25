import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

const smoke = await Deno.readTextFile(
  fromFileUrl(new URL("../scripts/smoke_release.ts", import.meta.url)),
);

Deno.test("release smoke isolates host configuration and reaps failed children", () => {
  assertEquals(smoke.match(/clearEnv: true/gu)?.length, 2);
  assertStringIncludes(smoke, 'name.toUpperCase().startsWith("MINIBASE_")');
  assertStringIncludes(smoke, "env: options.env ?? artifactEnvironment({})");
  assertStringIncludes(smoke, "new Set([project, secondProject])");
  assertStringIncludes(smoke, "await stopArtifact(candidate, childEnvironment)");
  assertStringIncludes(smoke, "await withTimeout(child.status, 15_000");

  const gracefulStop = smoke.indexOf("new Set([project, secondProject])");
  const forcedStop = smoke.indexOf('child.kill("SIGKILL")');
  const cleanup = smoke.indexOf("await removeTreeWithRetries(temp)");
  assert(gracefulStop >= 0 && gracefulStop < forcedStop && forcedStop < cleanup);
});

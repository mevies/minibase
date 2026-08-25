import { runCli } from "./cli/run.ts";

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}

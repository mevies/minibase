import { prepareMacosPostgresSource } from "./postgres_macos_source.ts";
import { currentReleasePlatform } from "../src/release/platform.ts";

const source = await prepareMacosPostgresSource();
console.log(JSON.stringify({
  ok: true,
  platform: currentReleasePlatform().name,
  runtimeDir: source.runtimeDir,
  packages: source.packages,
}));

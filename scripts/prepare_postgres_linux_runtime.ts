import { prepareLinuxPostgresSource } from "./postgres_linux_source.ts";

const source = await prepareLinuxPostgresSource();
console.log(JSON.stringify({
  ok: true,
  platform: "linux-x64",
  runtimeDir: source.runtimeDir,
  packageRoot: source.packageRoot,
  packages: source.packages.map(({ name, version, bytes, sha256 }) => ({
    name,
    version,
    bytes,
    sha256,
  })),
}));

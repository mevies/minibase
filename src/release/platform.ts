import toolchain from "../../toolchain.json" with { type: "json" };

export type ReleasePlatform =
  | "windows-x64"
  | "linux-x64"
  | "macos-x64"
  | "macos-arm64";

export interface ReleasePlatformDescriptor {
  name: ReleasePlatform;
  os: "windows" | "linux" | "darwin";
  arch: "x86_64" | "aarch64";
  target:
    | "x86_64-pc-windows-msvc"
    | "x86_64-unknown-linux-gnu"
    | "x86_64-apple-darwin"
    | "aarch64-apple-darwin";
  artifactSuffix: ".exe" | "";
  denoExecutableName: "deno.exe" | "deno";
}

const RELEASE_PLATFORMS: Record<ReleasePlatform, ReleasePlatformDescriptor> = {
  "windows-x64": {
    name: "windows-x64",
    os: "windows",
    arch: "x86_64",
    target: "x86_64-pc-windows-msvc",
    artifactSuffix: ".exe",
    denoExecutableName: "deno.exe",
  },
  "linux-x64": {
    name: "linux-x64",
    os: "linux",
    arch: "x86_64",
    target: "x86_64-unknown-linux-gnu",
    artifactSuffix: "",
    denoExecutableName: "deno",
  },
  "macos-x64": {
    name: "macos-x64",
    os: "darwin",
    arch: "x86_64",
    target: "x86_64-apple-darwin",
    artifactSuffix: "",
    denoExecutableName: "deno",
  },
  "macos-arm64": {
    name: "macos-arm64",
    os: "darwin",
    arch: "aarch64",
    target: "aarch64-apple-darwin",
    artifactSuffix: "",
    denoExecutableName: "deno",
  },
};

export function releasePlatform(value: string): ReleasePlatformDescriptor {
  if (Object.hasOwn(RELEASE_PLATFORMS, value)) {
    return RELEASE_PLATFORMS[value as ReleasePlatform];
  }
  throw new Error(`Unsupported release platform: ${value}`);
}

export function currentReleasePlatform(): ReleasePlatformDescriptor {
  for (const descriptor of Object.values(RELEASE_PLATFORMS)) {
    if (descriptor.os === Deno.build.os && descriptor.arch === Deno.build.arch) {
      return descriptor;
    }
  }
  throw new Error(`Unsupported release host: ${Deno.build.os}/${Deno.build.arch}`);
}

export function releasePlatformLabel(platform: ReleasePlatformDescriptor): string {
  switch (platform.name) {
    case "windows-x64":
      return "Windows x64";
    case "linux-x64":
      return "Linux x64";
    case "macos-x64":
      return "macOS x64";
    case "macos-arm64":
      return "macOS arm64";
  }
}

export function denoRuntimeAssetName(
  version: string,
  platform: ReleasePlatformDescriptor,
): string {
  return `deno-${version}-${platform.name}${platform.artifactSuffix}.gz`;
}

export function functionWorkerAssetName(platform: ReleasePlatformDescriptor): string {
  return `function-worker-${platform.name}.js`;
}

export function denoExecutableSha256(platform: ReleasePlatformDescriptor): string {
  switch (platform.name) {
    case "windows-x64":
      return toolchain.runtimes.deno.windowsX64ExecutableSha256;
    case "linux-x64":
      return toolchain.runtimes.deno.linuxX64ExecutableSha256;
    case "macos-x64":
      return toolchain.runtimes.deno.macosX64ExecutableSha256;
    case "macos-arm64":
      return toolchain.runtimes.deno.macosArm64ExecutableSha256;
  }
}

export function runtimeCachePath(
  version: string,
  platform: ReleasePlatformDescriptor,
): string {
  if (platform.os === "windows") {
    return `%LOCALAPPDATA%\\minibase\\runtimes\\deno\\${version}\\${platform.denoExecutableName}`;
  }
  return `$XDG_CACHE_HOME/minibase/runtimes/deno/${version}/${platform.denoExecutableName}`;
}

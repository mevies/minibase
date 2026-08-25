import { assertEquals, assertThrows } from "@std/assert";
import {
  currentReleasePlatform,
  denoExecutableSha256,
  denoRuntimeAssetName,
  functionWorkerAssetName,
  releasePlatform,
  releasePlatformLabel,
  runtimeCachePath,
} from "../src/release/platform.ts";

Deno.test("release platform descriptors preserve artifact and Runtime paths", () => {
  const windows = releasePlatform("windows-x64");
  assertEquals(windows, {
    name: "windows-x64",
    os: "windows",
    arch: "x86_64",
    target: "x86_64-pc-windows-msvc",
    artifactSuffix: ".exe",
    denoExecutableName: "deno.exe",
  });
  assertEquals(releasePlatformLabel(windows), "Windows x64");
  assertEquals(denoRuntimeAssetName("2.9.2", windows), "deno-2.9.2-windows-x64.exe.gz");
  assertEquals(functionWorkerAssetName(windows), "function-worker-windows-x64.js");
  assertEquals(
    runtimeCachePath("2.9.2", windows),
    "%LOCALAPPDATA%\\minibase\\runtimes\\deno\\2.9.2\\deno.exe",
  );

  const linux = releasePlatform("linux-x64");
  assertEquals(linux, {
    name: "linux-x64",
    os: "linux",
    arch: "x86_64",
    target: "x86_64-unknown-linux-gnu",
    artifactSuffix: "",
    denoExecutableName: "deno",
  });
  assertEquals(releasePlatformLabel(linux), "Linux x64");
  assertEquals(denoRuntimeAssetName("2.9.2", linux), "deno-2.9.2-linux-x64.gz");
  assertEquals(functionWorkerAssetName(linux), "function-worker-linux-x64.js");
  assertEquals(
    runtimeCachePath("2.9.2", linux),
    "$XDG_CACHE_HOME/minibase/runtimes/deno/2.9.2/deno",
  );

  const macosX64 = releasePlatform("macos-x64");
  assertEquals(macosX64, {
    name: "macos-x64",
    os: "darwin",
    arch: "x86_64",
    target: "x86_64-apple-darwin",
    artifactSuffix: "",
    denoExecutableName: "deno",
  });
  assertEquals(releasePlatformLabel(macosX64), "macOS x64");
  assertEquals(denoRuntimeAssetName("2.9.2", macosX64), "deno-2.9.2-macos-x64.gz");
  assertEquals(
    denoExecutableSha256(macosX64),
    "201651c6e72bd0df2dbe994b4f8ca0f935631e08c27290a3a92342e02ad0e865",
  );

  const macosArm64 = releasePlatform("macos-arm64");
  assertEquals(macosArm64, {
    name: "macos-arm64",
    os: "darwin",
    arch: "aarch64",
    target: "aarch64-apple-darwin",
    artifactSuffix: "",
    denoExecutableName: "deno",
  });
  assertEquals(releasePlatformLabel(macosArm64), "macOS arm64");
  assertEquals(denoRuntimeAssetName("2.9.2", macosArm64), "deno-2.9.2-macos-arm64.gz");
  assertEquals(
    denoExecutableSha256(macosArm64),
    "218ab752ae8f64f0a7822af710886488f15169fdae153a3aada4861f9635b266",
  );

  const currentName = Deno.build.os === "darwin"
    ? `macos-${Deno.build.arch === "aarch64" ? "arm64" : "x64"}`
    : `${Deno.build.os}-x64`;
  assertEquals(currentReleasePlatform(), releasePlatform(currentName));
  assertThrows(() => releasePlatform("macos-universal"), Error, "Unsupported release platform");
});

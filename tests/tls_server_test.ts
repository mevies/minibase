import { assert, assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { discoverProject } from "../src/project/discover.ts";
import { readRuntimeState } from "../src/project/runtime.ts";

Deno.test("configured TLS serves health, Functions and control endpoints over HTTPS", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-tls-server-test-" });
  await copyTree(join(Deno.cwd(), "fixtures", "supabase-basic"), root);
  await Deno.writeTextFile(join(root, "tls-cert.pem"), TEST_CERTIFICATE);
  await Deno.writeTextFile(join(root, "tls-key.pem"), TEST_PRIVATE_KEY);
  await Deno.writeTextFile(
    join(root, "minibase.toml"),
    `format_version = 1
[server.tls]
cert_file = "tls-cert.pem"
key_file = "tls-key.pem"
[functions.echo]
verify_jwt = false
`,
  );
  const port = availablePort();
  const project = await discoverProject(root);
  const child = startServer(root, port);
  const client = Deno.createHttpClient({ caCerts: [TEST_CERTIFICATE] });
  try {
    await waitForRuntime(project.runtimeFile);
    const runtime = await readRuntimeState(project);
    assert(runtime);
    assertEquals(runtime.apiUrl, `https://127.0.0.1:${port}`);
    assertEquals(runtime.controlUrl, `https://127.0.0.1:${port}`);

    const health = await fetch(`${runtime.apiUrl}/health/live`, { client });
    assertEquals(health.status, 200);
    assertEquals((await health.json()).status, "live");
    const invoked = await fetch(`${runtime.apiUrl}/functions/v1/echo`, {
      client,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tls: true }),
    });
    assertEquals(invoked.status, 200);
    assertEquals(await invoked.json(), {
      body: { tls: true },
      supabaseUrl: runtime.apiUrl,
    });
    const stopped = await fetch(new URL("/_minibase/shutdown", runtime.controlUrl), {
      client,
      method: "POST",
      headers: { "x-minibase-control-token": runtime.controlToken },
    });
    assertEquals(stopped.status, 202);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  } finally {
    client.close();
    try {
      child.kill("SIGKILL");
    } catch {
      // The normal shutdown path already reaped the process.
    }
    await Deno.remove(root, { recursive: true });
  }
});

function startServer(root: string, port: number): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "main.ts"),
      "start",
      "--project",
      root,
      "--port",
      String(port),
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

function availablePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForRuntime(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TLS server");
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
    } else {
      throw new Error(`Fixture contains unsupported entry: ${basename(sourcePath)}`);
    }
  }
}

// Test-only key material for localhost. It is not used by product code or trusted outside this test.
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJA7Hf4IZwJRVhMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMTCWxvY2FsaG9zdDAeFw0yNjA4MDQwODI1MjRaFw0zNjA4MDEwODI1MjRaMBQx
EjAQBgNVBAMTCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAOwtzoP9UT6IUvONnjvk21cV5e+JdlNgOvXQc6hxYQ5ZweDg2wQKNawcKe6t
d7CxjmUkoCtZruiGX9hnechPvqjmlacZdtgMWJc6W1vIr8hT0YTH+aRRUYoIJ2Qj
HdNB18352E2L1tdd3TT0qjFq73IqaEjwVyo+H6HxQMrfBEktC4w9cfHu3iSAFijk
qx6tbtZxLINWH25cT5XhB5NYl1mE3vn4Byl4R7lS3z5kJ1FAO48eaWaMMC42mYSD
dMTTulAme8zJpjWIpaICx2YtNdtat/kHsFOZhZeWuWFu8Yz3GdKitf/FYC7Jnk6K
vBunpM52nNbKkuJ8Xvvepa6fASECAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQC7CK+rWx5lJiU154OxxK1zORw8
ALEEr8vxycZbKs2w/cBieu5MJs+1w142M6Xqbs/UtMwxBN4g6fimWl46WAFjYBzS
ereF2EdnMK2wNTMDbvS/kTn0IAoqi4L4E8bnmosHjaYmo/vLTI8HzV00RDnwkvAH
uhtm7bkHUIJPBJkNRXs0wTh73NVtM1thJIKaBK+38TXOsdC1kNCOvbyyXigkxpxs
J2jXGFxv5Upw37HINoFfD48rned/yjzZT33umjXVuriNlI2kXDZNzQTGjJ+49QDu
Sdox1e9wIZIUHnqqh1mjYlVo3MQYT/59QEZT6X/48bglgYXRoSCOL7dOhSMs
-----END CERTIFICATE-----
`;

const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA7C3Og/1RPohS842eO+TbVxXl74l2U2A69dBzqHFhDlnB4ODb
BAo1rBwp7q13sLGOZSSgK1mu6IZf2Gd5yE++qOaVpxl22AxYlzpbW8ivyFPRhMf5
pFFRiggnZCMd00HXzfnYTYvW113dNPSqMWrvcipoSPBXKj4fofFAyt8ESS0LjD1x
8e7eJIAWKOSrHq1u1nEsg1YfblxPleEHk1iXWYTe+fgHKXhHuVLfPmQnUUA7jx5p
ZowwLjaZhIN0xNO6UCZ7zMmmNYilogLHZi0121q3+QewU5mFl5a5YW7xjPcZ0qK1
/8VgLsmeToq8G6ekznac1sqS4nxe+96lrp8BIQIDAQABAoIBAQCUqlzVfo42g49b
mehhoTRkQ/eB6ZBe+TMD6pvzCrNiWiONT1zt1RNl7DCE+hJeWdXdWsmrn/9WhMcu
LCxfZ7sHDGZlUcUaR+M4Blbdlpz3x7MaFtrQkRN3hJxvDx/GDCswj7WVUpIA7SfC
HsRG6R4iSgls6ESl5Yb55Ce5y9ohyJBo+Y493rVd5e7dyayzS2yvowutVZQKPkp2
Akn2u54jHAnPhj2MC3JHR838nPjWrDl0dahoxVUblDXxySo4zkm0mU4Q8oL3tBRv
LbLGhGKogj+aHcbnhWf4yoRDzf+ghCaSAAB4JdGe/BOvMjNdr9ZT+F/4sB+UYcu0
TaaIomABAoGBAPM4Der8Rq7Z1akXtCBc2zQ7n6QL1Xk5iYVt93wI2ZRniXkxw9/7
SOkU/f+Sod0TgZqLI6xqVgCuZMEt0xTZ6gSN/NMBAbS9PIM2km6cjk/ihHYzW9/i
ZBJCP8xVWiGcFcypG4A3TqnNJLwDThNKrSiw/v0DjVNipUWN7HsFUFIhAoGBAPiX
C4u0SZKSSfxzETzm19Usdz7nNUegtLNUbtEhbORVrI5J7OsdUw5fwlBuMxYo4x+U
tlDkq0+bkCFw04kd6eYxpXz4btmO8P3nfo7WTDniim+kSfBxVLrdO7BvXPsXb9mU
8ZcGJuKJGelRI6KLC9K9ivYbiLTjQ6Dya83GJs8BAoGBAL9XK+vfyCOqj+JVGYoU
QwcWmQLPpIOX9k6YMojL1ZBg29ASjIxa/gMQVrqHOvvXarCQIeJ0TXB/whgP2u2e
efJXWb0OH6926HI5rn2CgJrsE1WCFhdN3XhX0iUISL4EM0otB8uYtzPyhaG73+Jh
b1SB2jhmYPpmsqrDenVVutjBAoGBAPJS4xlbNIDhg6fIT1xrtqeCAffakFBzctKB
Eslf6PMoJN5LZ9zFKCqR5CxdUAVg9A3b/GEcl3Yxsa03e61k8JXJfYU183C2a2tG
l1MLySCAGey8XKs6/pptgHr8A8psTUbvbxWGFK+tcAnFY5RWML9Mr0I7EucpxsoE
plvftgMBAoGAW+0VDSf/DxToZs7D7e4x4+JcIfQ7ytRx7dAAoGPQbbfXGSG/kSZ0
fJAz7x/qyRvDlX9lRhOzP6ZAfTJKim89CrHiYBfYm1VlrtbzINJ7LR/ONA0NMkq7
j1dN6WbrqWRssOjeXigY4E9I29g86iVomSBSQbBqHpgh+Q9BDXYsD3A=
-----END RSA PRIVATE KEY-----
`;

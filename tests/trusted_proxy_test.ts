import { assertEquals, assertThrows } from "@std/assert";
import {
  createTrustedProxyMatcher,
  normalizeProxyRequest,
  ProxyHeaderError,
} from "../src/server/trusted_proxy.ts";

Deno.test("untrusted peers cannot spoof forwarding headers", async () => {
  const request = new Request("http://internal.example:54321/functions/v1/echo?source=direct", {
    method: "POST",
    headers: {
      forwarded: 'for=198.51.100.1;proto=https;host="evil.example"',
      "x-forwarded-for": "198.51.100.2",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    },
    body: "preserved",
  });
  const normalized = normalizeProxyRequest(
    request,
    "192.0.2.44",
    createTrustedProxyMatcher(["10.0.0.0/8"]),
  );

  assertEquals(normalized.url, request.url);
  assertEquals(normalized.headers.get("x-forwarded-for"), "192.0.2.44");
  assertEquals(normalized.headers.get("x-forwarded-host"), "internal.example:54321");
  assertEquals(normalized.headers.get("x-forwarded-port"), "54321");
  assertEquals(normalized.headers.get("x-forwarded-proto"), "http");
  assertEquals(
    normalized.headers.get("forwarded"),
    'for=192.0.2.44;proto=http;host="internal.example:54321"',
  );
  assertEquals(await normalized.text(), "preserved");
});

Deno.test("Forwarded walks trusted proxy CIDRs from right to left", () => {
  const normalized = normalizeProxyRequest(
    new Request("http://127.0.0.1:54321/functions/v1/echo", {
      headers: {
        forwarded:
          'for=198.51.100.7;proto=https;host="api.example.test:8443", for=10.2.3.4;proto=http;host="internal.example"',
      },
    }),
    "127.0.0.1",
    createTrustedProxyMatcher(["127.0.0.1", "10.0.0.0/8"]),
  );

  assertEquals(normalized.url, "https://api.example.test:8443/functions/v1/echo");
  assertEquals(normalized.headers.get("x-forwarded-for"), "198.51.100.7");
  assertEquals(normalized.headers.get("x-forwarded-host"), "api.example.test:8443");
  assertEquals(normalized.headers.get("x-forwarded-port"), "8443");
  assertEquals(normalized.headers.get("x-forwarded-proto"), "https");
});

Deno.test("legacy forwarding selects the first untrusted address instead of a spoofed prefix", () => {
  const normalized = normalizeProxyRequest(
    new Request("http://127.0.0.1:54321/functions/v1/echo", {
      headers: {
        "x-forwarded-for": "198.51.100.1, 203.0.113.9",
        "x-forwarded-host": "evil.example, safe.example:8080",
        "x-forwarded-port": "443, 8080",
        "x-forwarded-proto": "https, http",
      },
    }),
    "127.0.0.1",
    createTrustedProxyMatcher(["127.0.0.1"]),
  );

  assertEquals(normalized.url, "http://safe.example:8080/functions/v1/echo");
  assertEquals(normalized.headers.get("x-forwarded-for"), "203.0.113.9");
  assertEquals(normalized.headers.get("x-forwarded-host"), "safe.example:8080");
  assertEquals(normalized.headers.get("x-forwarded-proto"), "http");
});

Deno.test("trusted proxies reject malformed protocol and host values", () => {
  const matcher = createTrustedProxyMatcher(["127.0.0.1", "::1"]);
  assertEquals(matcher.matches("127.0.0.1"), true);
  assertEquals(matcher.matches("::1"), true);
  assertEquals(matcher.matches("192.0.2.1"), false);
  const ipv6Range = createTrustedProxyMatcher(["2001:db8::/32"]);
  assertEquals(ipv6Range.matches("2001:db8:1::42"), true);
  assertEquals(ipv6Range.matches("2001:db9::1"), false);

  assertThrows(
    () =>
      normalizeProxyRequest(
        new Request("http://127.0.0.1:54321/", {
          headers: { forwarded: "for=198.51.100.4;proto=ftp;host=api.example.test" },
        }),
        "127.0.0.1",
        matcher,
      ),
    ProxyHeaderError,
    "protocol must be http or https",
  );
  assertThrows(
    () =>
      normalizeProxyRequest(
        new Request("http://127.0.0.1:54321/", {
          headers: { "x-forwarded-host": "user@example.test" },
        }),
        "127.0.0.1",
        matcher,
      ),
    ProxyHeaderError,
    "host is invalid",
  );
});

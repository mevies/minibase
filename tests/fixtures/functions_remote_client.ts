const [baseUrl, allowedOrigin, deniedOrigin] = Deno.args;
if (baseUrl === undefined || allowedOrigin === undefined || deniedOrigin === undefined) {
  throw new Error("Expected base URL, allowed Origin and denied Origin");
}

const route = `${baseUrl}/functions/v1/remote/child?source=separate-process`;
const preflight = await fetch(route, {
  method: "OPTIONS",
  headers: {
    origin: allowedOrigin,
    "access-control-request-method": "PATCH",
    "access-control-request-headers": "content-type, x-remote-client",
  },
});
const allowed = await fetch(route, {
  method: "PATCH",
  headers: {
    origin: allowedOrigin,
    "content-type": "application/json",
    forwarded: 'for=198.51.100.41;proto=https;host="edge.example.test:8443"',
    "x-forwarded-for": "203.0.113.200",
    "x-forwarded-host": "ignored.example",
    "x-forwarded-proto": "http",
    "x-remote-client": "independent-deno-process",
  },
  body: JSON.stringify({ compatible: true }),
});
const deniedPreflight = await fetch(route, {
  method: "OPTIONS",
  headers: {
    origin: deniedOrigin,
    "access-control-request-method": "PATCH",
  },
});
const denied = await fetch(route, {
  method: "PATCH",
  headers: {
    origin: deniedOrigin,
    "content-type": "application/json",
    "x-forwarded-for": "198.51.100.99, 203.0.113.20",
    "x-forwarded-host": "evil.example, safe.example:8080",
    "x-forwarded-port": "443, 8080",
    "x-forwarded-proto": "https, http",
  },
  body: JSON.stringify({ compatible: true }),
});
const malformed = await fetch(route, {
  headers: {
    forwarded: "for=198.51.100.5;proto=ftp;host=api.example.test",
  },
});
const protectedRoute = `${baseUrl}/functions/v1/protected`;
const protectedWithoutToken = await fetch(protectedRoute, { method: "POST" });
const signup = await fetch(`${baseUrl}/auth/v1/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "remote-auth@example.com",
    password: "correct horse battery staple",
  }),
});
if (!signup.ok) throw new Error(`Remote signup failed with ${signup.status}`);
const session = await signup.json() as { access_token?: string };
if (session.access_token === undefined) throw new Error("Remote signup returned no access token");
const protectedWithToken = await fetch(protectedRoute, {
  method: "POST",
  headers: {
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
    "x-remote-client": "authenticated-remote-client",
  },
  body: JSON.stringify({ protected: true }),
});

console.log(JSON.stringify({
  preflight: {
    status: preflight.status,
    origin: preflight.headers.get("access-control-allow-origin"),
    methods: preflight.headers.get("access-control-allow-methods"),
    headers: preflight.headers.get("access-control-allow-headers"),
    vary: preflight.headers.get("vary"),
  },
  allowed: {
    status: allowed.status,
    origin: allowed.headers.get("access-control-allow-origin"),
    requestId: allowed.headers.get("x-request-id"),
    body: await allowed.json(),
  },
  deniedPreflight: {
    status: deniedPreflight.status,
    origin: deniedPreflight.headers.get("access-control-allow-origin"),
  },
  denied: {
    status: denied.status,
    origin: denied.headers.get("access-control-allow-origin"),
    body: await denied.json(),
  },
  malformed: {
    status: malformed.status,
    body: await malformed.json(),
  },
  protectedWithoutToken: {
    status: protectedWithoutToken.status,
    body: await protectedWithoutToken.json(),
  },
  protectedWithToken: {
    status: protectedWithToken.status,
    body: await protectedWithToken.json(),
  },
}));

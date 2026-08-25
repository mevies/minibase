import { assertEquals, assertRejects } from "@std/assert";
import {
  type JwtAsymmetricSigningKey,
  type JwtClaims,
  signJwt,
  verifyJwt,
} from "../src/auth/jwt.ts";

Deno.test("JWT supports ES256 signing beside retained HS256 verification", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const es256: JwtAsymmetricSigningKey = {
    kid: "es256-test",
    algorithm: "ES256",
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
  const legacy = { kid: "legacy-test", secret: "legacy-secret-with-at-least-32-characters" };
  const keyring = {
    activeKid: es256.kid,
    signingKeys: [legacy, es256],
  };
  const now = Math.floor(Date.now() / 1_000);
  const claims: JwtClaims = {
    sub: "11111111-1111-4111-8111-111111111111",
    role: "authenticated",
    iat: now,
    exp: now + 60,
  };

  const asymmetricToken = await signJwt(claims, es256);
  assertEquals((await verifyJwt(asymmetricToken, keyring)).sub, claims.sub);

  const legacyToken = await signJwt(claims, legacy);
  assertEquals((await verifyJwt(legacyToken, keyring)).role, "authenticated");

  const wrongKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const wrongKey: JwtAsymmetricSigningKey = {
    ...es256,
    publicJwk: await crypto.subtle.exportKey("jwk", wrongKeyPair.publicKey),
  };
  await assertRejects(
    () => verifyJwt(asymmetricToken, { ...keyring, signingKeys: [legacy, wrongKey] }),
    Error,
    "Invalid JWT signature",
  );
});

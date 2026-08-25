import { constantTimeEqual, decodeBase64Url, encodeBase64Url } from "./encoding.ts";

export interface JwtClaims {
  sub?: string;
  role: "anon" | "authenticated" | "service_role";
  aud?: string;
  email?: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export interface JwtSigningKey {
  kid: string;
  secret: string;
}

export interface JwtAsymmetricSigningKey {
  kid: string;
  algorithm: "ES256";
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export type JwtKey = JwtSigningKey | JwtAsymmetricSigningKey;

export interface JwtKeyring {
  activeKid: string;
  signingKeys: JwtKey[];
}

interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

async function signingKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function signJwt(
  claims: JwtClaims,
  key: string | JwtKey,
): Promise<string> {
  const algorithm = typeof key === "object" && "algorithm" in key ? key.algorithm : "HS256";
  const header = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({
      alg: algorithm,
      typ: "JWT",
      ...(typeof key === "string" ? {} : { kid: key.kid }),
    })),
  );
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const content = `${header}.${payload}`;
  const contentBytes = new TextEncoder().encode(content);
  const signature = algorithm === "ES256"
    ? await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await importEs256Key(key as JwtAsymmetricSigningKey, "private", ["sign"]),
      contentBytes,
    )
    : await crypto.subtle.sign(
      "HMAC",
      await signingKey(typeof key === "string" ? key : (key as JwtSigningKey).secret, ["sign"]),
      contentBytes,
    );
  return `${content}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyJwt(
  token: string,
  keys: string | JwtKeyring,
): Promise<JwtClaims> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new Error("Invalid JWT structure");
  }
  const [headerSegment, payload, signature] = segments as [string, string, string];
  let header: JwtHeader;
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(headerSegment)),
    ) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("Invalid JWT header");
    }
    header = decoded as JwtHeader;
  } catch {
    throw new Error("Invalid JWT header");
  }
  if (
    !["HS256", "ES256"].includes(header.alg) ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    (header.kid !== undefined && typeof header.kid !== "string")
  ) {
    throw new Error("Unsupported JWT algorithm or type");
  }
  const candidates = verificationCandidates(keys, header.kid, header.alg);
  const content = `${headerSegment}.${payload}`;
  const received = decodeBase64Url(signature);
  const receivedSignature = Uint8Array.from(received);
  let valid = false;
  for (const candidate of candidates) {
    if ("algorithm" in candidate) {
      valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        await importEs256Key(candidate, "public", ["verify"]),
        receivedSignature,
        new TextEncoder().encode(content),
      ) || valid;
    } else {
      const expected = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await signingKey(candidate.secret, ["sign"]),
          new TextEncoder().encode(content),
        ),
      );
      valid = constantTimeEqual(expected, receivedSignature) || valid;
    }
  }
  if (!valid) {
    throw new Error("Invalid JWT signature");
  }
  let claims: JwtClaims;
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error("Invalid JWT payload");
    }
    claims = decoded as JwtClaims;
  } catch {
    throw new Error("Invalid JWT payload");
  }
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    throw new Error("Invalid JWT timestamps");
  }
  if (claims.exp <= Math.floor(Date.now() / 1_000)) {
    throw new Error("JWT has expired");
  }
  if (!["anon", "authenticated", "service_role"].includes(claims.role)) {
    throw new Error("Invalid JWT role");
  }
  return claims;
}

function verificationCandidates(
  keys: string | JwtKeyring,
  kid: string | undefined,
  algorithm: string,
): JwtKey[] {
  if (typeof keys === "string") {
    return algorithm === "HS256" ? [{ kid: "legacy", secret: keys }] : [];
  }
  if (kid === undefined) {
    return keys.signingKeys.filter((key) => jwtKeyAlgorithm(key) === algorithm);
  }
  const selected = keys.signingKeys.find((key) => key.kid === kid);
  if (selected === undefined) {
    throw new Error(`Unknown JWT signing key: ${kid}`);
  }
  return jwtKeyAlgorithm(selected) === algorithm ? [selected] : [];
}

function jwtKeyAlgorithm(key: JwtKey): "HS256" | "ES256" {
  return "algorithm" in key ? key.algorithm : "HS256";
}

async function importEs256Key(
  key: JwtAsymmetricSigningKey,
  part: "private" | "public",
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    part === "private" ? key.privateJwk : key.publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    usages,
  );
}

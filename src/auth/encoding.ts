export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

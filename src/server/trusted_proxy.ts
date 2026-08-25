interface IpAddress {
  bytes: Uint8Array;
}

interface IpRange {
  address: IpAddress;
  prefixBits: number;
}

interface ForwardedHop {
  forAddress?: IpAddress;
  host?: string;
  proto?: string;
}

export class ProxyHeaderError extends Error {
  override name = "ProxyHeaderError";
}

export class TrustedProxyMatcher {
  readonly #ranges: IpRange[];

  constructor(entries: string[]) {
    this.#ranges = entries.map(parseIpRange);
  }

  matches(address: string): boolean {
    const parsed = parseIpAddress(address);
    return parsed !== null && this.matchesAddress(parsed);
  }

  matchesAddress(address: IpAddress): boolean {
    return this.#ranges.some((range) => contains(range, address));
  }
}

export function createTrustedProxyMatcher(entries: string[]): TrustedProxyMatcher {
  return new TrustedProxyMatcher(entries);
}

export function normalizeProxyRequest(
  request: Request,
  remoteAddress: string,
  trustedProxies: TrustedProxyMatcher,
  signal?: AbortSignal,
): Request {
  const remote = parseIpAddress(remoteAddress);
  if (remote === null) {
    throw new Error(`Server reported an invalid remote IP address: ${remoteAddress}`);
  }

  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  let client = remote;
  let protocol = url.protocol.slice(0, -1).toLowerCase();
  let host = url.host;
  let forwardedPort: string | undefined;
  let forwardedHostHasPort = false;

  if (trustedProxies.matchesAddress(remote)) {
    const forwarded = headers.get("forwarded");
    if (forwarded !== null) {
      const hops = parseForwarded(forwarded);
      const selected = selectForwardedHop(hops, remote, trustedProxies);
      client = selected.client;
      protocol = selected.hop.proto === undefined
        ? protocol
        : normalizeProtocol(selected.hop.proto);
      if (selected.hop.host !== undefined) {
        const normalized = normalizeHost(selected.hop.host, protocol);
        host = normalized.host;
        forwardedHostHasPort = normalized.hasExplicitPort;
      }
    } else {
      const legacy = selectLegacyForwarding(headers, remote, trustedProxies);
      client = legacy.client;
      protocol = legacy.proto === undefined ? protocol : normalizeProtocol(legacy.proto);
      if (legacy.host !== undefined) {
        const normalized = normalizeHost(legacy.host, protocol);
        host = normalized.host;
        forwardedHostHasPort = normalized.hasExplicitPort;
      }
      forwardedPort = legacy.port;
    }
  }

  url.protocol = `${protocol}:`;
  url.host = host;
  if (forwardedPort !== undefined && !forwardedHostHasPort) {
    url.port = normalizePort(forwardedPort);
  }

  for (
    const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
    ]
  ) {
    headers.delete(name);
  }

  const clientIp = formatIpAddress(client);
  const externalProtocol = url.protocol.slice(0, -1);
  const externalPort = url.port || (externalProtocol === "https" ? "443" : "80");
  headers.set("forwarded", canonicalForwarded(clientIp, externalProtocol, url.host));
  headers.set("host", url.host);
  headers.set("x-forwarded-for", clientIp);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-port", externalPort);
  headers.set("x-forwarded-proto", externalProtocol);

  return new Request(url, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    signal,
  });
}

function parseIpRange(value: string): IpRange {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf("/");
  const addressText = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const address = parseIpAddress(addressText);
  if (address === null) {
    throw new Error(`server.trusted_proxies contains an invalid IP or CIDR: ${value}`);
  }
  const maximum = address.bytes.length * 8;
  const prefixText = slash < 0 ? String(maximum) : trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/u.test(prefixText)) {
    throw new Error(`server.trusted_proxies contains an invalid IP or CIDR: ${value}`);
  }
  const prefixBits = Number(prefixText);
  if (prefixBits < 0 || prefixBits > maximum) {
    throw new Error(`server.trusted_proxies contains an invalid IP or CIDR: ${value}`);
  }
  return { address, prefixBits };
}

function contains(range: IpRange, candidate: IpAddress): boolean {
  if (range.address.bytes.length !== candidate.bytes.length) return false;
  const fullBytes = Math.floor(range.prefixBits / 8);
  for (let index = 0; index < fullBytes; index++) {
    if (range.address.bytes[index] !== candidate.bytes[index]) return false;
  }
  const remainder = range.prefixBits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (range.address.bytes[fullBytes]! & mask) === (candidate.bytes[fullBytes]! & mask);
}

function parseIpAddress(value: string): IpAddress | null {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (unwrapped.length === 0 || unwrapped.includes("%")) return null;
  const ipv4 = parseIpv4(unwrapped);
  if (ipv4 !== null) return { bytes: ipv4 };
  const ipv6 = parseIpv6(unwrapped);
  if (ipv6 === null) return null;
  if (
    ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff
  ) {
    return { bytes: ipv6.slice(12) };
  }
  return { bytes: ipv6 };
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) return null;
    const parsed = Number(part);
    if (parsed > 255) return null;
    bytes[index] = parsed;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parseIpv6Parts(halves[0] ?? "");
  const right = halves.length === 2 ? parseIpv6Parts(halves[1] ?? "") : [];
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const values = halves.length === 1
    ? left
    : [...left, ...new Array<number>(missing).fill(0), ...right];
  if (values.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < values.length; index++) {
    bytes[index * 2] = values[index]! >> 8;
    bytes[index * 2 + 1] = values[index]! & 0xff;
  }
  return bytes;
}

function parseIpv6Parts(value: string): number[] | null {
  if (value.length === 0) return [];
  const parts = value.split(":");
  const values: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.includes(".")) {
      if (index !== parts.length - 1) return null;
      const ipv4 = parseIpv4(part);
      if (ipv4 === null) return null;
      values.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null;
    values.push(Number.parseInt(part, 16));
  }
  return values;
}

function formatIpAddress(address: IpAddress): string {
  if (address.bytes.length === 4) return [...address.bytes].join(".");
  const groups = new Array<number>(8);
  for (let index = 0; index < groups.length; index++) {
    groups[index] = (address.bytes[index * 2]! << 8) | address.bytes[index * 2 + 1]!;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) {
      index++;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(":");
  const right = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(":");
  return `${left}::${right}`;
}

function parseForwarded(value: string): ForwardedHop[] {
  return splitDelimited(value, ",").map((element) => {
    const hop: ForwardedHop = {};
    const seen = new Set<string>();
    for (const parameter of splitDelimited(element, ";")) {
      const equals = parameter.indexOf("=");
      if (equals < 1) throw new ProxyHeaderError("Forwarded contains an invalid parameter");
      const name = parameter.slice(0, equals).trim().toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) {
        throw new ProxyHeaderError("Forwarded contains an invalid parameter name");
      }
      const parsedValue = parseParameterValue(parameter.slice(equals + 1).trim());
      if (seen.has(name)) throw new ProxyHeaderError(`Forwarded repeats ${name}`);
      seen.add(name);
      if (name === "for") {
        hop.forAddress = parseForwardedAddress(parsedValue);
      } else if (name === "host") {
        hop.host = parsedValue;
      } else if (name === "proto") {
        hop.proto = parsedValue;
      }
    }
    return hop;
  });
}

function splitDelimited(value: string, delimiter: "," | ";"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      const part = value.slice(start, index).trim();
      if (part.length === 0) throw new ProxyHeaderError("Proxy header contains an empty value");
      parts.push(part);
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new ProxyHeaderError("Proxy header contains an invalid quote");
  const tail = value.slice(start).trim();
  if (tail.length === 0) throw new ProxyHeaderError("Proxy header contains an empty value");
  parts.push(tail);
  return parts;
}

function parseParameterValue(value: string): string {
  if (!value.startsWith('"')) {
    if (value.length === 0 || /[\s,;"\\]/u.test(value)) {
      throw new ProxyHeaderError("Forwarded contains an invalid value");
    }
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) {
    throw new ProxyHeaderError("Forwarded contains an invalid quoted value");
  }
  let result = "";
  let escaped = false;
  for (const character of value.slice(1, -1)) {
    if (escaped) {
      result += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      throw new ProxyHeaderError("Forwarded contains an invalid quoted value");
    } else {
      result += character;
    }
  }
  if (escaped) throw new ProxyHeaderError("Forwarded contains an invalid quoted value");
  return result;
}

function parseForwardedAddress(value: string): IpAddress | undefined {
  const lowered = value.toLowerCase();
  if (lowered === "unknown" || lowered.startsWith("_")) return undefined;
  const direct = parseIpAddress(value);
  if (direct !== null) return direct;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) throw new ProxyHeaderError("Forwarded contains an invalid for address");
    const suffix = value.slice(close + 1);
    if (suffix.length > 0) normalizePort(suffix.replace(/^:/u, ""));
    const parsed = parseIpAddress(value.slice(1, close));
    if (parsed !== null) return parsed;
  } else if ((value.match(/:/gu) ?? []).length === 1) {
    const colon = value.lastIndexOf(":");
    normalizePort(value.slice(colon + 1));
    const parsed = parseIpAddress(value.slice(0, colon));
    if (parsed !== null) return parsed;
  }
  throw new ProxyHeaderError("Forwarded contains an invalid for address");
}

function selectForwardedHop(
  hops: ForwardedHop[],
  remote: IpAddress,
  trustedProxies: TrustedProxyMatcher,
): { client: IpAddress; hop: ForwardedHop } {
  let client = remote;
  let selected = hops.length - 1;
  for (let index = hops.length - 1; index >= 0; index--) {
    selected = index;
    const candidate = hops[index]!.forAddress;
    if (candidate === undefined) break;
    client = candidate;
    if (!trustedProxies.matchesAddress(client)) break;
  }
  return { client, hop: hops[selected]! };
}

function selectLegacyForwarding(
  headers: Headers,
  remote: IpAddress,
  trustedProxies: TrustedProxyMatcher,
): { client: IpAddress; host?: string; port?: string; proto?: string } {
  const forValues = optionalHeaderValues(headers.get("x-forwarded-for"));
  let client = remote;
  let offsetFromRight = 0;
  for (let index = forValues.length - 1; index >= 0; index--) {
    offsetFromRight = forValues.length - 1 - index;
    const candidate = parseForwardedAddress(forValues[index]!);
    if (candidate === undefined) break;
    client = candidate;
    if (!trustedProxies.matchesAddress(client)) break;
  }
  return {
    client,
    host: selectLegacyValue(headers.get("x-forwarded-host"), offsetFromRight),
    port: selectLegacyValue(headers.get("x-forwarded-port"), offsetFromRight),
    proto: selectLegacyValue(headers.get("x-forwarded-proto"), offsetFromRight),
  };
}

function optionalHeaderValues(value: string | null): string[] {
  return value === null ? [] : splitDelimited(value, ",");
}

function selectLegacyValue(value: string | null, offsetFromRight: number): string | undefined {
  const values = optionalHeaderValues(value);
  if (values.length === 0) return undefined;
  if (values.length === 1) return values[0];
  return values.at(-1 - offsetFromRight);
}

function normalizeProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  if (protocol !== "http" && protocol !== "https") {
    throw new ProxyHeaderError("Forwarded protocol must be http or https");
  }
  return protocol;
}

function normalizeHost(
  value: string,
  protocol: string,
): { host: string; hasExplicitPort: boolean } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\s/@\\?#]/u.test(trimmed)) {
    throw new ProxyHeaderError("Forwarded host is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(`${protocol}://${trimmed}/`);
  } catch {
    throw new ProxyHeaderError("Forwarded host is invalid");
  }
  if (parsed.hostname.length === 0 || parsed.username || parsed.password) {
    throw new ProxyHeaderError("Forwarded host is invalid");
  }
  const hasExplicitPort = trimmed.startsWith("[")
    ? /^\[[^\]]+\]:\d+$/u.test(trimmed)
    : /:\d+$/u.test(trimmed);
  return { host: parsed.host, hasExplicitPort };
}

function normalizePort(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/u.test(trimmed)) throw new ProxyHeaderError("Forwarded port is invalid");
  const port = Number(trimmed);
  if (port < 1 || port > 65_535) throw new ProxyHeaderError("Forwarded port is invalid");
  return String(port);
}

function canonicalForwarded(clientIp: string, protocol: string, host: string): string {
  const forValue = clientIp.includes(":") ? `"[${clientIp}]"` : clientIp;
  return `for=${forValue};proto=${protocol};host="${escapeQuoted(host)}"`;
}

function escapeQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

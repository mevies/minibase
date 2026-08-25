import type {
  FunctionNetworkOverride,
  MinibaseConfig,
  OutboundNetworkMode,
} from "../config/types.ts";
import { createTrustedProxyMatcher } from "../server/trusted_proxy.ts";

interface HostRule {
  wildcard: boolean;
  hostname: string;
  port?: number;
}

export interface RuntimeNetworkLayer {
  source: "project" | "function";
  outbound: OutboundNetworkMode;
  allowedHosts: string[];
}

export interface RuntimeNetworkPolicy {
  layers: RuntimeNetworkLayer[];
  allowSupabaseUrl: boolean;
  supabaseOrigin: string;
  blockPrivateNetworks: boolean;
}

export class FunctionNetworkPolicyError extends Error {
  override name = "FunctionNetworkPolicyError";
}

const BLOCKED_NETWORKS = createTrustedProxyMatcher([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
]);

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
]);

export function normalizeAllowedHosts(values: string[], key: string): string[] {
  const normalized = values.map((value) => formatHostRule(parseHostRule(value, key)));
  return [...new Set(normalized)];
}

export function buildRuntimeNetworkPolicy(
  config: MinibaseConfig,
  functionName: string,
): RuntimeNetworkPolicy {
  const override = config.functions.definitions[functionName]?.network;
  const layers: RuntimeNetworkLayer[] = [{
    source: "project",
    outbound: config.functions.outbound,
    allowedHosts: config.functions.allowedHosts,
  }];
  if (override?.outbound !== undefined) {
    layers.push({
      source: "function",
      outbound: override.outbound,
      allowedHosts: override.allowedHosts ?? [],
    });
  }
  return {
    layers,
    allowSupabaseUrl: config.functions.allowSupabaseUrl &&
      override?.allowSupabaseUrl !== false,
    supabaseOrigin: new URL(config.server.publicUrl).origin,
    blockPrivateNetworks: config.functions.blockPrivateNetworks ||
      override?.blockPrivateNetworks === true,
  };
}

export function runtimeNetworkPermission(
  policy: RuntimeNetworkPolicy,
  workerPort: number,
  dnsServers: string[] = [],
): string {
  const allowed = [`127.0.0.1:${workerPort}`];
  if (policy.allowSupabaseUrl) allowed.push(urlHostRule(new URL(policy.supabaseOrigin)));
  const external = intersectAllowedLayers(policy.layers);
  if (external === null) return "--allow-net";
  allowed.push(...external);
  if (policy.blockPrivateNetworks && external.length > 0) {
    allowed.push(...dnsServers.map(dnsServerHostRule));
  }
  return `--allow-net=${[...new Set(allowed)].join(",")}`;
}

export async function assertNetworkUrlAllowed(
  policy: RuntimeNetworkPolicy,
  input: string | URL,
): Promise<void> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.origin === policy.supabaseOrigin) {
    if (policy.allowSupabaseUrl) return;
    throw new FunctionNetworkPolicyError(
      `Outbound fetch to ${url.host} is denied because SUPABASE_URL access is disabled`,
    );
  }
  for (const layer of policy.layers) {
    if (layer.outbound === "allow") continue;
    if (
      layer.outbound === "allowlist" &&
      layer.allowedHosts.some((rule) => matchesHostRule(parseHostRule(rule, "runtime"), url))
    ) {
      continue;
    }
    throw new FunctionNetworkPolicyError(
      `Outbound fetch to ${url.host} is denied by the ${layer.source} ${layer.outbound} policy`,
    );
  }
  if (policy.blockPrivateNetworks) await assertPublicTarget(url);
}

async function assertPublicTarget(url: URL): Promise<void> {
  const hostname = unbracket(url.hostname.toLowerCase());
  if (METADATA_HOSTS.has(hostname) || BLOCKED_NETWORKS.matches(hostname)) {
    throw privateNetworkError(url);
  }
  const results = await Promise.allSettled([
    Deno.resolveDns(hostname, "A"),
    Deno.resolveDns(hostname, "AAAA"),
  ]);
  if (
    results.some((result) =>
      result.status === "rejected" &&
      result.reason instanceof Error &&
      result.reason.name === "NotCapable"
    )
  ) {
    throw new FunctionNetworkPolicyError(
      `Outbound fetch to ${url.host} cannot be checked because DNS access is not permitted`,
    );
  }
  const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (addresses.some((address) => BLOCKED_NETWORKS.matches(address))) {
    throw privateNetworkError(url);
  }
}

function privateNetworkError(url: URL): FunctionNetworkPolicyError {
  return new FunctionNetworkPolicyError(
    `Outbound fetch to ${url.host} is blocked by the private-network SSRF policy`,
  );
}

function intersectAllowedLayers(layers: RuntimeNetworkLayer[]): string[] | null {
  if (layers.some((layer) => layer.outbound === "deny")) return [];
  const allowlists = layers.filter((layer) => layer.outbound === "allowlist");
  if (allowlists.length === 0) return null;
  let intersection = allowlists[0]!.allowedHosts.map((rule) => parseHostRule(rule, "runtime"));
  for (const layer of allowlists.slice(1)) {
    const next = layer.allowedHosts.map((rule) => parseHostRule(rule, "runtime"));
    intersection = intersection.flatMap((left) =>
      next.flatMap((right) => {
        const rule = intersectHostRules(left, right);
        return rule === null ? [] : [rule];
      })
    );
  }
  return [...new Set(intersection.map(formatHostRule))];
}

function intersectHostRules(left: HostRule, right: HostRule): HostRule | null {
  if (hostRuleSubset(left, right)) return left;
  if (hostRuleSubset(right, left)) return right;
  return null;
}

function hostRuleSubset(candidate: HostRule, container: HostRule): boolean {
  if (container.port !== undefined && candidate.port !== container.port) return false;
  if (!container.wildcard) {
    return !candidate.wildcard && candidate.hostname === container.hostname;
  }
  if (!candidate.wildcard) {
    return candidate.hostname.endsWith(`.${container.hostname}`);
  }
  return candidate.hostname === container.hostname ||
    candidate.hostname.endsWith(`.${container.hostname}`);
}

function matchesHostRule(rule: HostRule, url: URL): boolean {
  const hostname = unbracket(url.hostname.toLowerCase());
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  if (rule.port !== undefined && rule.port !== port) return false;
  return rule.wildcard ? hostname.endsWith(`.${rule.hostname}`) : hostname === rule.hostname;
}

function parseHostRule(value: string, key: string): HostRule {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || /[/?#@\s]/u.test(trimmed) || trimmed.includes("://")) {
    throw new Error(`${key} contains an invalid host rule: ${value}`);
  }
  let host = trimmed;
  let port: number | undefined;
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    if (closing < 2) throw new Error(`${key} contains an invalid host rule: ${value}`);
    const remainder = host.slice(closing + 1);
    if (remainder.length > 0) {
      if (!remainder.startsWith(":")) {
        throw new Error(`${key} contains an invalid host rule: ${value}`);
      }
      port = parseHostPort(remainder.slice(1), key, value);
    }
    host = host.slice(1, closing);
    if (!validIpv6(host)) throw new Error(`${key} contains an invalid host rule: ${value}`);
    return { wildcard: false, hostname: host, port };
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    if (host.indexOf(":") !== colon) {
      throw new Error(`${key} requires brackets around IPv6 host rules: ${value}`);
    }
    port = parseHostPort(host.slice(colon + 1), key, value);
    host = host.slice(0, colon);
  }
  const wildcard = host.startsWith("*.");
  if (host.includes("*") && !wildcard) {
    throw new Error(`${key} allows wildcards only as a leading '*.' rule: ${value}`);
  }
  const hostname = wildcard ? host.slice(2) : host;
  if (wildcard && hostname.split(".").length < 2) {
    throw new Error(`${key} wildcard rules require a registrable-style suffix: ${value}`);
  }
  if (!validHostname(hostname)) throw new Error(`${key} contains an invalid host rule: ${value}`);
  return { wildcard, hostname, port };
}

function parseHostPort(value: string, key: string, original: string): number {
  if (!/^\d{1,5}$/u.test(value)) {
    throw new Error(`${key} contains an invalid port: ${original}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65_535) {
    throw new Error(`${key} contains an invalid port: ${original}`);
  }
  return port;
}

function validHostname(value: string): boolean {
  if (value === "localhost") return true;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
}

function validIpv6(value: string): boolean {
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.length > 2;
  } catch {
    return false;
  }
}

function formatHostRule(rule: HostRule): string {
  const host = rule.hostname.includes(":")
    ? `[${rule.hostname}]`
    : `${rule.wildcard ? "*." : ""}${rule.hostname}`;
  return rule.port === undefined ? host : `${host}:${rule.port}`;
}

function urlHostRule(url: URL): string {
  const hostname = unbracket(url.hostname);
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

function dnsServerHostRule(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) return trimmed.includes("]:") ? trimmed : `${trimmed}:53`;
  const colons = (trimmed.match(/:/gu) ?? []).length;
  if (colons > 1) return `[${trimmed}]:53`;
  return colons === 1 ? trimmed : `${trimmed}:53`;
}

function unbracket(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function validateFunctionNetworkOverride(
  override: FunctionNetworkOverride,
  key: string,
): void {
  if (override.allowedHosts !== undefined && override.outbound !== "allowlist") {
    throw new Error(`${key}.allowed_hosts requires outbound = "allowlist"`);
  }
  if (override.outbound === "allowlist" && (override.allowedHosts?.length ?? 0) === 0) {
    throw new Error(`${key}.allowed_hosts must not be empty when outbound is allowlist`);
  }
}

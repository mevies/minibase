const INSPECT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:MINIBASE_ACL_TARGET
$acl = Get-Acl -LiteralPath $target
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    rights = [Int64]$_.FileSystemRights
    inherited = $_.IsInherited
  }
})
$result = [ordered]@{
  currentSid = $currentSid.Value
  ownerSid = $ownerSid.Value
  protected = $acl.AreAccessRulesProtected
  rules = $rules
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
`;

const SYSTEM_SID = "S-1-5-18";
const WINDOWS_FULL_CONTROL = 0x1f01ff;

export interface WindowsAclRule {
  sid: string;
  type: "Allow" | "Deny";
  rights: number;
  inherited: boolean;
}

export interface WindowsAclInspection {
  currentSid: string;
  ownerSid: string;
  protected: boolean;
  rules: WindowsAclRule[];
}

export async function inspectWindowsSecretAcl(path: string): Promise<WindowsAclInspection> {
  requireWindows();
  return parseInspection(await runPowerShellAclCommand(path, INSPECT_ACL_SCRIPT));
}

export async function hardenWindowsSecretAcl(path: string): Promise<void> {
  requireWindows();
  const current = await inspectWindowsSecretAcl(path);
  if (windowsSecretAclIsPrivate(current)) return;
  if (current.ownerSid !== current.currentSid) {
    throw new Error("Windows Secret file is not owned by the current account");
  }
  await runIcacls(path, ["/inheritance:r"]);
  const explicit = await inspectWindowsSecretAcl(path);
  const existingSids = [...new Set(explicit.rules.map((rule) => rule.sid))];
  for (const sid of existingSids) {
    await runIcacls(path, ["/remove", `*${sid}`]);
  }
  await runIcacls(path, [
    "/grant:r",
    `*${current.currentSid}:(F)`,
    `*${SYSTEM_SID}:(F)`,
  ]);
  const verified = await inspectWindowsSecretAcl(path);
  if (!windowsSecretAclIsPrivate(verified)) {
    throw new Error("Windows Secret ACL remained broader than the current user and SYSTEM");
  }
}

export async function hardenWindowsPrivateTreeAcl(path: string): Promise<void> {
  requireWindows();
  const current = await inspectWindowsSecretAcl(path);
  if (current.ownerSid !== current.currentSid) {
    throw new Error("Windows private directory is not owned by the current account");
  }
  await runIcacls(path, ["/inheritance:r"]);
  const explicit = await inspectWindowsSecretAcl(path);
  const existingSids = [...new Set(explicit.rules.map((rule) => rule.sid))];
  for (const sid of existingSids) {
    await runIcacls(path, ["/remove", `*${sid}`]);
  }
  await runIcacls(path, [
    "/grant:r",
    `*${current.currentSid}:(OI)(CI)(F)`,
    `*${SYSTEM_SID}:(OI)(CI)(F)`,
  ]);
  const verified = await inspectWindowsSecretAcl(path);
  if (!windowsSecretAclIsPrivate(verified)) {
    throw new Error(
      "Windows private directory ACL remained broader than the current user and SYSTEM",
    );
  }
}

export function windowsSecretAclIsPrivate(inspection: WindowsAclInspection): boolean {
  const allowedSids = [inspection.currentSid.toUpperCase(), SYSTEM_SID];
  return inspection.ownerSid === inspection.currentSid && inspection.protected &&
    inspection.rules.every((rule) => !rule.inherited) &&
    unauthorizedWindowsAclSids(inspection).length === 0 &&
    allowedSids.every((sid) => hasFullControl(inspection, sid)) &&
    !inspection.rules.some((rule) =>
      rule.type === "Deny" && rule.rights !== 0 && allowedSids.includes(rule.sid.toUpperCase())
    );
}

export function unauthorizedWindowsAclSids(inspection: WindowsAclInspection): string[] {
  const allowed = new Set([inspection.currentSid.toUpperCase(), SYSTEM_SID]);
  return [
    ...new Set(
      inspection.rules
        .filter((rule) =>
          rule.type === "Allow" && rule.rights !== 0 && !allowed.has(rule.sid.toUpperCase())
        )
        .map((rule) => rule.sid),
    ),
  ].sort();
}

function hasFullControl(inspection: WindowsAclInspection, sid: string): boolean {
  const rights = inspection.rules
    .filter((rule) => rule.type === "Allow" && rule.sid.toUpperCase() === sid)
    .reduce((combined, rule) => combined | rule.rights, 0);
  return (rights & WINDOWS_FULL_CONTROL) === WINDOWS_FULL_CONTROL;
}

async function runPowerShellAclCommand(path: string, script: string): Promise<string> {
  const output = await new Deno.Command("powershell.exe", {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    // Windows PowerShell needs PSModulePath to load Microsoft.PowerShell.Security.
    // Keep the child environment minimal so project secrets are not exposed to it.
    env: windowsPowerShellEnvironment(path),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const details = new TextDecoder().decode(output.stderr).trim().replaceAll(/\s+/gu, " ");
    throw new Error(
      `Windows ACL command failed with exit code ${output.code}${
        details.length === 0 ? "" : `: ${details.slice(0, 500)}`
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

export function windowsPowerShellEnvironment(target: string): Record<string, string> {
  const inherited = Deno.env.toObject();
  const systemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT ?? "C:\\Windows";
  const path = [
    `${systemRoot}\\System32`,
    systemRoot,
    `${systemRoot}\\System32\\Wbem`,
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
  ].join(";");
  return {
    ComSpec: inherited.ComSpec ?? `${systemRoot}\\System32\\cmd.exe`,
    MINIBASE_ACL_TARGET: target,
    PATH: path,
    PATHEXT: inherited.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
    PSModulePath: [
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      `${inherited.ProgramFiles ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules`,
    ].join(";"),
    SystemRoot: systemRoot,
    TEMP: inherited.TEMP ?? inherited.Tmp ?? "",
    TMP: inherited.TMP ?? inherited.Tmp ?? "",
    WINDIR: inherited.WINDIR ?? systemRoot,
  };
}

async function runIcacls(path: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("icacls.exe", {
    args: [path, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const details = new TextDecoder().decode(output.stderr).trim().replaceAll(/\s+/gu, " ");
    throw new Error(
      `Windows ACL update failed with exit code ${output.code}${
        details.length === 0 ? "" : `: ${details.slice(0, 500)}`
      }`,
    );
  }
}

function parseInspection(contents: string): WindowsAclInspection {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new Error("Windows ACL command returned invalid JSON");
  }
  if (!isRecord(raw)) throw new Error("Windows ACL command returned an invalid result");
  if (
    typeof raw.currentSid !== "string" || typeof raw.ownerSid !== "string" ||
    typeof raw.protected !== "boolean" || !Array.isArray(raw.rules)
  ) {
    throw new Error("Windows ACL command returned an invalid result");
  }
  const rules = raw.rules.map((rule) => parseRule(rule));
  return {
    currentSid: raw.currentSid,
    ownerSid: raw.ownerSid,
    protected: raw.protected,
    rules,
  };
}

function parseRule(raw: unknown): WindowsAclRule {
  if (
    !isRecord(raw) || typeof raw.sid !== "string" ||
    (raw.type !== "Allow" && raw.type !== "Deny") ||
    typeof raw.rights !== "number" || !Number.isSafeInteger(raw.rights) ||
    typeof raw.inherited !== "boolean"
  ) {
    throw new Error("Windows ACL command returned an invalid access rule");
  }
  return {
    sid: raw.sid,
    type: raw.type,
    rights: raw.rights,
    inherited: raw.inherited,
  };
}

function requireWindows(): void {
  if (Deno.build.os !== "windows") {
    throw new Error("Windows ACL operations are only available on Windows");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

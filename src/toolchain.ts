import toolchain from "../toolchain.json" with { type: "json" };

function requiredVersion(value: string | null, component: string): string {
  if (value === null || !/^\d+(?:\.\d+){1,2}$/u.test(value)) {
    throw new Error(`${component} must have a pinned numeric version in toolchain.json`);
  }
  return value;
}

export const PGLITE_VERSION = requiredVersion(
  toolchain.components.pglite.required,
  "PGlite",
);
export const POSTGRES_RUNTIME_VERSION = requiredVersion(
  toolchain.components.postgres.required,
  "PostgreSQL Runtime",
);
export const SUPPORTED_POSTGRES_MAJOR = Number(POSTGRES_RUNTIME_VERSION.split(".")[0]);

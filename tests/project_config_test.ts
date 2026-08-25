import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resetProject } from "../src/cli/lifecycle.ts";
import { loadConfig } from "../src/config/load.ts";
import { PGliteEngine } from "../src/database/pglite.ts";
import { resolveFunctionFiles } from "../src/functions/manager.ts";
import { discoverProject } from "../src/project/discover.ts";
import { prepareProject, readProjectState } from "../src/project/state.ts";

async function createFixture(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "minibase-project-test-" });
  await Deno.mkdir(join(root, "supabase", "migrations"), { recursive: true });
  await Deno.mkdir(join(root, "supabase", "functions"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "supabase", "config.toml"),
    'project_id = "fixture"\n[api]\nport = 55432\n[functions.echo]\nverify_jwt = true\n',
  );
  await Deno.writeTextFile(join(root, "supabase", "seed.sql"), "select 1;\n");
  return root;
}

Deno.test("discovers a Supabase project from a nested directory", async () => {
  const root = await createFixture();
  try {
    const nested = join(root, "src", "nested");
    await Deno.mkdir(nested, { recursive: true });
    const project = await discoverProject(nested);
    assertEquals(project.root, root);
    assertEquals(project.seedFile, join(root, "supabase", "seed.sql"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("project discovery accepts optional Supabase paths and never rewrites source files", async () => {
  const root = await Deno.makeTempDir({ prefix: "minibase-project-optional-test-" });
  const missing = await Deno.makeTempDir({ prefix: "minibase-project-missing-test-" });
  try {
    await Deno.mkdir(join(root, "supabase"));
    const marker = join(root, "supabase", "keep.sql");
    await Deno.writeTextFile(marker, "select 'unchanged';\n");
    const project = await discoverProject(join(root, "supabase"));
    assertEquals(project.root, root);
    assertEquals(project.seedFile, null);
    assertEquals(await fileExists(project.functionsDir), false);
    assertEquals(await fileExists(project.migrationsDir), false);
    await prepareProject(project, "pglite");
    assertEquals(await Deno.readTextFile(marker), "select 'unchanged';\n");
    assertEquals(
      [...Deno.readDirSync(project.supabaseDir)].map((entry) => entry.name).sort(),
      ["keep.sql"],
    );

    await assertRejects(
      () => discoverProject(missing),
      Error,
      "Expected a supabase directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(missing, { recursive: true });
  }
});

Deno.test("loads Supabase defaults and Minibase overrides", async () => {
  const root = await createFixture();
  try {
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      'format_version = 1\n[server]\nhost = "0.0.0.0"\n' +
        "[server.request]\nmax_body_bytes = 1048576\ntimeout_ms = 15000\nmax_concurrent = 32\n" +
        '[server.cors]\nallowed_origins = ["https://app.example"]\n' +
        '[database]\nengine = "postgres"\n' +
        "transaction_timeout_ms = 45000\nlong_transaction_warning_ms = 7000\n" +
        '[functions.network]\noutbound = "allowlist"\n' +
        'allowed_hosts = ["api.openai.com", "*.openai.example:443"]\n' +
        "allow_supabase_url = false\nblock_private_networks = true\n" +
        "[functions.runtime]\nworkers_per_function = 4\n" +
        "[functions.rate_limit]\nwindow_ms = 30000\nper_ip = 100\n" +
        "per_function = 1000\nper_identity = 200\nmax_keys = 20000\n" +
        "[functions.echo]\ninject_service_role_key = false\n" +
        '[functions.echo.network]\noutbound = "deny"\nallow_supabase_url = false\n' +
        "[functions.echo.rate_limit]\nwindow_ms = 10000\nper_ip = 5\nper_identity = 10\n" +
        '[logging]\nformat = "human"\nmax_bytes = 8192\nretention_files = 3\n' +
        "[logging.functions]\nmax_bytes = 4096\nretention_files = 2\n" +
        "[seed]\nenabled = false\n",
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.projectId, "fixture");
    assertEquals(config.server.port, 55_432);
    assertEquals(config.server.host, "0.0.0.0");
    assertEquals(config.server.request, {
      maxBodyBytes: 1_048_576,
      timeoutMs: 15_000,
      maxConcurrent: 32,
    });
    assertEquals(config.server.cors.allowedOrigins, ["https://app.example"]);
    assertEquals(config.database.engine, "postgres");
    assertEquals(config.database.transactionTimeoutMs, 45_000);
    assertEquals(config.database.longTransactionWarningMs, 7_000);
    assertEquals(config.functions.allowedHosts, ["api.openai.com", "*.openai.example:443"]);
    assertEquals(config.functions.allowSupabaseUrl, false);
    assertEquals(config.functions.blockPrivateNetworks, true);
    assertEquals(config.functions.runtime, { workersPerFunction: 4 });
    assertEquals(config.functions.rateLimit, {
      windowMs: 30_000,
      perIp: 100,
      perFunction: 1_000,
      perIdentity: 200,
      maxKeys: 20_000,
    });
    assertEquals(config.functions.definitions.echo?.verifyJwt, true);
    assertEquals(config.functions.definitions.echo?.injectServiceRoleKey, false);
    assertEquals(config.functions.definitions.echo?.network, {
      outbound: "deny",
      allowedHosts: undefined,
      allowSupabaseUrl: false,
      blockPrivateNetworks: undefined,
    });
    assertEquals(config.functions.definitions.echo?.rateLimit, {
      windowMs: 10_000,
      perIp: 5,
      perFunction: undefined,
      perIdentity: 10,
    });
    assertEquals(config.functions.logs, { maxBytes: 4_096, retentionFiles: 2 });
    assertEquals(config.logging, { format: "human", maxBytes: 8_192, retentionFiles: 3 });
    assertEquals(config.seed.enabled, false);
    assertEquals(config.metadata.formatVersion, 1);
    assertEquals(config.metadata.sourceFormatVersion, 1);
    assertEquals(config.metadata.migrations, []);
    assertEquals(config.metadata.sources["server.host"], "minibase.toml");
    assertEquals(config.metadata.sources["server.request.max_body_bytes"], "minibase.toml");
    assertEquals(config.metadata.sources["functions.rate_limit.per_ip"], "minibase.toml");
    assertEquals(
      config.metadata.sources["functions.runtime.workers_per_function"],
      "minibase.toml",
    );
    assertEquals(
      config.metadata.sources["functions.echo.rate_limit.per_identity"],
      "minibase.toml",
    );
    assertEquals(config.metadata.sources["server.cors.allowed_origins"], "minibase.toml");
    assertEquals(
      config.metadata.sources["functions.echo.verify_jwt"],
      "supabase/config.toml",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolves Supabase Function entrypoint and import_map inside the Functions boundary", async () => {
  const root = await createFixture();
  try {
    const functionDir = join(root, "supabase", "functions", "generated");
    const entrypoint = join(functionDir, "main.ts");
    const importMap = join(functionDir, "deno.json");
    await Deno.mkdir(functionDir, { recursive: true });
    await Deno.writeTextFile(entrypoint, "export default { fetch: () => new Response('ok') };\n");
    await Deno.writeTextFile(importMap, '{"imports":{}}\n');
    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "fixture"
[functions.generated]
verify_jwt = false
entrypoint = "./functions/generated/main.ts"
import_map = "./functions/generated/deno.json"
`,
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project);
    assertEquals(config.functions.definitions.generated, {
      verifyJwt: false,
      injectServiceRoleKey: true,
      entrypoint,
      importMap,
      network: undefined,
      rateLimit: undefined,
    });
    assertEquals(
      config.metadata.sources["functions.generated.entrypoint"],
      "supabase/config.toml",
    );
    assertEquals(
      config.metadata.sources["functions.generated.import_map"],
      "supabase/config.toml",
    );
    assertEquals(await resolveFunctionFiles(config, "generated"), {
      functionDir,
      entryPath: entrypoint,
      denoConfig: importMap,
      importMap: undefined,
      lockFile: undefined,
    });

    const classicImportMap = join(functionDir, "import_map.json");
    await Deno.writeTextFile(classicImportMap, '{"imports":{}}\n');
    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "fixture"
[functions.generated]
entrypoint = "./functions/generated/main.ts"
import_map = "./functions/generated/import_map.json"
`,
    );
    const classicConfig = await loadConfig(project);
    assertEquals(await resolveFunctionFiles(classicConfig, "generated"), {
      functionDir,
      entryPath: entrypoint,
      denoConfig: importMap,
      importMap: classicImportMap,
      lockFile: undefined,
    });

    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "fixture"
[functions.generated]
entrypoint = "../outside.ts"
`,
    );
    await assertRejects(
      () => loadConfig(project),
      Error,
      "functions.generated.entrypoint must resolve inside",
    );

    const outside = join(root, "outside.ts");
    const linkedEntrypoint = join(functionDir, "linked.ts");
    await Deno.writeTextFile(outside, "export default () => new Response('outside');\n");
    await Deno.symlink(outside, linkedEntrypoint, { type: "file" });
    await Deno.writeTextFile(
      join(root, "supabase", "config.toml"),
      `project_id = "fixture"
[functions.generated]
entrypoint = "./functions/generated/linked.ts"
`,
    );
    await assertRejects(
      () => loadConfig(project),
      Error,
      "functions.generated.entrypoint must not escape",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("request protection limits accept environment overrides and reject unsafe bounds", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {
      MINIBASE_REQUEST_MAX_BODY_BYTES: "2097152",
      MINIBASE_REQUEST_TIMEOUT_MS: "30000",
      MINIBASE_REQUEST_MAX_CONCURRENT: "64",
    });
    assertEquals(config.server.request, {
      maxBodyBytes: 2_097_152,
      timeoutMs: 30_000,
      maxConcurrent: 64,
    });
    for (
      const key of [
        "server.request.max_body_bytes",
        "server.request.timeout_ms",
        "server.request.max_concurrent",
      ]
    ) {
      assertEquals(config.metadata.sources[key], "environment");
    }

    for (
      const [environment, message] of [
        [
          { MINIBASE_REQUEST_MAX_BODY_BYTES: "1023" },
          "server.request.max_body_bytes must be between 1024 and 1073741824",
        ],
        [
          { MINIBASE_REQUEST_TIMEOUT_MS: "99" },
          "server.request.timeout_ms must be between 100 and 3600000",
        ],
        [
          { MINIBASE_REQUEST_MAX_CONCURRENT: "0" },
          "server.request.max_concurrent must be between 1 and 100000",
        ],
        [
          { MINIBASE_REQUEST_MAX_CONCURRENT: "many" },
          "MINIBASE_REQUEST_MAX_CONCURRENT must be an integer",
        ],
      ] as const
    ) {
      await assertRejects(() => loadConfig(project, {}, environment), Error, message);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Function rate limits inherit overrides and reject unsafe bounds", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const defaults = await loadConfig(project, {}, {});
    assertEquals(defaults.functions.rateLimit, {
      windowMs: 60_000,
      perIp: 0,
      perFunction: 0,
      perIdentity: 0,
      maxKeys: 10_000,
    });

    const overridden = await loadConfig(project, {}, {
      MINIBASE_FUNCTIONS_RATE_LIMIT_WINDOW_MS: "15000",
      MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IP: "20",
      MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION: "200",
      MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IDENTITY: "40",
      MINIBASE_FUNCTIONS_RATE_LIMIT_MAX_KEYS: "5000",
    });
    assertEquals(overridden.functions.rateLimit, {
      windowMs: 15_000,
      perIp: 20,
      perFunction: 200,
      perIdentity: 40,
      maxKeys: 5_000,
    });
    assertEquals(
      overridden.metadata.sources["functions.rate_limit.per_identity"],
      "environment",
    );

    for (
      const [environment, message] of [
        [
          { MINIBASE_FUNCTIONS_RATE_LIMIT_WINDOW_MS: "99" },
          "functions.rate_limit.window_ms must be between 100 and 3600000",
        ],
        [
          { MINIBASE_FUNCTIONS_RATE_LIMIT_PER_IP: "-1" },
          "functions.rate_limit.per_ip must be between 0 and 1000000",
        ],
        [
          { MINIBASE_FUNCTIONS_RATE_LIMIT_MAX_KEYS: "99" },
          "functions.rate_limit.max_keys must be between 100 and 1000000",
        ],
        [
          { MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION: "many" },
          "MINIBASE_FUNCTIONS_RATE_LIMIT_PER_FUNCTION must be an integer",
        ],
      ] as const
    ) {
      await assertRejects(() => loadConfig(project, {}, environment), Error, message);
    }

    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[functions.echo.rate_limit]\nper_identity = 1000001\n",
    );
    await assertRejects(
      async () => await loadConfig(await discoverProject(root), {}, {}),
      Error,
      "functions.echo.rate_limit.per_identity must be between 0 and 1000000",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Function worker pool size accepts environment overrides and rejects unsafe bounds", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const defaults = await loadConfig(project, {}, {});
    assertEquals(defaults.functions.runtime, { workersPerFunction: 2 });

    const overridden = await loadConfig(project, {}, {
      MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION: "6",
    });
    assertEquals(overridden.functions.runtime, { workersPerFunction: 6 });
    assertEquals(
      overridden.metadata.sources["functions.runtime.workers_per_function"],
      "environment",
    );

    for (
      const [environment, message] of [
        [
          { MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION: "0" },
          "functions.runtime.workers_per_function must be between 1 and 16",
        ],
        [
          { MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION: "17" },
          "functions.runtime.workers_per_function must be between 1 and 16",
        ],
        [
          { MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION: "many" },
          "MINIBASE_FUNCTIONS_WORKERS_PER_FUNCTION must be an integer",
        ],
      ] as const
    ) {
      await assertRejects(() => loadConfig(project, {}, environment), Error, message);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Function network configuration rejects malformed and ambiguous allowlists", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    for (
      const [configuration, message] of [
        [
          'format_version = 1\n[functions.network]\noutbound = "allowlist"\n' +
          'allowed_hosts = ["*example.com"]\n',
          "allows wildcards only as a leading '*.' rule",
        ],
        [
          'format_version = 1\n[functions.network]\noutbound = "allowlist"\n' +
          'allowed_hosts = ["*.com"]\n',
          "wildcard rules require a registrable-style suffix",
        ],
        [
          'format_version = 1\n[functions.echo.network]\nallowed_hosts = ["api.example.com"]\n',
          'allowed_hosts requires outbound = "allowlist"',
        ],
      ] as const
    ) {
      await Deno.writeTextFile(file, configuration);
      await assertRejects(
        async () => await loadConfig(await discoverProject(root), {}, {}),
        Error,
        message,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("logging configuration supports formats, environment overrides and bounded rotation", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const defaults = await loadConfig(project, {}, {});
    assertEquals(defaults.logging, {
      format: "json",
      maxBytes: 10 * 1024 * 1024,
      retentionFiles: 5,
    });
    assertEquals(defaults.functions.logs, { maxBytes: 10 * 1024 * 1024, retentionFiles: 5 });

    const overridden = await loadConfig(project, {}, {
      MINIBASE_LOG_FORMAT: "human",
      MINIBASE_LOG_MAX_BYTES: "4096",
      MINIBASE_LOG_RETENTION_FILES: "1",
      MINIBASE_FUNCTION_LOG_MAX_BYTES: "2048",
      MINIBASE_FUNCTION_LOG_RETENTION_FILES: "0",
    });
    assertEquals(overridden.logging, { format: "human", maxBytes: 4_096, retentionFiles: 1 });
    assertEquals(overridden.functions.logs, { maxBytes: 2_048, retentionFiles: 0 });
    assertEquals(overridden.metadata.sources["logging.format"], "environment");
    assertEquals(
      overridden.metadata.sources["logging.functions.max_bytes"],
      "environment",
    );

    const file = join(root, "minibase.toml");
    for (
      const [configuration, message] of [
        [
          'format_version = 1\n[logging]\nformat = "pretty"\n',
          "logging.format must be human or json",
        ],
        [
          "format_version = 1\n[logging]\nmax_bytes = 1023\n",
          "logging.max_bytes must be between 1024 and 1073741824",
        ],
        [
          "format_version = 1\n[logging]\nretention_files = 101\n",
          "logging.retention_files must be between 0 and 100",
        ],
        [
          "format_version = 1\n[logging.functions]\nmax_bytes = 1023\n",
          "max_bytes must be between 1024 and 1073741824",
        ],
        [
          "format_version = 1\n[logging.functions]\nretention_files = 101\n",
          "retention_files must be between 0 and 100",
        ],
        [
          "format_version = 1\n[logging.functions]\nmax_bytes = 1.5\n",
          "max_bytes must be an integer",
        ],
      ] as const
    ) {
      await Deno.writeTextFile(file, configuration);
      await assertRejects(
        async () => await loadConfig(await discoverProject(root), {}, {}),
        Error,
        message,
      );
    }
    await assertRejects(
      () =>
        loadConfig(project, {}, {
          MINIBASE_FUNCTION_LOG_MAX_BYTES: "invalid",
        }),
      Error,
      "MINIBASE_FUNCTION_LOG_MAX_BYTES must be an integer",
    );
    await assertRejects(
      () => loadConfig(project, {}, { MINIBASE_LOG_FORMAT: "pretty" }),
      Error,
      "MINIBASE_LOG_FORMAT must be human or json",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("S3 configuration validates endpoints, credentials and path style without exposing values", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const environment = {
      MINIBASE_S3_ENDPOINT: "https://objects.example.test/base",
      MINIBASE_S3_REGION: "auto",
      MINIBASE_S3_BUCKET: "root-bucket",
      MINIBASE_S3_ACCESS_KEY_ID: "s3-access-never-metadata",
      MINIBASE_S3_SECRET_ACCESS_KEY: "s3-secret-never-metadata",
      MINIBASE_S3_SESSION_TOKEN: "s3-session-never-metadata",
      MINIBASE_S3_PATH_STYLE: "false",
    };
    const config = await loadConfig(project, { storageDriver: "s3" }, environment);
    assertEquals(config.storage.s3?.pathStyle, false);
    assertEquals(config.storage.s3?.endpoint, environment.MINIBASE_S3_ENDPOINT);
    const metadata = JSON.stringify(config.metadata);
    for (
      const credential of [
        environment.MINIBASE_S3_ACCESS_KEY_ID,
        environment.MINIBASE_S3_SECRET_ACCESS_KEY,
        environment.MINIBASE_S3_SESSION_TOKEN,
      ]
    ) {
      assertEquals(metadata.includes(credential), false);
    }

    for (
      const [override, message] of [
        [
          { MINIBASE_S3_ENDPOINT: "https://user:password@objects.example.test" },
          "without credentials, query or fragment",
        ],
        [
          { MINIBASE_S3_BUCKET: "invalid/bucket" },
          "must be a valid bucket name",
        ],
        [
          { MINIBASE_S3_PATH_STYLE: "sometimes" },
          "MINIBASE_S3_PATH_STYLE must be true, false, 1 or 0",
        ],
        [
          { MINIBASE_S3_SESSION_TOKEN: "" },
          "storage.s3.session_token must not be blank",
        ],
      ] as const
    ) {
      await assertRejects(
        () => loadConfig(project, { storageDriver: "s3" }, { ...environment, ...override }),
        Error,
        message,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("external Secret files provide credential-only values with environment precedence", async () => {
  const root = await createFixture();
  const databaseUrl = "postgres://minibase:external-db-secret@db.example.test/minibase";
  const s3AccessKey = "external-s3-access-key";
  const s3SecretKey = "external-s3-secret-key-7Xq4mN2v";
  const s3SessionToken = "external-s3-session-token-9cR6tY3a";
  const authSecret = "external-auth-secret-8dF5hJ1kL0pQ2wE4rT6yU7iO";
  try {
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      [
        "format_version = 1",
        "[secrets]",
        'file = "private.env"',
        "[database]",
        'engine = "postgres"',
        "managed = false",
        "[storage]",
        'driver = "s3"',
        "[storage.s3]",
        'endpoint = "https://objects.example.test"',
        'region = "auto"',
        'bucket = "external-secret-test"',
      ].join("\n") + "\n",
    );
    const secretFile = join(root, "private.env");
    await Deno.writeTextFile(
      secretFile,
      [
        `MINIBASE_DATABASE_URL=${databaseUrl}`,
        `MINIBASE_S3_ACCESS_KEY_ID=${s3AccessKey}`,
        `MINIBASE_S3_SECRET_ACCESS_KEY=${s3SecretKey}`,
        `MINIBASE_S3_SESSION_TOKEN=${s3SessionToken}`,
        `MINIBASE_AUTH_JWT_SECRET=${authSecret}`,
      ].join("\n") + "\n",
    );

    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.secrets.file, secretFile);
    assertEquals(config.database.url, databaseUrl);
    assertEquals(config.storage.s3?.accessKeyId, s3AccessKey);
    assertEquals(config.storage.s3?.secretAccessKey, s3SecretKey);
    assertEquals(config.storage.s3?.sessionToken, s3SessionToken);
    assertEquals(config.auth.jwtSecret, authSecret);
    for (
      const key of [
        "database.url",
        "storage.s3.access_key_id",
        "storage.s3.secret_access_key",
        "storage.s3.session_token",
        "auth.jwt_secret",
      ]
    ) {
      assertEquals(config.metadata.sources[key], "secrets-file");
    }
    const metadata = JSON.stringify(config.metadata);
    for (const secret of [databaseUrl, s3AccessKey, s3SecretKey, s3SessionToken, authSecret]) {
      assertEquals(metadata.includes(secret), false, secret);
    }

    const environmentOverride = "environment-s3-secret-4mN2vP9cR6tY3";
    const overridden = await loadConfig(project, {}, {
      MINIBASE_S3_SECRET_ACCESS_KEY: environmentOverride,
    });
    assertEquals(overridden.storage.s3?.secretAccessKey, environmentOverride);
    assertEquals(overridden.metadata.sources["storage.s3.secret_access_key"], "environment");

    const environmentAuthOverride = "environment-auth-secret-2wE4rT6yU7iO8dF5hJ1kL0pQ";
    const authOverridden = await loadConfig(project, {}, {
      MINIBASE_AUTH_JWT_SECRET: environmentAuthOverride,
    });
    assertEquals(authOverridden.auth.jwtSecret, environmentAuthOverride);
    assertEquals(authOverridden.metadata.sources["auth.jwt_secret"], "environment");

    await Deno.writeTextFile(secretFile, "MINIBASE_PORT=60000\n");
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "secrets.file contains unsupported variable MINIBASE_PORT",
    );
    await assertRejects(
      () => loadConfig(project, {}, { MINIBASE_SECRETS_FILE: "" }),
      Error,
      "MINIBASE_SECRETS_FILE must not be blank",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("external Secret files reject missing, non-file, oversized and short Auth inputs", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    await assertRejects(
      () =>
        loadConfig(project, {}, {
          MINIBASE_SECRETS_FILE: join(root, "missing.env"),
        }),
      Deno.errors.NotFound,
    );

    const directory = join(root, "secret-directory");
    await Deno.mkdir(directory);
    await assertRejects(
      () => loadConfig(project, {}, { MINIBASE_SECRETS_FILE: directory }),
      Error,
      "secrets.file must reference a regular file",
    );

    const oversized = join(root, "oversized.env");
    await Deno.writeFile(oversized, new Uint8Array(1024 * 1024 + 1));
    await assertRejects(
      () => loadConfig(project, {}, { MINIBASE_SECRETS_FILE: oversized }),
      Error,
      "secrets.file must not exceed 1 MiB",
    );

    const shortAuth = join(root, "short-auth.env");
    await Deno.writeTextFile(shortAuth, "MINIBASE_AUTH_JWT_SECRET=too-short\n");
    await assertRejects(
      () => loadConfig(project, {}, { MINIBASE_SECRETS_FILE: shortAuth }),
      Error,
      "MINIBASE_AUTH_JWT_SECRET must be at least 32 characters",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CORS configuration accepts HTTP origins and rejects URLs with paths", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    await Deno.writeTextFile(
      file,
      "format_version = 1\n[server.cors]\n" +
        'allowed_origins = ["http://127.0.0.1:3000/", "https://app.example:443"]\n',
    );
    const project = await discoverProject(root);
    assertEquals(
      (await loadConfig(project, {}, {})).server.cors.allowedOrigins,
      ["http://127.0.0.1:3000", "https://app.example"],
    );

    await Deno.writeTextFile(
      file,
      'format_version = 1\n[server.cors]\nallowed_origins = ["https://app.example/path"]\n',
    );
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "must contain HTTP(S) origins",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("TLS configuration resolves project paths and requires a certificate pair", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    await Deno.writeTextFile(
      file,
      'format_version = 1\n[server.tls]\ncert_file = "cert.pem"\nkey_file = "key.pem"\n',
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.server.tls, {
      certFile: join(root, "cert.pem"),
      keyFile: join(root, "key.pem"),
    });
    assertEquals(config.server.publicUrl, "https://127.0.0.1:55432");

    await Deno.writeTextFile(
      file,
      'format_version = 1\n[server.tls]\ncert_file = "cert.pem"\n',
    );
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "requires both cert_file and key_file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("trusted proxy configuration accepts IP ranges and rejects hostnames", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    await Deno.writeTextFile(
      file,
      'format_version = 1\n[server]\ntrusted_proxies = ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]\n',
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.server.trustedProxies, [
      "127.0.0.1",
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);

    const overridden = await loadConfig(project, {}, {
      MINIBASE_TRUSTED_PROXIES: "192.0.2.10, 2001:db8:ffff::/48",
    });
    assertEquals(overridden.server.trustedProxies, ["192.0.2.10", "2001:db8:ffff::/48"]);

    await Deno.writeTextFile(
      file,
      'format_version = 1\n[server]\ntrusted_proxies = ["proxy.internal"]\n',
    );
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "invalid IP or CIDR",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("configures anonymous cleanup conservatively and validates its bounds", async () => {
  const root = await createFixture();
  try {
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[auth.anonymous_cleanup]\n" +
        "enabled = true\nretention_hours = 48\ninterval_minutes = 15\nbatch_size = 25\n",
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.auth.anonymousCleanup, {
      enabled: true,
      retentionHours: 48,
      intervalMinutes: 15,
      batchSize: 25,
    });
    assertEquals(config.metadata.sources["auth.anonymous_cleanup.enabled"], "minibase.toml");

    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[auth.anonymous_cleanup]\ninterval_minutes = 0\n",
    );
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "interval_minutes must be at least one minute",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("configures Auth password, reauthentication, rate limits and audit retention", async () => {
  const root = await createFixture();
  try {
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n" +
        "[auth]\nreauthentication_window_seconds = 120\n" +
        "[auth.password]\nmin_length = 14\nmax_length = 128\n" +
        "[auth.rate_limit]\nwindow_ms = 30000\nsignup_per_ip = 3\n" +
        "password_per_ip = 7\nrefresh_per_ip = 11\nupdate_per_ip = 5\n" +
        "update_per_identity = 2\nmax_keys = 500\n" +
        "[auth.audit_log]\ncleanup_enabled = true\nretention_days = 45\n" +
        "interval_minutes = 30\nbatch_size = 250\n",
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    assertEquals(config.auth.passwordPolicy, { minLength: 14, maxLength: 128 });
    assertEquals(config.auth.reauthenticationWindowSeconds, 120);
    assertEquals(config.auth.rateLimit, {
      windowMs: 30_000,
      signupPerIp: 3,
      passwordPerIp: 7,
      refreshPerIp: 11,
      updatePerIp: 5,
      updatePerIdentity: 2,
      maxKeys: 500,
    });
    assertEquals(config.auth.auditLog, {
      cleanupEnabled: true,
      retentionDays: 45,
      intervalMinutes: 30,
      batchSize: 250,
    });
    assertEquals(config.metadata.sources["auth.password.min_length"], "minibase.toml");
    assertEquals(config.metadata.sources["auth.rate_limit.password_per_ip"], "minibase.toml");
    assertEquals(config.metadata.sources["auth.audit_log.retention_days"], "minibase.toml");

    const environment = await loadConfig(project, {}, {
      MINIBASE_AUTH_PASSWORD_MIN_LENGTH: "16",
      MINIBASE_AUTH_REAUTHENTICATION_WINDOW_SECONDS: "60",
      MINIBASE_AUTH_RATE_LIMIT_PASSWORD_PER_IP: "9",
      MINIBASE_AUTH_AUDIT_LOG_RETENTION_DAYS: "30",
    });
    assertEquals(environment.auth.passwordPolicy.minLength, 16);
    assertEquals(environment.auth.reauthenticationWindowSeconds, 60);
    assertEquals(environment.auth.rateLimit.passwordPerIp, 9);
    assertEquals(environment.auth.auditLog.retentionDays, 30);

    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[auth.password]\nmin_length = 20\nmax_length = 10\n",
    );
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "max_length must be between min_length and 1024",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("environment and CLI values override project files", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    const config = await loadConfig(
      project,
      { port: 60_001, engine: "postgres" },
      {
        MINIBASE_HOST: "192.0.2.10",
        MINIBASE_PORT: "60000",
        MINIBASE_S3_SECRET_ACCESS_KEY: "must-not-appear-in-metadata",
      },
    );
    assertEquals(config.server.host, "192.0.2.10");
    assertEquals(config.server.port, 60_001);
    assertEquals(config.database.engine, "postgres");
    assertEquals(config.metadata.sources["server.host"], "environment");
    assertEquals(config.metadata.sources["server.port"], "cli");
    assertEquals(config.metadata.sources["database.engine"], "cli");
    assertEquals(
      JSON.stringify(config.metadata).includes("must-not-appear-in-metadata"),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy Minibase config migrates in memory and future formats are rejected", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    await Deno.writeTextFile(file, '[server]\nhost = "127.0.0.2"\n');
    const project = await discoverProject(root);
    const migrated = await loadConfig(project, {}, {});
    assertEquals(migrated.metadata.formatVersion, 1);
    assertEquals(migrated.metadata.sourceFormatVersion, 0);
    assertEquals(migrated.metadata.migrations, [
      "0->1: normalize legacy unversioned minibase.toml",
    ]);
    assertEquals(migrated.server.host, "127.0.0.2");

    await Deno.writeTextFile(file, "format_version = 2\n");
    await assertRejects(
      () => loadConfig(project, {}, {}),
      Error,
      "newer than supported version 1",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("database pool limits reject invalid configurations", async () => {
  const root = await createFixture();
  try {
    const file = join(root, "minibase.toml");
    await Deno.writeTextFile(
      file,
      "format_version = 1\n[database]\npool_min = 5\npool_max = 2\n",
    );
    const project = await discoverProject(root);
    await assertRejects(
      () => loadConfig(project),
      Error,
      "database.pool_min must not exceed database.pool_max",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("seed can be disabled for reset without changing Supabase seed.sql", async () => {
  const root = await createFixture();
  let engine: PGliteEngine | null = null;
  try {
    await Deno.writeTextFile(
      join(root, "minibase.toml"),
      "format_version = 1\n[seed]\nenabled = false\n",
    );
    const project = await discoverProject(root);
    const config = await loadConfig(project, {}, {});
    const reset = await resetProject(config, true);
    assertEquals(reset.seedApplied, false);
    assertEquals(await Deno.readTextFile(project.seedFile!), "select 1;\n");

    engine = new PGliteEngine(project.pgliteDataDir);
    await engine.start();
    const history = await engine.query<{ count: number }>(
      "select count(*)::int as count from minibase_meta.seed_history",
    );
    assertEquals(history.rows[0]?.count, 0);
  } finally {
    await engine?.close().catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("engine marker prevents opening the same data with another engine", async () => {
  const root = await createFixture();
  try {
    const project = await discoverProject(root);
    await prepareProject(project, "pglite");
    assertEquals((await readProjectState(project))?.engine, "pglite");
    await assertRejects(
      () => prepareProject(project, "postgres"),
      Error,
      "Export and import data before switching engines",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

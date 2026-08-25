export interface ProjectPaths {
  root: string;
  supabaseDir: string;
  supabaseConfigFile: string | null;
  migrationsDir: string;
  functionsDir: string;
  seedFile: string | null;
  minibaseConfigFile: string | null;
  minibaseDir: string;
  stateFile: string;
  runtimeFile: string;
  secretsFile: string;
  storageDir: string;
  logsDir: string;
  cacheDir: string;
  pgliteDataDir: string;
  postgresDataDir: string;
  backupsDir: string;
}

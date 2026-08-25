export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticResult {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  fix?: string;
  file?: string;
  line?: number;
  column?: number;
}

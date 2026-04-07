/**
 * Access Gate — Privilege Boundary Enforcement
 * =============================================
 *
 * Detects when an agent's edits or predicates reference resources that require
 * elevated privileges the agent doesn't have. This is a cross-cutting analysis
 * gate — it scans ALL edits and predicates for access boundary violations.
 *
 * Five violation categories:
 *   path_traversal       — references to paths outside the app directory
 *   privileged_port      — binding to ports below 1024 (requires root)
 *   permission_escalation — chmod 777, sudo, GRANT ALL, Docker socket access
 *   cross_origin         — predicates referencing foreign hosts/origins
 *   environment_escalation — Dockerfile USER root, --privileged, --cap-add
 *
 * Runs after F9 (edits applied) and before staging.
 * No Docker required. Pure filesystem reads.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, extname, resolve, normalize, isAbsolute } from 'path';
import type { GateResult, GateContext, Edit, Predicate } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

export type AccessViolationType =
  | 'path_traversal'
  | 'privileged_port'
  | 'permission_escalation'
  | 'cross_origin'
  | 'environment_escalation';

export interface AccessViolation {
  type: AccessViolationType;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  detail: string;
}

export interface AccessGateResult extends GateResult {
  violations: AccessViolation[];
}

// =============================================================================
// SYSTEM PATH PATTERNS
// =============================================================================

/**
 * System paths that are ALWAYS dangerous when combined with user input.
 * These only fire when the line also contains a user input source.
 * Hardcoded system paths without user input are demoted to warnings (below).
 */
const DANGEROUS_SYSTEM_PATHS: Array<{ regex: RegExp; detail: string }> = [
  { regex: /\/etc\/(?:passwd|shadow|sudoers|hosts)/g, detail: 'References sensitive system file' },
  { regex: /~\/\.ssh\//g, detail: 'References SSH credentials directory' },
  { regex: /\/home\/[^/]+\/\.ssh\//g, detail: 'References user SSH directory' },
  { regex: /\/proc\/self\//g, detail: 'References /proc/self/ (process introspection)' },
  { regex: /C:\\Users\\[^\\]+\\\.ssh/gi, detail: 'References Windows SSH directory' },
];

/**
 * User input sources — when these appear on the same line as a file operation
 * or system path, it's a real path traversal risk.
 */
const USER_INPUT_PATTERN = /(?:req\.|params\.|body\.|query\.|args\.|process\.argv|request\.|ctx\.|context\.)/;

/**
 * File operation functions — readFile, writeFile, open, exec, etc.
 * When combined with user input, these are path traversal vectors.
 */
const FILE_OP_WITH_INPUT = /(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|open|openSync|unlink|unlinkSync|stat|statSync|access|accessSync|exec|execSync|spawn)\s*\(\s*(?:req\.|params\.|body\.|query\.|args\.|process\.argv)/g;

/** Absolute paths that indicate system file access — only flag as error with user input. */
const SYSTEM_PATH_PATTERNS: Array<{ regex: RegExp; detail: string }> = [
  { regex: /\/etc\//g, detail: 'References /etc/ (system configuration)' },
  { regex: /\/var\/log\//g, detail: 'References /var/log/ (system logs)' },
  { regex: /\/var\/run\//g, detail: 'References /var/run/ (runtime state)' },
  { regex: /\/proc\//g, detail: 'References /proc/ (kernel process info)' },
  { regex: /\/sys\//g, detail: 'References /sys/ (kernel parameters)' },
  { regex: /\/root\//g, detail: 'References /root/ (root home directory)' },
  { regex: /\/usr\/local\/bin\//g, detail: 'References /usr/local/bin/ (system binaries)' },
  { regex: /\/tmp\//g, detail: 'References /tmp/ (shared temporary directory)' },
  { regex: /C:\\Windows\\/gi, detail: 'References C:\\Windows\\ (Windows system directory)' },
  { regex: /C:\\Program Files/gi, detail: 'References C:\\Program Files (Windows programs)' },
];

/** Docker socket and sensitive mount patterns. */
const DOCKER_SOCKET_PATTERNS: Array<{ regex: RegExp; detail: string }> = [
  { regex: /\/var\/run\/docker\.sock/g, detail: 'Docker socket access (container escape risk)' },
  { regex: /docker\.sock/g, detail: 'Docker socket reference' },
];

// =============================================================================
// PRIVILEGE ESCALATION PATTERNS
// =============================================================================

const PERMISSION_PATTERNS: Array<{ regex: RegExp; detail: string; severity: 'error' | 'warning' }> = [
  { regex: /\bchmod\s+777\b/g, detail: 'chmod 777 — world-writable permissions', severity: 'warning' },
  { regex: /\bchmod\s+[0-7]*[67][0-7]{2}\b/g, detail: 'chmod with overly permissive bits', severity: 'warning' },
  { regex: /\bchown\s+root\b/g, detail: 'chown root — changes file ownership to root', severity: 'error' },
  { regex: /\bsudo\s+/g, detail: 'sudo usage — requires elevated privileges', severity: 'error' },
  { regex: /\bGRANT\s+ALL\b/gi, detail: 'GRANT ALL — grants unrestricted database permissions', severity: 'error' },
  { regex: /\bGRANT\s+SUPERUSER\b/gi, detail: 'GRANT SUPERUSER — grants database superuser', severity: 'error' },
  { regex: /\bALTER\s+ROLE\s+\w+\s+SUPERUSER\b/gi, detail: 'ALTER ROLE SUPERUSER — elevates database role', severity: 'error' },
];

// =============================================================================
// ENVIRONMENT ESCALATION PATTERNS (Dockerfile / docker-compose)
// =============================================================================

const ENV_ESCALATION_PATTERNS: Array<{ regex: RegExp; detail: string; severity: 'error' | 'warning' }> = [
  { regex: /\bUSER\s+root\b/g, detail: 'Dockerfile USER root — container runs as root', severity: 'error' },
  { regex: /--privileged/g, detail: '--privileged flag — disables container isolation', severity: 'error' },
  { regex: /--cap-add\s*=?\s*\w+/g, detail: '--cap-add — adds Linux capabilities to container', severity: 'warning' },
  { regex: /cap_add:/g, detail: 'cap_add in compose — adds Linux capabilities', severity: 'warning' },
  { regex: /\bSYS_ADMIN\b/g, detail: 'SYS_ADMIN capability — near-root access in container', severity: 'error' },
  { regex: /\bSYS_PTRACE\b/g, detail: 'SYS_PTRACE capability — process tracing access', severity: 'warning' },
  { regex: /\bNET_ADMIN\b/g, detail: 'NET_ADMIN capability — network configuration access', severity: 'warning' },
  { regex: /\bNET_RAW\b/g, detail: 'NET_RAW capability — raw socket access', severity: 'warning' },
  { regex: /privileged:\s*true/g, detail: 'privileged: true in compose — disables container isolation', severity: 'error' },
  { regex: /security_opt:\s*\n?\s*-\s*seccomp:unconfined/g, detail: 'seccomp:unconfined — disables syscall filtering', severity: 'error' },
  { regex: /pid:\s*["']?host["']?/g, detail: 'pid: host — shares host PID namespace', severity: 'error' },
  { regex: /network_mode:\s*["']?host["']?/g, detail: 'network_mode: host — container shares host network', severity: 'warning' },
];

// =============================================================================
// PORT DETECTION
// =============================================================================

const PRIVILEGED_PORT_PATTERNS: Array<{ regex: RegExp; extract: (match: RegExpExecArray) => number | null }> = [
  {
    regex: /(?:listen|port|PORT)\s*(?:=|:)\s*(\d+)/g,
    extract: (m) => parseInt(m[1], 10),
  },
  {
    regex: /\.listen\s*\(\s*(\d+)/g,
    extract: (m) => parseInt(m[1], 10),
  },
  {
    regex: /(?:ports|expose)\s*:\s*\n?\s*-\s*["']?(\d+):/gm,
    extract: (m) => parseInt(m[1], 10),
  },
  {
    regex: /-p\s+(\d+):/g,
    extract: (m) => parseInt(m[1], 10),
  },
];

// =============================================================================
// CROSS-ORIGIN DETECTION
// =============================================================================

/**
 * Extracts host/origin from a URL string. Returns null if not a valid URL.
 */
function extractOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Checks if a predicate references a foreign origin.
 * Returns the foreign origin string if detected, null otherwise.
 */
function detectCrossOrigin(pred: Predicate, appDomain: string | undefined): string | null {
  // Check path field for full URLs
  if (pred.path && /^https?:\/\//i.test(pred.path)) {
    const origin = extractOrigin(pred.path);
    if (origin && appDomain) {
      const appOrigin = extractOrigin(appDomain);
      if (appOrigin && origin !== appOrigin) {
        return origin;
      }
    }
    // If no appDomain to compare, any absolute URL is suspicious
    if (origin && !appDomain) {
      return origin;
    }
  }

  // Check HTTP predicate steps for foreign hosts
  if (pred.steps) {
    for (const step of pred.steps) {
      if (/^https?:\/\//i.test(step.path)) {
        const origin = extractOrigin(step.path);
        if (origin) return origin;
      }
    }
  }

  return null;
}

// =============================================================================
// PATH TRAVERSAL IN EDITS
// =============================================================================

/**
 * Detect path traversal in edit file targets.
 * An edit targeting a file outside the app directory is a traversal.
 */
function checkEditPathTraversal(edit: Edit, appDir: string): string | null {
  const filePath = edit.file;

  // Absolute paths are always suspicious
  if (isAbsolute(filePath)) {
    return `Edit targets absolute path: ${filePath}`;
  }

  // Normalize and check for directory escape
  const normalized = normalize(filePath);
  if (normalized.startsWith('..')) {
    return `Edit escapes app directory: ${filePath}`;
  }

  // Resolve to catch tricky traversals like "foo/../../etc/passwd"
  const resolved = resolve(appDir, filePath);
  const resolvedAppDir = resolve(appDir);
  if (!resolved.startsWith(resolvedAppDir)) {
    return `Edit resolves outside app directory: ${filePath} -> ${resolved}`;
  }

  return null;
}

// =============================================================================
// FILE SCANNING
// =============================================================================

const CODE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.html', '.htm', '.ejs', '.hbs',
  '.yml', '.yaml',
  '.json',
  '.sh', '.bash',
  '.sql',
  '.py', '.rb', '.go',
]);

const DOCKER_FILES = new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);

interface SourceFile {
  relativePath: string;
  content: string;
  lines: string[];
}

/**
 * Read source files from a directory for scanning.
 */
function readSourceFiles(appDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (CODE_EXTS.has(extname(entry.name).toLowerCase()) || DOCKER_FILES.has(entry.name)) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
            files.push({ relativePath, content, lines: content.split('\n') });
          } catch { /* unreadable */ }
        }
      }
    } catch { /* unreadable dir */ }
  }

  scan(appDir, '');
  return files;
}

// =============================================================================
// SCANNERS
// =============================================================================

/**
 * Scan source files for system path references.
 */
function scanSystemPaths(files: SourceFile[]): AccessViolation[] {
  const violations: AccessViolation[] = [];

  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      // Skip comments
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      const hasUserInput = USER_INPUT_PATTERN.test(line);

      // Priority 1: File operation with user input → always error (real path traversal)
      FILE_OP_WITH_INPUT.lastIndex = 0;
      if (FILE_OP_WITH_INPUT.test(line)) {
        violations.push({
          type: 'path_traversal',
          severity: 'error',
          file: file.relativePath,
          line: i + 1,
          detail: 'User input in file operation (path traversal risk)',
        });
        continue; // don't double-count
      }

      // Priority 2: Dangerous system paths (sensitive files) → error if user input, warning otherwise
      for (const { regex, detail } of DANGEROUS_SYSTEM_PATHS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: 'path_traversal',
            severity: hasUserInput ? 'error' : 'warning',
            file: file.relativePath,
            line: i + 1,
            detail: hasUserInput ? `${detail} — with user input (path traversal)` : `${detail} (hardcoded, low risk)`,
          });
        }
      }

      // Priority 3: General system paths → only flag as error when user input is present
      // Without user input, hardcoded /tmp/ or /etc/ references are normal in many codebases
      if (hasUserInput) {
        for (const { regex, detail } of SYSTEM_PATH_PATTERNS) {
          regex.lastIndex = 0;
          if (regex.test(line)) {
            violations.push({
              type: 'path_traversal',
              severity: 'error',
              file: file.relativePath,
              line: i + 1,
              detail: `${detail} — with user input`,
            });
          }
        }
      }

      // Docker socket patterns are always errors regardless of context
      for (const { regex, detail } of DOCKER_SOCKET_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: 'permission_escalation',
            severity: 'error',
            file: file.relativePath,
            line: i + 1,
            detail,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Scan source files for privileged port binding.
 */
function scanPrivilegedPorts(files: SourceFile[]): AccessViolation[] {
  const violations: AccessViolation[] = [];

  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];

      for (const { regex, extract } of PRIVILEGED_PORT_PATTERNS) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const port = extract(match);
          if (port !== null && port > 0 && port < 1024) {
            violations.push({
              type: 'privileged_port',
              severity: 'warning',
              file: file.relativePath,
              line: i + 1,
              detail: `Port ${port} requires root (ports below 1024 are privileged)`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Scan source files for permission escalation patterns.
 */
function scanPermissionEscalation(files: SourceFile[]): AccessViolation[] {
  const violations: AccessViolation[] = [];

  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      for (const { regex, detail, severity } of PERMISSION_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: 'permission_escalation',
            severity,
            file: file.relativePath,
            line: i + 1,
            detail,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Scan Dockerfiles and compose files for environment escalation.
 */
function scanEnvironmentEscalation(files: SourceFile[]): AccessViolation[] {
  const violations: AccessViolation[] = [];

  // Only scan Docker-related files
  const dockerFiles = files.filter(f => {
    const name = f.relativePath.split('/').pop() ?? '';
    return DOCKER_FILES.has(name) || name.endsWith('.yml') || name.endsWith('.yaml');
  });

  for (const file of dockerFiles) {
    for (let i = 0; i < file.lines.length; i++) {
      const line = file.lines[i];

      for (const { regex, detail, severity } of ENV_ESCALATION_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          violations.push({
            type: 'environment_escalation',
            severity,
            file: file.relativePath,
            line: i + 1,
            detail,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Scan edits for path traversal (file targets and content).
 */
function scanEditPaths(edits: Edit[], appDir: string): AccessViolation[] {
  const violations: AccessViolation[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    // Check edit file target
    const traversal = checkEditPathTraversal(edit, appDir);
    if (traversal) {
      violations.push({
        type: 'path_traversal',
        severity: 'error',
        file: edit.file,
        line: 0,
        detail: traversal,
      });
    }

    // Check edit replace content for system paths
    const content = edit.replace;
    for (const { regex, detail } of SYSTEM_PATH_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        violations.push({
          type: 'path_traversal',
          severity: 'error',
          file: edit.file,
          line: 0,
          detail: `Edit replacement introduces: ${detail}`,
        });
      }
    }

    // Check edit replace content for Docker socket
    for (const { regex, detail } of DOCKER_SOCKET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(content)) {
        violations.push({
          type: 'permission_escalation',
          severity: 'error',
          file: edit.file,
          line: 0,
          detail: `Edit replacement introduces: ${detail}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Scan predicates for cross-origin references.
 */
function scanPredicateCrossOrigin(predicates: Predicate[], appUrl: string | undefined): AccessViolation[] {
  const violations: AccessViolation[] = [];

  for (let i = 0; i < predicates.length; i++) {
    const pred = predicates[i];
    const foreignOrigin = detectCrossOrigin(pred, appUrl);
    if (foreignOrigin) {
      violations.push({
        type: 'cross_origin',
        severity: 'warning',
        file: `predicate[${i}]`,
        line: 0,
        detail: `Predicate references foreign origin: ${foreignOrigin}`,
      });
    }
  }

  return violations;
}

// =============================================================================
// ACCESS GATE
// =============================================================================

/**
 * Run the access gate — scans edits, predicates, and post-edit source files
 * for privilege boundary violations.
 *
 * Fails if any error-severity violations are found.
 * Passes with warnings if only warning-severity violations exist.
 */
export function runAccessGate(ctx: GateContext): AccessGateResult {
  const start = Date.now();
  const violations: AccessViolation[] = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;
  const appUrl = ctx.config.appUrl ?? ctx.appUrl;

  // 1. Scan edit file paths and replacement content
  violations.push(...scanEditPaths(ctx.edits, baseDir));

  // 2. Scan predicates for cross-origin references
  violations.push(...scanPredicateCrossOrigin(ctx.predicates, appUrl));

  // 3. Scan NEW content introduced by edits only (not pre-existing code)
  // This prevents false positives from pre-existing patterns in the codebase.
  // GC-652: Skip type definitions — .d.ts and types files aren't runtime code
  const sourceFiles: SourceFile[] = [];
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    if (edit.file.endsWith('.d.ts') || edit.file.includes('types.ts') || edit.file.includes('types/')) continue;
    sourceFiles.push({
      relativePath: edit.file,
      content: edit.replace,
      lines: edit.replace.split('\n'),
    });
  }

  violations.push(...scanSystemPaths(sourceFiles));
  violations.push(...scanPrivilegedPorts(sourceFiles));
  violations.push(...scanPermissionEscalation(sourceFiles));
  violations.push(...scanEnvironmentEscalation(sourceFiles));

  // Classify outcome
  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');
  const passed = errors.length === 0;

  let detail: string;
  if (violations.length === 0) {
    detail = 'No access violations detected';
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeViolations(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeViolations(errors)}`;
  }

  ctx.log(`[access] ${detail}`);

  return {
    gate: 'access' as any,
    passed,
    detail,
    durationMs: Date.now() - start,
    violations,
  };
}

/**
 * Summarize violations into a compact string for the detail field.
 */
function summarizeViolations(violations: AccessViolation[]): string {
  // Group by type
  const byType = new Map<string, number>();
  for (const v of violations) {
    byType.set(v.type, (byType.get(v.type) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [type, count] of byType) {
    parts.push(`${count}× ${type.replace(/_/g, ' ')}`);
  }
  return parts.join(', ');
}

/**
 * Check if a predicate type is handled by the access gate.
 * The access gate is cross-cutting — it checks all predicates, not just specific types.
 */
export function isAccessRelevant(_p: Predicate): boolean {
  // Access gate scans all predicates for cross-origin issues
  return true;
}

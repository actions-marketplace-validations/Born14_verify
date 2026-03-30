/**
 * Capacity Gate — Resource Exhaustion Detection
 * =============================================
 *
 * Detects when an agent's edits would exhaust or exceed system resource limits.
 * This is a cross-cutting analysis gate — it scans ALL edited source files for
 * patterns that could lead to unbounded resource consumption.
 *
 * Five violation categories:
 *   unbounded_query       — SQL SELECT without LIMIT (table scans)
 *   missing_pagination    — API route handlers returning DB results without pagination
 *   memory_accumulation   — Unbounded in-memory data growth (global push, growing Maps)
 *   disk_growth           — Write operations inside loops/intervals without rotation
 *   connection_exhaustion — DB/Redis connections opened per-request instead of pooled
 *
 * Runs after F9 (edits applied) and before staging.
 * No Docker required. Pure filesystem reads.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { GateResult, GateContext, Edit } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

export type CapacityViolationType =
  | 'unbounded_query'
  | 'missing_pagination'
  | 'memory_accumulation'
  | 'disk_growth'
  | 'connection_exhaustion';

export interface CapacityViolation {
  type: CapacityViolationType;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  detail: string;
}

export interface CapacityGateResult extends GateResult {
  violations: CapacityViolation[];
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Safely read a file from stageDir. Returns null if unreadable.
 */
function safeRead(baseDir: string, relativePath: string): string | null {
  try {
    const fullPath = join(baseDir, relativePath);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if a line is a comment (JS/TS/SQL/Python single-line comments).
 */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith('/*')
  );
}

/**
 * Check if a string appears to be within a string literal (rough heuristic).
 * We don't skip strings — SQL in template literals is real SQL.
 */

// =============================================================================
// 1. UNBOUNDED QUERY DETECTOR
// =============================================================================

/**
 * SQL SELECT without LIMIT/TOP/FETCH FIRST — potential table scan.
 *
 * Strategy: find SELECT...FROM patterns and check if LIMIT/TOP/FETCH FIRST
 * appears within a reasonable window (same statement). Only flag SELECT
 * statements, not INSERT/UPDATE/DELETE.
 */
const SELECT_FROM_PATTERN = /\bSELECT\b[\s\S]*?\bFROM\b/gi;
const LIMIT_PATTERN = /\b(?:LIMIT|TOP|FETCH\s+FIRST)\b/i;
const INSERT_UPDATE_DELETE = /\b(?:INSERT|UPDATE|DELETE)\b/i;

function scanUnboundedQueries(
  lines: string[],
  file: string,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];
  const content = lines.join('\n');

  // Find all SELECT...FROM occurrences
  SELECT_FROM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SELECT_FROM_PATTERN.exec(content)) !== null) {
    const matchStart = match.index;

    // Get the full statement — scan forward to semicolon, closing paren/backtick, or 500 chars
    const stmtEnd = Math.min(content.length, matchStart + 500);
    let endIdx = stmtEnd;
    for (let i = matchStart; i < stmtEnd; i++) {
      if (content[i] === ';' || content[i] === '`') {
        endIdx = i + 1;
        break;
      }
    }
    const fullStmt = content.slice(matchStart, endIdx);

    // Skip if this is part of an INSERT/UPDATE/DELETE (subquery)
    // Check the 30 chars before the SELECT
    const prefixStart = Math.max(0, matchStart - 30);
    const prefix = content.slice(prefixStart, matchStart);
    if (INSERT_UPDATE_DELETE.test(prefix)) continue;

    // Skip if LIMIT/TOP/FETCH FIRST is present in the statement
    if (LIMIT_PATTERN.test(fullStmt)) continue;

    // Skip if it looks like a COUNT/EXISTS subquery (bounded by nature)
    if (/\bSELECT\s+COUNT\s*\(/i.test(fullStmt)) continue;
    if (/\bEXISTS\s*\(\s*SELECT\b/i.test(fullStmt)) continue;
    if (/\bSELECT\s+1\b/i.test(fullStmt)) continue;

    // Skip if WHERE clause present — query is row-bounded, not a full table scan
    if (/\bWHERE\b/i.test(fullStmt)) continue;

    // Compute line number
    const linesBefore = content.slice(0, matchStart).split('\n');
    const lineNum = linesBefore.length;

    // Skip comment lines
    if (lineNum > 0 && lineNum <= lines.length && isComment(lines[lineNum - 1])) continue;

    violations.push({
      type: 'unbounded_query',
      severity: 'error',
      file,
      line: lineNum,
      detail: `SELECT without LIMIT — potential full table scan: ${fullStmt.slice(0, 80).replace(/\n/g, ' ').trim()}...`,
    });
  }

  return violations;
}

// =============================================================================
// 2. MISSING PAGINATION DETECTOR
// =============================================================================

/**
 * API route handlers that fetch from DB without pagination.
 *
 * Detection: find route handler definitions (app.get, router.get, etc.),
 * extract the handler body, check if it contains a DB call, and if so,
 * check for pagination keywords.
 */
const ROUTE_HANDLER_PATTERN = /\b(?:app|router|server)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(\s*['"`]/gim;
const DB_CALL_PATTERN = /\b(?:query|findAll|findMany|\.find\s*\(|\.select\s*\(|SELECT\s+.*\s+FROM|pool\.query|client\.query|db\.query|knex|prisma\.|sequelize\.|mongoose\.)/i;
const PAGINATION_KEYWORDS = /\b(?:limit|offset|page|cursor|skip|take|paginate|per_page|pageSize|perPage)\b/i;

function scanMissingPagination(
  lines: string[],
  file: string,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];
  const content = lines.join('\n');

  ROUTE_HANDLER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ROUTE_HANDLER_PATTERN.exec(content)) !== null) {
    const matchStart = match.index;

    // Extract a window for the handler body (~60 lines or 2000 chars)
    const bodyEnd = Math.min(content.length, matchStart + 2000);
    const handlerBody = content.slice(matchStart, bodyEnd);

    // Must have a DB call
    if (!DB_CALL_PATTERN.test(handlerBody)) continue;

    // Must NOT have pagination keywords
    if (PAGINATION_KEYWORDS.test(handlerBody)) continue;

    // Compute line number
    const linesBefore = content.slice(0, matchStart).split('\n');
    const lineNum = linesBefore.length;

    // Extract route path for detail
    const routeMatch = handlerBody.match(/['"`]([^'"`]+)['"`]/);
    const routePath = routeMatch ? routeMatch[1] : '(unknown)';

    violations.push({
      type: 'missing_pagination',
      severity: 'warning',
      file,
      line: lineNum,
      detail: `Route handler "${routePath}" returns DB results without pagination (no limit/offset/cursor)`,
    });
  }

  return violations;
}

// =============================================================================
// 3. MEMORY ACCUMULATION DETECTOR
// =============================================================================

/**
 * Patterns that grow in-memory data structures without bounds:
 * - Module-level arrays with .push() and no eviction
 * - Global Maps/Sets that grow without delete/clear
 * - Response body concatenation in loops
 */

function scanMemoryAccumulation(
  lines: string[],
  file: string,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];

  // Track module-level variable declarations (const/let/var at indent 0)
  const moduleVars = new Map<string, number>(); // name -> declaration line
  const moduleArrays = new Set<string>();
  const moduleMapsSets = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;

    const trimmed = line.trim();

    // Detect module-level array declarations (no leading whitespace or minimal)
    const arrayDecl = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*\[\s*\]/);
    if (arrayDecl && (line.length - trimmed.length) < 4) {
      moduleArrays.add(arrayDecl[1]);
      moduleVars.set(arrayDecl[1], i + 1);
    }

    // Detect module-level Map/Set declarations
    const mapSetDecl = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:Map|Set)\s*\(/);
    if (mapSetDecl && (line.length - trimmed.length) < 4) {
      moduleMapsSets.add(mapSetDecl[1]);
      moduleVars.set(mapSetDecl[1], i + 1);
    }
  }

  // Now scan for unbounded growth of those module-level variables
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    const trimmed = line.trim();

    // Check for .push() on module-level arrays
    for (const arrName of moduleArrays) {
      const pushPattern = new RegExp(`\\b${arrName}\\.push\\s*\\(`);
      if (pushPattern.test(trimmed)) {
        // Check if there's a nearby length check or splice/shift/pop (±5 lines)
        const contextStart = Math.max(0, i - 5);
        const contextEnd = Math.min(lines.length, i + 5);
        const context = lines.slice(contextStart, contextEnd).join('\n');
        const hasBound = /\b(?:splice|shift|pop|slice|length\s*[<>=]|\.length\s*>\s*\d)/.test(context);
        if (!hasBound) {
          violations.push({
            type: 'memory_accumulation',
            severity: 'warning',
            file,
            line: i + 1,
            detail: `Module-level array "${arrName}" grows via .push() without bounds checking`,
          });
        }
      }
    }

    // Check for .set() on module-level Maps without .delete()/.clear()
    for (const mapName of moduleMapsSets) {
      const setPattern = new RegExp(`\\b${mapName}\\.(?:set|add)\\s*\\(`);
      if (setPattern.test(trimmed)) {
        // Check the entire file for .delete() or .clear() on this variable
        const fullContent = lines.join('\n');
        const hasEviction = new RegExp(`\\b${mapName}\\.(?:delete|clear)\\s*\\(`).test(fullContent);
        if (!hasEviction) {
          violations.push({
            type: 'memory_accumulation',
            severity: 'warning',
            file,
            line: i + 1,
            detail: `Module-level Map/Set "${mapName}" grows via .set()/.add() without eviction (.delete()/.clear())`,
          });
          // Only flag once per variable
          moduleMapsSets.delete(mapName);
        }
      }
    }

    // Check for string concatenation in loops (response body growth)
    // Pattern: variable += inside a for/while/do block
    if (/\+=\s*['"`]/.test(trimmed) || /\+=\s*\w/.test(trimmed)) {
      // Check if we're inside a loop by scanning backwards for for/while/do
      let depth = 0;
      let inLoop = false;
      for (let j = i; j >= Math.max(0, i - 30); j--) {
        const prev = lines[j].trim();
        if (prev.includes('}')) depth++;
        if (prev.includes('{')) depth--;
        if (depth <= 0 && /^\s*(?:for|while|do)\s*[({]/.test(prev)) {
          inLoop = true;
          break;
        }
      }
      // Only flag concatenation patterns that look like body building, not simple strings
      if (inLoop && /\b(?:body|html|result|response|output|data)\s*\+=/.test(trimmed)) {
        violations.push({
          type: 'memory_accumulation',
          severity: 'warning',
          file,
          line: i + 1,
          detail: 'String concatenation in loop — potential unbounded memory growth',
        });
      }
    }
  }

  return violations;
}

// =============================================================================
// 4. DISK GROWTH DETECTOR
// =============================================================================

/**
 * Write operations (fs.writeFile, appendFile, etc.) inside loops or recurring
 * handlers (setInterval, cron) without rotation or size checks.
 */
const FS_WRITE_PATTERN = /\b(?:writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\s*\(/;
const RECURRING_PATTERN = /\b(?:setInterval|setImmediate|cron\.|schedule\.|\.schedule\s*\()/;
const ROTATION_KEYWORDS = /\b(?:rotate|maxSize|maxFiles|truncate|unlink|rename|stat|size\s*[<>=])/i;

function scanDiskGrowth(
  lines: string[],
  file: string,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;

    if (!FS_WRITE_PATTERN.test(line)) continue;

    // Check if inside a loop or recurring handler
    let inLoopOrRecurring = false;

    // Scan backwards for loop or recurring pattern (up to 30 lines)
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      const prev = lines[j].trim();
      if (/^\s*(?:for|while|do)\s*[({]/.test(prev) || RECURRING_PATTERN.test(prev)) {
        inLoopOrRecurring = true;
        break;
      }
    }

    if (!inLoopOrRecurring) continue;

    // Check nearby context for rotation or size checks (±10 lines)
    const contextStart = Math.max(0, i - 10);
    const contextEnd = Math.min(lines.length, i + 10);
    const context = lines.slice(contextStart, contextEnd).join('\n');

    if (ROTATION_KEYWORDS.test(context)) continue;

    violations.push({
      type: 'disk_growth',
      severity: 'warning',
      file,
      line: i + 1,
      detail: 'File write inside loop/interval without rotation or size check',
    });
  }

  return violations;
}

// =============================================================================
// 5. CONNECTION EXHAUSTION DETECTOR
// =============================================================================

/**
 * Database/Redis connections opened inside request handlers instead of at
 * module level. Each request opens a new connection, exhausting the pool.
 */
const CONNECTION_PATTERN = /\b(?:new\s+Pool|createPool|createConnection|createClient|new\s+Client|mysql\.create|pg\.connect)\s*\(/;

function scanConnectionExhaustion(
  lines: string[],
  file: string,
): CapacityViolation[] {
  const violations: CapacityViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;

    if (!CONNECTION_PATTERN.test(line)) continue;

    // Check if this is inside a route handler by scanning backwards
    let inRouteHandler = false;
    let depth = 0;
    for (let j = i; j >= Math.max(0, i - 40); j--) {
      const prev = lines[j];
      // Count braces to track scope
      for (const ch of prev) {
        if (ch === '}') depth++;
        if (ch === '{') depth--;
      }
      // If we find a route handler pattern at the right depth
      if (depth <= 0 && ROUTE_HANDLER_PATTERN.test(prev)) {
        inRouteHandler = true;
        break;
      }
      // Reset the regex lastIndex since it's global
      ROUTE_HANDLER_PATTERN.lastIndex = 0;
    }

    if (!inRouteHandler) continue;

    // Check nearby context for .release(), .end(), .close(), .destroy()
    const contextEnd = Math.min(lines.length, i + 20);
    const context = lines.slice(i, contextEnd).join('\n');
    const hasRelease = /\.(?:release|end|close|destroy|disconnect|quit)\s*\(/.test(context);

    if (hasRelease) continue;

    violations.push({
      type: 'connection_exhaustion',
      severity: 'warning',
      file,
      line: i + 1,
      detail: 'Database/Redis connection created inside request handler — will exhaust connection pool',
    });
  }

  return violations;
}

// =============================================================================
// SOURCE FILE EXTENSIONS
// =============================================================================

const CODE_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java',
  '.sql',
]);

// =============================================================================
// CAPACITY GATE
// =============================================================================

/**
 * Run the capacity gate — scans post-edit source files for patterns that
 * would exhaust system resources (memory, disk, connections, query results).
 *
 * Fails if any error-severity violations are found.
 * Passes with warnings if only warning-severity violations exist.
 */
export function runCapacityGate(ctx: GateContext): CapacityGateResult {
  const start = Date.now();
  const violations: CapacityViolation[] = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;

  // Only scan NEW content introduced by edits (replace text), not pre-existing code.
  // This prevents false positives from pre-existing patterns in the codebase.
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;

    // Only scan code files
    const ext = edit.file.includes('.') ? '.' + edit.file.split('.').pop()!.toLowerCase() : '';
    if (!CODE_EXTS.has(ext)) continue;

    const lines = edit.replace.split('\n');

    // Run all five detectors against the NEW content only
    violations.push(...scanUnboundedQueries(lines, edit.file));
    violations.push(...scanMissingPagination(lines, edit.file));
    violations.push(...scanMemoryAccumulation(lines, edit.file));
    violations.push(...scanDiskGrowth(lines, edit.file));
    violations.push(...scanConnectionExhaustion(lines, edit.file));
  }

  // Classify outcome
  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');
  const passed = errors.length === 0;

  let detail: string;
  if (violations.length === 0) {
    detail = 'No capacity violations detected';
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeViolations(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeViolations(errors)}`;
  }

  ctx.log(`[capacity] ${detail}`);

  return {
    gate: 'capacity' as any,
    passed,
    detail,
    durationMs: Date.now() - start,
    violations,
  };
}

/**
 * Summarize violations into a compact string for the detail field.
 */
function summarizeViolations(violations: CapacityViolation[]): string {
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

/**
 * Contention Gate — Concurrency Conflict Detection
 * ==================================================
 *
 * Detects when edits create race conditions or resource conflicts under
 * concurrent access. Scans post-edit file content for unsafe patterns.
 *
 * Five categories:
 *   race_condition        — read-modify-write without atomicity
 *   shared_mutable_state  — module-level mutable state modified in request handlers
 *   missing_transaction   — multiple SQL statements without transaction wrapper
 *   file_lock_absent      — file read+write on same path without locking
 *   cache_stampede        — cache miss → expensive fallback without stampede protection
 *
 * Runs after F9 (edits applied) and before staging. Pure filesystem reads.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import type { GateResult, GateContext, Edit } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

export type ContentionType =
  | 'race_condition'
  | 'shared_mutable_state'
  | 'missing_transaction'
  | 'file_lock_absent'
  | 'cache_stampede';

export interface ContentionIssue {
  type: ContentionType;
  severity: 'error' | 'warning';
  file: string;
  line: number;
  detail: string;
}

export interface ContentionGateResult extends GateResult {
  issues: ContentionIssue[];
}

// =============================================================================
// HELPERS
// =============================================================================

function safeRead(filePath: string): string | null {
  try { return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null; }
  catch { return null; }
}

const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);

interface SourceFile { relativePath: string; content: string; lines: string[] }

function collectSourceFiles(baseDir: string): SourceFile[] {
  const files: SourceFile[] = [];
  function scan(dir: string, rel: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (CODE_EXTS.has(extname(entry.name).toLowerCase())) {
          const relative = rel ? `${rel}/${entry.name}` : entry.name;
          const content = safeRead(fullPath);
          if (content && content.length < 500_000) {
            files.push({ relativePath: relative, content, lines: content.split('\n') });
          }
        }
      }
    } catch { /* unreadable dir */ }
  }
  scan(baseDir, '');
  return files;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('#');
}

// =============================================================================
// FUNCTION BODY EXTRACTION
// =============================================================================

interface FunctionSpan {
  name: string; startLine: number; endLine: number;
  body: string; bodyLines: string[];
}

/** Extract approximate function bodies using brace counting. */
function extractFunctionBodies(lines: string[]): FunctionSpan[] {
  const spans: FunctionSpan[] = [];
  const FUNC_RE = /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|\w+\s*=>)|(\w+)\s*\([^)]*\)\s*\{)/;

  for (let i = 0; i < lines.length; i++) {
    const match = FUNC_RE.exec(lines[i]);
    if (!match) continue;
    const name = match[1] || match[2] || match[3] || 'anonymous';

    let braceStart = -1;
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (lines[j].indexOf('{') !== -1) { braceStart = j; break; }
    }
    if (braceStart === -1) continue;

    let depth = 0, endLine = -1;
    for (let j = braceStart; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{') depth++; if (ch === '}') depth--; }
      if (depth === 0) { endLine = j; break; }
    }
    if (endLine === -1) endLine = lines.length - 1;

    const bodyLines = lines.slice(i, endLine + 1);
    spans.push({ name, startLine: i, endLine, body: bodyLines.join('\n'), bodyLines });
  }
  return spans;
}

// =============================================================================
// DETECTOR 1: RACE CONDITION
// =============================================================================

const READ_PATTERNS = [
  /\b(?:GET|get|hget|hgetall)\s*\(/, /\bSELECT\b/i,
  /\breadFileSync\s*\(/, /\breadFile\s*\(/, /\.get\s*\(/,
  /await\s+\w+\.findOne\s*\(/, /await\s+\w+\.find\s*\(/,
];
const WRITE_PATTERNS = [
  /\b(?:SET|set|hset|hmset)\s*\(/, /\bUPDATE\b/i, /\bINSERT\b/i,
  /\bwriteFileSync\s*\(/, /\bwriteFile\s*\(/, /\.set\s*\(/,
  /\.save\s*\(/, /await\s+\w+\.update\s*\(/,
];
const ATOMICITY_PATTERNS = [
  /\btransaction\b/i, /\bWATCH\b/, /\block\b/i, /\bmutex\b/i,
  /\batomic\b/i, /\bcompareAndSwap\b/, /\bcompareAndSet\b/, /\bBEGIN\b/,
  /\bsemaphore\b/i, /\bsynchronized\b/i, /\.multi\s*\(/, /\.pipeline\s*\(/,
  /\bINCR\b/, /\bDECR\b/, /\bincrby\b/i,
];

function detectRaceConditions(files: SourceFile[]): ContentionIssue[] {
  const issues: ContentionIssue[] = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (ATOMICITY_PATTERNS.some(p => p.test(fn.body))) continue;

      let firstRead = -1, writeAfterRead = -1;
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment(fn.bodyLines[i])) continue;
        const isRead = READ_PATTERNS.some(p => p.test(fn.bodyLines[i]));
        const isWrite = WRITE_PATTERNS.some(p => p.test(fn.bodyLines[i]));
        if (isRead && firstRead === -1) firstRead = fn.startLine + i;
        if (isWrite && firstRead !== -1) { writeAfterRead = fn.startLine + i; break; }
      }
      if (firstRead !== -1 && writeAfterRead !== -1) {
        issues.push({
          type: 'race_condition', severity: 'error', file: file.relativePath,
          line: firstRead + 1,
          detail: `Read-modify-write without atomicity in ${fn.name}() — ` +
            `read at line ${firstRead + 1}, write at line ${writeAfterRead + 1} ` +
            `with no transaction/lock/mutex between them`,
        });
      }
    }
  }
  return issues;
}

// =============================================================================
// DETECTOR 2: SHARED MUTABLE STATE
// =============================================================================

const MODULE_MUTABLE_DECL = /^(?:let|var)\s+(\w+)\s*=/;
const HANDLER_PATTERNS = [
  /(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|use|all)\s*\(/,
  /express\.Router\(\)/,
];

function detectSharedMutableState(files: SourceFile[]): ContentionIssue[] {
  const issues: ContentionIssue[] = [];
  for (const file of files) {
    // Find module-level (brace depth 0) mutable declarations
    const mutableVars: Array<{ name: string; line: number }> = [];
    let depth = 0;
    for (let i = 0; i < file.lines.length; i++) {
      for (const ch of file.lines[i]) { if (ch === '{') depth++; if (ch === '}') depth--; }
      if (depth < 0) depth = 0;
      if (depth > 0) continue;
      if (isComment(file.lines[i])) continue;
      const m = MODULE_MUTABLE_DECL.exec(file.lines[i].trim());
      if (m) mutableVars.push({ name: m[1], line: i });
    }
    if (mutableVars.length === 0) continue;

    const functions = extractFunctionBodies(file.lines);
    for (const v of mutableVars) {
      let readInHandler = false, writeInHandler = false;
      for (const fn of functions) {
        if (!HANDLER_PATTERNS.some(p => p.test(fn.body))) continue;
        const readRe = new RegExp(`\\b${v.name}\\b(?!\\s*=)`);
        const writeRe = new RegExp(`\\b${v.name}\\s*(?:=|\\+\\+|--|\\+=|-=|\\*=|\\.push\\(|\\.splice\\(|\\.delete\\(|\\[\\w+\\]\\s*=)`);
        if (readRe.test(fn.body)) readInHandler = true;
        if (writeRe.test(fn.body)) writeInHandler = true;
      }
      if (readInHandler && writeInHandler) {
        issues.push({
          type: 'shared_mutable_state', severity: 'warning', file: file.relativePath,
          line: v.line + 1,
          detail: `Module-level mutable variable '${v.name}' is read and written ` +
            `inside request handlers without synchronization`,
        });
      }
    }
  }
  return issues;
}

// =============================================================================
// DETECTOR 3: MISSING TRANSACTION
// =============================================================================

const SQL_PATTERNS: Array<{ regex: RegExp; action: string }> = [
  { regex: /\bINSERT\s+INTO\s+["'`]?(\w+)/gi, action: 'INSERT' },
  { regex: /\bUPDATE\s+["'`]?(\w+)/gi, action: 'UPDATE' },
  { regex: /\bDELETE\s+FROM\s+["'`]?(\w+)/gi, action: 'DELETE' },
  { regex: /\bSELECT\b[^;]*?\bFROM\s+["'`]?(\w+)/gi, action: 'SELECT' },
];
const TRANSACTION_PATTERNS = [
  /\bBEGIN\b/i, /\bCOMMIT\b/i, /pool\.query\s*\(\s*['"`]BEGIN/i,
  /client\.query\s*\(\s*['"`]BEGIN/i, /\.transaction\s*\(/, /\$transaction\s*\(/,
  /knex\.transaction/, /sequelize\.transaction/, /\.startSession\s*\(/,
  /withTransaction\s*\(/,
];

interface SqlOp { action: string; table: string; line: number }

function detectMissingTransactions(files: SourceFile[]): ContentionIssue[] {
  const issues: ContentionIssue[] = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (TRANSACTION_PATTERNS.some(p => p.test(fn.body))) continue;

      const ops: SqlOp[] = [];
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment(fn.bodyLines[i])) continue;
        for (const { regex, action } of SQL_PATTERNS) {
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(fn.bodyLines[i])) !== null) {
            ops.push({ action, table: m[1].toLowerCase(), line: fn.startLine + i });
          }
        }
      }
      if (ops.length < 2) continue;

      // Group by table
      const tables = new Map<string, SqlOp[]>();
      for (const op of ops) {
        const list = tables.get(op.table) || [];
        list.push(op);
        tables.set(op.table, list);
      }

      for (const [table, tableOps] of tables) {
        const writes = tableOps.filter(o => o.action !== 'SELECT');
        const reads = tableOps.filter(o => o.action === 'SELECT');
        if (writes.length >= 2) {
          issues.push({
            type: 'missing_transaction', severity: 'error', file: file.relativePath,
            line: writes[0].line + 1,
            detail: `Multiple SQL writes to '${table}' in ${fn.name}() without ` +
              `transaction wrapper (${writes.map(w => w.action).join(' + ')})`,
          });
        } else if (reads.length > 0 && writes.length > 0) {
          issues.push({
            type: 'missing_transaction', severity: 'error', file: file.relativePath,
            line: reads[0].line + 1,
            detail: `SELECT + ${writes[0].action} on '${table}' in ${fn.name}() ` +
              `without transaction wrapper — risk of phantom reads`,
          });
        }
      }

      // Cross-table multi-write
      const writeOps = ops.filter(o => o.action !== 'SELECT');
      const writeTables = new Set(writeOps.map(o => o.table));
      if (writeTables.size >= 2) {
        const alreadyReported = issues.some(iss =>
          iss.file === file.relativePath && iss.type === 'missing_transaction' &&
          iss.line >= fn.startLine + 1 && iss.line <= fn.endLine + 1
        );
        if (!alreadyReported) {
          issues.push({
            type: 'missing_transaction', severity: 'error', file: file.relativePath,
            line: writeOps[0].line + 1,
            detail: `Writes to multiple tables (${[...writeTables].join(', ')}) in ` +
              `${fn.name}() without transaction wrapper — partial failure risk`,
          });
        }
      }
    }
  }
  return issues;
}

// =============================================================================
// DETECTOR 4: FILE LOCK ABSENT
// =============================================================================

const FILE_READ_RE = [/readFileSync\s*\(\s*([^,)]+)/, /readFile\s*\(\s*([^,)]+)/, /fs\.promises\.readFile\s*\(\s*([^,)]+)/];
const FILE_WRITE_RE = [/writeFileSync\s*\(\s*([^,)]+)/, /writeFile\s*\(\s*([^,)]+)/, /fs\.promises\.writeFile\s*\(\s*([^,)]+)/];
const FILE_LOCK_PATTERNS = [
  /\blockfile\b/i, /\bflock\b/i, /\.lock\b/, /\bmutex\b/i, /\bsemaphore\b/i,
  /\bproper-lockfile\b/, /\bacquireLock\b/, /\breleaseLock\b/, /\bwithLock\b/,
];

function normPathArg(s: string): string { return s.replace(/['"` ]/g, '').trim(); }

function detectFileLockAbsent(files: SourceFile[]): ContentionIssue[] {
  const issues: ContentionIssue[] = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (FILE_LOCK_PATTERNS.some(p => p.test(fn.body))) continue;

      const reads: Array<{ path: string; line: number }> = [];
      const writes: Array<{ path: string; line: number }> = [];

      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment(fn.bodyLines[i])) continue;
        for (const re of FILE_READ_RE) { const m = re.exec(fn.bodyLines[i]); if (m) reads.push({ path: normPathArg(m[1]), line: fn.startLine + i }); }
        for (const re of FILE_WRITE_RE) { const m = re.exec(fn.bodyLines[i]); if (m) writes.push({ path: normPathArg(m[1]), line: fn.startLine + i }); }
      }

      for (const r of reads) {
        if (writes.some(w => w.path === r.path)) {
          issues.push({
            type: 'file_lock_absent', severity: 'warning', file: file.relativePath,
            line: r.line + 1,
            detail: `File read+write on same path (${r.path}) in ${fn.name}() ` +
              `without file locking — concurrent requests may clobber data`,
          });
          break;
        }
      }
    }
  }
  return issues;
}

// =============================================================================
// DETECTOR 5: CACHE STAMPEDE
// =============================================================================

const CACHE_GET_RE = [
  /\bcache\.get\s*\(/, /\bredis\.get\s*\(/, /\bclient\.get\s*\(/,
  /\bgetCached\s*\(/, /\bmemcache\.get\s*\(/, /\blru\.get\s*\(/,
];
const CACHE_SET_RE = [
  /\bcache\.set\s*\(/, /\bredis\.set\s*\(/, /\bclient\.set\s*\(/,
  /\bmemcache\.set\s*\(/, /\blru\.set\s*\(/,
];
const EXPENSIVE_RE = [
  /\bSELECT\b/i, /\bpool\.query\s*\(/, /\bclient\.query\s*\(/,
  /\.findOne\s*\(/, /\.find\s*\(/, /\.findMany\s*\(/,
  /\bfetch\s*\(/, /\baxios\s*[\.(]/, /\bhttp\.get\s*\(/,
  /\breadFileSync\s*\(/, /\breadFile\s*\(/, /\.aggregate\s*\(/,
];
const STAMPEDE_PROTECTION = [
  /\block\b/i, /\bmutex\b/i, /\bsingleflight\b/i, /\bcoalesce\b/i,
  /\bdedupe\b/i, /\bsemaphore\b/i, /\bpromise[_-]?cach/i, /\bmemoize\b/i,
  /\bthrottle\b/i, /\bswr\b/i, /\bstale-while-revalidate\b/i,
  /\bpending(?:Request|Promise|Query)\b/,
];

function detectCacheStampede(files: SourceFile[]): ContentionIssue[] {
  const issues: ContentionIssue[] = [];
  for (const file of files) {
    for (const fn of extractFunctionBodies(file.lines)) {
      if (STAMPEDE_PROTECTION.some(p => p.test(fn.body))) continue;

      let cacheGet = -1, expensive = -1, cacheSet = -1;
      for (let i = 0; i < fn.bodyLines.length; i++) {
        if (isComment(fn.bodyLines[i])) continue;
        const line = fn.bodyLines[i];
        if (CACHE_GET_RE.some(p => p.test(line)) && cacheGet === -1) cacheGet = fn.startLine + i;
        if (EXPENSIVE_RE.some(p => p.test(line)) && cacheGet !== -1 && expensive === -1) expensive = fn.startLine + i;
        if (CACHE_SET_RE.some(p => p.test(line)) && expensive !== -1 && cacheSet === -1) cacheSet = fn.startLine + i;
      }
      if (cacheGet !== -1 && expensive !== -1 && cacheSet !== -1) {
        issues.push({
          type: 'cache_stampede', severity: 'warning', file: file.relativePath,
          line: cacheGet + 1,
          detail: `Cache get→miss→expensive query→set in ${fn.name}() without ` +
            `stampede protection — concurrent misses all hit the expensive path`,
        });
      }
    }
  }
  return issues;
}

// =============================================================================
// CONTENTION GATE
// =============================================================================

/**
 * Run the contention gate — scans post-edit source files for concurrency
 * conflict patterns. Fails if any error-severity issues are found.
 */
export function runContentionGate(ctx: GateContext): ContentionGateResult {
  const start = Date.now();
  const issues: ContentionIssue[] = [];
  const baseDir = ctx.stageDir ?? ctx.config.appDir;

  // Only scan NEW content introduced by edits (replace text), not pre-existing code.
  // This prevents false positives from pre-existing patterns in the codebase.
  // GC-651: Skip frontend files — form components don't do DB writes
  const FRONTEND_EXTS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'html', 'css', 'scss', 'less']);
  const sourceFiles: SourceFile[] = [];
  for (const edit of ctx.edits) {
    if (!edit.replace) continue;
    const ext = edit.file.split('.').pop()?.toLowerCase() ?? '';
    if (FRONTEND_EXTS.has(ext)) continue;
    sourceFiles.push({
      relativePath: edit.file,
      content: edit.replace,
      lines: edit.replace.split('\n'),
    });
  }

  issues.push(...detectRaceConditions(sourceFiles));
  issues.push(...detectSharedMutableState(sourceFiles));
  issues.push(...detectMissingTransactions(sourceFiles));
  issues.push(...detectFileLockAbsent(sourceFiles));
  issues.push(...detectCacheStampede(sourceFiles));

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const passed = errors.length === 0;

  let detail: string;
  if (issues.length === 0) {
    detail = 'No contention issues detected';
  } else if (passed) {
    detail = `${warnings.length} warning(s): ${summarizeIssues(warnings)}`;
  } else {
    detail = `${errors.length} error(s), ${warnings.length} warning(s): ${summarizeIssues(errors)}`;
  }

  ctx.log(`[contention] ${detail}`);

  return {
    gate: 'contention' as any,
    passed, detail, durationMs: Date.now() - start, issues,
  };
}

function summarizeIssues(issues: ContentionIssue[]): string {
  const byType = new Map<string, number>();
  for (const i of issues) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  const parts: string[] = [];
  for (const [type, count] of byType) parts.push(`${count}× ${type.replace(/_/g, ' ')}`);
  return parts.join(', ');
}

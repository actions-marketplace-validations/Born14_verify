/**
 * Constraint Store — Portable K5 Learning Memory
 * ================================================
 *
 * Persists failure constraints to disk. Each failure narrows the solution space.
 * The next verify() call is smarter because it remembers what already failed.
 *
 * Ported from Sovereign's operational memory (src/lib/services/memory.ts)
 * with all daemon dependencies removed. Pure filesystem + JSON.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

// =============================================================================
// TYPES
// =============================================================================

export type ChangeType = 'ui' | 'logic' | 'config' | 'schema' | 'infra' | 'mixed';

export interface Constraint {
  id: string;
  type: 'forbidden_action' | 'radius_limit' | 'goal_drift_ban';
  signature: string;
  scope: 'planning';
  appliesTo: ChangeType[];
  surface: {
    files: string[];
    intents: string[];
  };
  requires: {
    files?: string[];
    patterns?: string[];
    maxFiles?: number;
    bannedPredicateFingerprints?: string[];
  };
  reason: string;
  introducedAt: number;
  sessionId?: string;
  sessionScope?: boolean;
  expiresAt?: number;
}

export type FailureKind = 'harness_fault' | 'app_failure' | 'unknown';

export type FailureActionClass =
  | 'rewrite_page' | 'global_replace' | 'schema_migration'
  | 'style_overhaul' | 'unrelated_edit';

export interface FailureEvent {
  sessionId: string;
  source: 'syntax' | 'staging' | 'evidence' | 'invariant';
  error: string;
  filesTouched: string[];
  attempt: number;
  changeType?: ChangeType;
  signature?: string;
  actionClass?: FailureActionClass;
  failureKind?: FailureKind;
  failedPredicates?: Array<{
    type: string;
    selector?: string;
    property?: string;
    expected?: string;
    actual?: string;
    path?: string;
    method?: string;
    table?: string;
    pattern?: string;
    expect?: {
      status?: number;
      bodyContains?: string | string[];
      bodyRegex?: string;
      contentType?: string;
    };
    steps?: Array<{
      method: string;
      path: string;
      expect?: { status?: number; bodyContains?: string | string[] };
    }>;
  }>;
}

export interface Outcome {
  timestamp: number;
  sessionId: string;
  goal?: string;
  success: boolean;
  changeType?: ChangeType;
  filesTouched: string[];
  gatesFailed: string[];
  signature?: string;
  failureKind?: FailureKind;
  failedPredicateFingerprints?: string[];
}

export interface ConstraintStoreData {
  constraints: Constraint[];
  outcomes: Outcome[];
  patterns: Pattern[];
}

export interface Pattern {
  signature: string;
  occurrences: number;
  lastSeen: number;
  winningFixes: string[];
  affectedFiles: string[];
}

interface ConstraintViolation {
  constraintId: string;
  signature: string;
  type: string;
  reason: string;
  banType: 'file_pattern' | 'action_class' | 'radius_limit' | 'goal_drift' | 'predicate_fingerprint';
}

// =============================================================================
// STORE
// =============================================================================

const CONSTRAINT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONSTRAINT_DEPTH = 5;
const MAX_OUTCOMES = 100;

// Radius limits by attempt number
const RADIUS_MAP: Record<number, number> = {
  2: 5, 3: 3, 4: 2,
};
const RADIUS_MIN = 1;

export class ConstraintStore {
  private stateDir: string;
  private dataPath: string;
  private data: ConstraintStoreData;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.dataPath = join(stateDir, 'memory.json');
    this.data = this.load();
  }

  // ---------------------------------------------------------------------------
  // LOAD / SAVE
  // ---------------------------------------------------------------------------

  private load(): ConstraintStoreData {
    if (!existsSync(this.dataPath)) {
      return { constraints: [], outcomes: [], patterns: [] };
    }
    try {
      const raw = readFileSync(this.dataPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        constraints: parsed.constraints ?? [],
        outcomes: parsed.outcomes ?? [],
        patterns: parsed.patterns ?? [],
      };
    } catch {
      return { constraints: [], outcomes: [], patterns: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.dataPath), { recursive: true });
    // Evict if over capacity
    if (this.data.outcomes.length > MAX_OUTCOMES) {
      this.data.outcomes = this.data.outcomes
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_OUTCOMES);
    }
    writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
  }

  // ---------------------------------------------------------------------------
  // K5: CONSTRAINT CHECK — Does this plan violate any learned constraints?
  // ---------------------------------------------------------------------------

  checkConstraints(
    filesTouched: string[],
    changeType: ChangeType,
    predicateFingerprints?: string[],
  ): ConstraintViolation | null {
    const now = Date.now();

    for (const c of this.data.constraints) {
      // Skip expired
      if (c.expiresAt && c.expiresAt < now) continue;

      // Check change type match
      if (c.appliesTo.length > 0 && !c.appliesTo.includes(changeType)) continue;

      // --- PREDICATE FINGERPRINT BAN ---
      if (c.requires.bannedPredicateFingerprints && predicateFingerprints) {
        for (const banned of c.requires.bannedPredicateFingerprints) {
          if (predicateFingerprints.includes(banned)) {
            return {
              constraintId: c.id,
              signature: c.signature,
              type: c.type,
              reason: c.reason,
              banType: 'predicate_fingerprint',
            };
          }
        }
      }

      // --- GOAL DRIFT BAN ---
      if (c.type === 'goal_drift_ban') {
        return {
          constraintId: c.id,
          signature: c.signature,
          type: c.type,
          reason: c.reason,
          banType: 'goal_drift',
        };
      }

      // --- RADIUS LIMIT ---
      if (c.type === 'radius_limit' && c.requires.maxFiles) {
        if (filesTouched.length > c.requires.maxFiles) {
          return {
            constraintId: c.id,
            signature: c.signature,
            type: c.type,
            reason: `Plan touches ${filesTouched.length} files, limit is ${c.requires.maxFiles}`,
            banType: 'radius_limit',
          };
        }
      }

      // --- FILE PATTERN / STRATEGY BAN ---
      if (c.type === 'forbidden_action') {
        // Empty surface = pure strategy ban (action class)
        if (c.surface.files.length === 0) {
          return {
            constraintId: c.id,
            signature: c.signature,
            type: c.type,
            reason: c.reason,
            banType: 'action_class',
          };
        }

        // File-based: check if plan touches constrained files
        const touchesConstrained = filesTouched.some(f =>
          c.surface.files.some(cf => f.includes(cf) || cf.includes(f))
        );
        if (touchesConstrained) {
          // Check if required patterns are present
          if (c.requires.patterns && c.requires.patterns.length > 0) {
            // Constraint is satisfied if all required patterns are present
            // (we can't check this without seeing file content, so ban it)
            return {
              constraintId: c.id,
              signature: c.signature,
              type: c.type,
              reason: c.reason,
              banType: 'file_pattern',
            };
          }
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // K5: CONSTRAINT SEEDING — Learn from failures
  // ---------------------------------------------------------------------------

  seedFromFailure(event: FailureEvent): Constraint | null {
    // Auto-classify failure kind
    if (!event.failureKind) {
      event.failureKind = classifyFailureKind(event.error, event.source);
    }

    // HARNESS FAULTS NEVER SEED — infrastructure broke, not agent code
    if (event.failureKind === 'harness_fault') return null;

    // Syntax alone can't seed — needs corroboration
    if (event.source === 'syntax') return null;

    // Check max depth
    const sessionConstraints = this.data.constraints.filter(
      c => c.sessionId === event.sessionId && c.sessionScope
    );
    if (sessionConstraints.length >= MAX_CONSTRAINT_DEPTH) return null;

    const signature = event.signature ?? extractSignature(event.error);
    const sessionFailureCount = this.countSessionFailures(event.sessionId, signature);

    let constraint: Constraint | null = null;

    // Strategy ban: same action class failed 2+ times
    if (event.actionClass && sessionFailureCount >= 2) {
      constraint = this.buildStrategyBan(event);
    }

    // Radius shrink: attempt >= 2
    if (!constraint && event.attempt >= 2) {
      constraint = this.buildRadiusLimit(event);
    }

    // Post-deploy evidence: always seed (strongest signal)
    if (!constraint && event.source === 'evidence') {
      constraint = this.buildEvidenceConstraint(event);
    }

    if (!constraint) return null;

    // Dedup
    const isDupe = this.data.constraints.some(c =>
      c.sessionId === event.sessionId &&
      c.type === constraint!.type &&
      c.signature === constraint!.signature
    );
    if (isDupe) return null;

    this.data.constraints.push(constraint);
    this.save();
    return constraint;
  }

  // ---------------------------------------------------------------------------
  // OUTCOME RECORDING
  // ---------------------------------------------------------------------------

  recordOutcome(outcome: Outcome): void {
    this.data.outcomes.push(outcome);

    // Update patterns
    if (!outcome.success && outcome.signature) {
      const existing = this.data.patterns.find(p => p.signature === outcome.signature);
      if (existing) {
        existing.occurrences++;
        existing.lastSeen = outcome.timestamp;
        existing.affectedFiles = [...new Set([...existing.affectedFiles, ...outcome.filesTouched])];
      } else {
        this.data.patterns.push({
          signature: outcome.signature,
          occurrences: 1,
          lastSeen: outcome.timestamp,
          winningFixes: [],
          affectedFiles: [...outcome.filesTouched],
        });
      }
    }

    // If success, record as winning fix for any matching patterns
    if (outcome.success && outcome.signature) {
      const pattern = this.data.patterns.find(p => p.signature === outcome.signature);
      if (pattern && outcome.goal) {
        pattern.winningFixes.push(outcome.goal);
        if (pattern.winningFixes.length > 5) {
          pattern.winningFixes = pattern.winningFixes.slice(-5);
        }
      }
    }

    this.save();
  }

  // ---------------------------------------------------------------------------
  // SESSION CLEANUP
  // ---------------------------------------------------------------------------

  cleanupSession(sessionId: string): void {
    const now = Date.now();
    const before = this.data.constraints.length;

    this.data.constraints = this.data.constraints.filter(c => {
      if (c.sessionId === sessionId && c.sessionScope) return false;
      if (c.expiresAt && c.expiresAt < now) return false;
      return true;
    });

    if (this.data.constraints.length !== before) {
      this.save();
    }
  }

  // ---------------------------------------------------------------------------
  // PATTERN RECALL
  // ---------------------------------------------------------------------------

  getPatternRecall(error: string): string | undefined {
    const sig = extractSignature(error);
    if (!sig) return undefined;

    const pattern = this.data.patterns.find(p => p.signature === sig);
    if (!pattern || pattern.winningFixes.length === 0) return undefined;

    return `Known pattern "${sig}" (seen ${pattern.occurrences}x). Prior fixes: ${pattern.winningFixes.join('; ')}`;
  }

  // ---------------------------------------------------------------------------
  // ACCESSORS
  // ---------------------------------------------------------------------------

  getConstraints(): Constraint[] { return this.data.constraints; }
  getOutcomes(): Outcome[] { return this.data.outcomes; }
  getPatterns(): Pattern[] { return this.data.patterns; }
  getConstraintCount(): number { return this.data.constraints.length; }

  // ---------------------------------------------------------------------------
  // INTERNAL BUILDERS
  // ---------------------------------------------------------------------------

  private buildStrategyBan(event: FailureEvent): Constraint {
    return {
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'forbidden_action',
      signature: event.actionClass ?? 'unknown_strategy',
      scope: 'planning',
      appliesTo: event.changeType ? [event.changeType] : [],
      surface: { files: [], intents: [] },
      requires: {},
      reason: `Strategy "${event.actionClass}" failed ${event.attempt}+ times`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS,
    };
  }

  private buildRadiusLimit(event: FailureEvent): Constraint {
    const maxFiles = RADIUS_MAP[event.attempt] ?? RADIUS_MIN;
    return {
      id: `c_radius_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'radius_limit',
      signature: `radius_${maxFiles}`,
      scope: 'planning',
      appliesTo: [],
      surface: { files: event.filesTouched, intents: [] },
      requires: { maxFiles },
      reason: `Attempt ${event.attempt}: shrinking allowed file count to ${maxFiles}`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS,
    };
  }

  private buildEvidenceConstraint(event: FailureEvent): Constraint {
    // Predicate fingerprint ban if we have failed predicates
    if (event.failedPredicates && event.failedPredicates.length > 0) {
      const fingerprints = event.failedPredicates.map(p => predicateFingerprint(p));
      return {
        id: `c_evidence_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'forbidden_action',
        signature: event.signature ?? 'evidence_failure',
        scope: 'planning',
        appliesTo: [],
        surface: { files: event.filesTouched, intents: [] },
        requires: { bannedPredicateFingerprints: fingerprints },
        reason: `Post-deploy evidence failed: ${event.error.substring(0, 100)}`,
        introducedAt: Date.now(),
        sessionId: event.sessionId,
        sessionScope: true,
        expiresAt: Date.now() + CONSTRAINT_TTL_MS * 2,
      };
    }

    return {
      id: `c_evidence_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'forbidden_action',
      signature: event.signature ?? 'evidence_failure',
      scope: 'planning',
      appliesTo: [],
      surface: { files: event.filesTouched, intents: [] },
      requires: {},
      reason: `Post-deploy evidence failed: ${event.error.substring(0, 100)}`,
      introducedAt: Date.now(),
      sessionId: event.sessionId,
      sessionScope: true,
      expiresAt: Date.now() + CONSTRAINT_TTL_MS * 2,
    };
  }

  private countSessionFailures(sessionId: string, signature?: string): number {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    return this.data.outcomes.filter(o =>
      !o.success &&
      o.sessionId === sessionId &&
      o.failureKind !== 'harness_fault' &&
      o.timestamp > twoHoursAgo &&
      (!signature || o.signature === signature)
    ).length;
  }
}


// =============================================================================
// PURE FUNCTIONS (no store dependency)
// =============================================================================

/**
 * Extract a failure signature from an error string.
 * Deterministic regex — not LLM.
 */
export function extractSignature(error: string): string | undefined {
  if (!error) return undefined;

  const signatures: [RegExp, string][] = [
    [/search string not found|edit application failed/i, 'edit_not_applicable'],
    [/browser gate failed/i, 'browser_gate_failed'],
    [/getaddrinfo.*(eai_again|enotfound)/i, 'dns_resolution_failed'],
    [/timeout|exceeded time/i, 'migration_timeout'],
    [/eaddrinuse|port.*in use/i, 'port_conflict'],
    [/syntaxerror|unexpected token|unterminated string/i, 'syntax_error'],
    [/cannot find module/i, 'missing_module'],
    [/build fail|exit code [1-9]/i, 'build_failure'],
    [/health check fail|502/i, 'health_check_failure'],
    [/econnrefused/i, 'connection_refused'],
    [/out of memory|oom/i, 'oom_killed'],
    [/element not found in dom/i, 'selector_not_found'],
    [/actual vs expected|value mismatch/i, 'css_value_mismatch'],
    [/predicate.*failed|evidence failed/i, 'predicate_mismatch'],
  ];

  for (const [regex, sig] of signatures) {
    if (regex.test(error)) return sig;
  }
  return undefined;
}

/**
 * Classify a failure as harness infrastructure vs app code error.
 */
export function classifyFailureKind(
  error: string,
  source?: FailureEvent['source'],
): FailureKind {
  if (!error) return 'unknown';

  if (/getaddrinfo.*(eai_again|enotfound)|eai_again|enotfound/i.test(error)) return 'harness_fault';
  if (/econnrefused|connection refused/i.test(error) && source === 'staging') return 'harness_fault';
  if (/eaddrinuse|port.*in use|address.*in use/i.test(error)) return 'harness_fault';
  if (/docker.*daemon.*not running|cannot connect to.*docker/i.test(error)) return 'harness_fault';
  if (/timeout|timed?\s*out/i.test(error) && source === 'staging') return 'harness_fault';

  if (/syntaxerror|unexpected token|unterminated string/i.test(error) &&
      (source === 'staging' || source === 'evidence' || source === 'syntax')) {
    return 'app_failure';
  }
  if (/build fail/i.test(error) && source === 'staging') return 'app_failure';
  if (/cannot find module/i.test(error)) return 'app_failure';
  if (/predicate.*failed|evidence failed|value mismatch/i.test(error)) return 'app_failure';

  return 'unknown';
}

/**
 * Compute a deterministic fingerprint for a predicate.
 */
export function predicateFingerprint(p: {
  type: string;
  selector?: string;
  property?: string;
  expected?: string;
  path?: string;
  method?: string;
  status?: number | string;
  table?: string;
  pattern?: string;
  expect?: {
    status?: number;
    bodyContains?: string | string[];
    bodyRegex?: string;
    contentType?: string;
  };
  steps?: Array<{
    method: string;
    path: string;
    expect?: { status?: number; bodyContains?: string | string[] };
  }>;
}): string {
  const parts = [`type=${p.type}`];
  if (p.selector != null) parts.push(`selector=${p.selector}`);
  if (p.property != null) parts.push(`property=${p.property}`);
  if (p.expected != null) parts.push(`exp=${p.expected}`);
  if (p.path != null) parts.push(`path=${p.path}`);
  if (p.method != null) parts.push(`method=${p.method}`);
  if (p.table != null) parts.push(`table=${p.table}`);
  if (p.pattern != null) parts.push(`pattern=${p.pattern}`);
  // HTTP predicates: include expect object fields for unique fingerprint
  if (p.expect) {
    if (p.expect.status != null) parts.push(`status=${p.expect.status}`);
    if (p.expect.bodyContains != null) {
      const bc = Array.isArray(p.expect.bodyContains)
        ? p.expect.bodyContains.join(',')
        : p.expect.bodyContains;
      parts.push(`body=${bc}`);
    }
    if (p.expect.bodyRegex != null) parts.push(`regex=${p.expect.bodyRegex}`);
  }
  // HTTP sequence: include step signatures
  if (p.steps && p.steps.length > 0) {
    const stepSig = p.steps.map(s => `${s.method}:${s.path}`).join('+');
    parts.push(`steps=${stepSig}`);
  }
  return parts.join('|');
}

/**
 * Classify change type from a list of modified files.
 */
export function classifyChangeType(files: string[]): ChangeType {
  const categories = new Set<string>();

  for (const f of files) {
    const lower = f.toLowerCase();
    if (/\.css$|\.scss$|\.sass$|\.less$|styles?[./]|\.html$|\.hbs$|\.ejs$|\.pug$/.test(lower)) {
      categories.add('ui');
    } else if (/migration|\.sql$|init\.sql|schema/.test(lower)) {
      categories.add('schema');
    } else if (/dockerfile|docker-compose|\.env|\.yml$|\.yaml$|caddy|nginx/i.test(lower)) {
      if (/docker-compose\.staging/i.test(lower)) continue;
      categories.add(/dockerfile|docker-compose/i.test(lower) ? 'config' : 'infra');
    } else if (/package\.json|tsconfig|\.config\./i.test(lower)) {
      categories.add('config');
    } else {
      categories.add('logic');
    }
  }

  if (categories.size === 0) return 'ui';
  if (categories.size === 1) return [...categories][0] as ChangeType;
  return 'mixed';
}

/**
 * Classify action class from code changes (deterministic heuristics).
 */
export function classifyActionClass(
  edits: Array<{ file: string; search?: string; replace?: string }>,
  predicateFiles?: string[],
): FailureActionClass | undefined {
  if (edits.length === 0) return undefined;

  // Rewrite page: >50% of file replaced in any single edit
  for (const e of edits) {
    if (e.search && e.replace && e.replace.length > 0) {
      if (e.search.length > 200 && e.replace.length / e.search.length > 0.5) {
        return 'rewrite_page';
      }
    }
  }

  // Global replace: same pattern across 3+ files
  const replacePatterns = new Map<string, number>();
  for (const e of edits) {
    if (e.search && e.search.length < 50) {
      const key = e.search.trim();
      replacePatterns.set(key, (replacePatterns.get(key) ?? 0) + 1);
    }
  }
  for (const count of replacePatterns.values()) {
    if (count >= 3) return 'global_replace';
  }

  // Schema migration: SQL detected
  for (const e of edits) {
    if (e.file.match(/migration|\.sql$/i)) return 'schema_migration';
  }

  // Style overhaul: >5 CSS property changes
  let cssChanges = 0;
  for (const e of edits) {
    if (e.file.match(/\.css$|\.scss$|styles/) || (e.replace && /[{};]/.test(e.replace))) {
      cssChanges++;
    }
  }
  if (cssChanges > 5) return 'style_overhaul';

  // Unrelated edit: touched files not in predicate surface
  if (predicateFiles && predicateFiles.length > 0) {
    const unrelated = edits.filter(e => !predicateFiles.some(pf => e.file.includes(pf)));
    if (unrelated.length > edits.length * 0.5) return 'unrelated_edit';
  }

  return undefined;
}

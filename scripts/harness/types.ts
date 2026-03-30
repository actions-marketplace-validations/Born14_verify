/**
 * Self-Test Harness Types
 * =======================
 * Shared interfaces for the autonomous testing loop.
 */

import type { Edit, Predicate, VerifyConfig, VerifyResult } from '../../src/types.js';

// =============================================================================
// SCENARIO
// =============================================================================

export type ScenarioFamily = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'L' | 'M' | 'P' | 'V' | 'W' | 'WH' | 'WP' | 'WC' | 'X';

export interface VerifyScenario {
  id: string;
  family: ScenarioFamily;
  generator: string;
  description: string;
  edits: Edit[];
  predicates: Predicate[];
  config: Partial<VerifyConfig>;
  invariants: InvariantCheck[];
  requiresDocker: boolean;
  /** Requires Playwright browser for live rendering verification */
  requiresPlaywright?: boolean;
  /** Requires the local HTTP mock server (P family) */
  requiresHttpMock?: boolean;
  /** Requires a live HTTP server (not mock — real server for SSE, CORS, TLS, etc.) */
  requiresLiveHttp?: boolean;
  /** For multi-step scenarios (B family), ordered steps */
  steps?: VerifyScenario[];
  /** Expected verify() outcome (if known) */
  expectedSuccess?: boolean;
  /** Failure class from FAILURE-TAXONOMY.md (e.g., 'FS-03', 'CSS-01') */
  failureClass?: string;
  /**
   * Setup hook: runs before verify() with access to the shared stateDir.
   * Used by B scenarios to directly seed/manipulate constraints.
   */
  beforeStep?: (stateDir: string) => void;
  /**
   * If true, skip calling verify() for this step — only run beforeStep + invariants.
   * Used for pure constraint-manipulation steps (B4, B5, B6, B8).
   */
  skipVerify?: boolean;

  /**
   * Message gate test data — for Family M scenarios.
   * When present, runner calls governMessage() instead of verify().
   * The MessageGateResult is converted to a VerifyResult shape for invariant checking.
   */
  messageTest?: {
    envelope: import('../../src/gates/message.js').MessageEnvelope;
    policy: import('../../src/gates/message.js').MessagePolicy;
    evidenceProviders?: Record<string, import('../../src/gates/message.js').EvidenceProvider>;
    deniedPatterns?: Array<{ pattern: string; reason: string; timestamp: number }>;
  };

  /**
   * Govern loop test data — for Family L scenarios.
   * When present, runner calls govern() instead of verify().
   * The GovernResult is converted to a VerifyResult shape for invariant checking.
   * The full GovernResult is stashed as _governResult for invariant access.
   */
  governTest?: {
    goal: string;
    maxAttempts: number;
    /** Agent plan function — receives (goal, context) on each attempt */
    agent: import('../../src/govern.js').GovernAgent;
    /** Optional approval gate */
    onApproval?: (plan: import('../../src/govern.js').AgentPlan, context: import('../../src/govern.js').GovernContext) => Promise<boolean>;
    /** Optional stuck handler */
    onStuck?: (state: import('../../src/govern.js').ConvergenceState, context: import('../../src/govern.js').GovernContext) => 'continue' | 'stop';
  };
}

// =============================================================================
// ORACLE
// =============================================================================

export type InvariantCategory =
  | 'fingerprint' | 'k5' | 'gate_sequence' | 'containment'
  | 'grounding' | 'pipeline' | 'robustness'
  | 'vision' | 'triangulation' | 'message'
  | 'attribution';

export type InvariantLayer = 'product' | 'harness';

export type Severity = 'bug' | 'unexpected' | 'info';

export interface InvariantCheck {
  name: string;
  category: InvariantCategory;
  layer: InvariantLayer;
  check: (scenario: VerifyScenario, result: VerifyResult | Error, context: OracleContext) => InvariantVerdict;
}

export interface InvariantVerdict {
  passed: boolean;
  violation?: string;
  severity: Severity;
}

export interface OracleContext {
  constraintsBefore: number;
  constraintsAfter: number;
  priorResults: VerifyResult[];
  durationMs: number;
  activeConstraintsAfter?: number;  // Live count (vs high-water mark in constraintsAfter)
}

// =============================================================================
// LEDGER
// =============================================================================

export interface LedgerEntry {
  id: string;
  timestamp: string;
  scenario: {
    family: ScenarioFamily;
    generator: string;
    description: string;
    predicateCount: number;
    editCount: number;
    requiresDocker: boolean;
    failureClass?: string;
  };
  result: {
    success: boolean | null; // null = crashed
    gatesPassed: string[];
    gatesFailed: string[];
    totalMs: number;
    constraintsBefore: number;
    constraintsAfter: number;
    error?: string;
  };
  invariants: Array<{
    name: string;
    category: InvariantCategory;
    layer: InvariantLayer;
    passed: boolean;
    violation?: string;
    severity?: Severity;
  }>;
  clean: boolean;
  worstSeverity?: Severity;
}

export interface RunIdentity {
  runId: string;
  packageVersion: string;
  gitCommit?: string;
  runtime: string;
  platform: string;
  dockerVersion?: string;
}

export interface LedgerSummary {
  identity: RunIdentity;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalScenarios: number;
  cleanScenarios: number;
  dirtyScenarios: number;
  bugs: number;
  unexpected: number;
  info: number;
  byFamily: Record<string, { total: number; clean: number; dirty: number }>;
  topViolations: Array<{ invariant: string; count: number; severity: Severity; examples: string[] }>;
  failureClassCoverage?: Record<string, { scenarios: number; clean: number; dirty: number }>;
  oneLiner: string;
}

// =============================================================================
// RUNNER
// =============================================================================

export type LiveTier = 'pure' | 'live' | 'full';

export interface RunConfig {
  appDir: string;
  families?: ScenarioFamily[];
  dockerEnabled?: boolean;
  maxDockerScenarios?: number;
  parallelBatch?: number;
  ledgerPath?: string;
  failOnBug?: boolean;
  /** Tier 0: pure only (default). Tier 1: pure + Docker. Tier 2: pure + Docker + Playwright. */
  liveTier?: LiveTier;
  /** Include WPT harvested scenarios (7K+, adds ~15-20min). Opt-in via --wpt flag. */
  includeWPT?: boolean;
  /** Run only scenarios with these IDs (for subprocess validation — skip scenario generation overhead). */
  scenarioIds?: string[];
  /** Scenario source filter: 'synthetic' (default), 'real-world', or 'all'. */
  source?: 'synthetic' | 'real-world' | 'all';
}

// =============================================================================
// IMPROVEMENT ENGINE (autoresearch loop)
// =============================================================================

export type TriageConfidence = 'mechanical' | 'heuristic' | 'needs_llm';

export interface EvidenceBundle {
  id: string;
  violations: Array<{
    scenarioId: string;
    invariant: string;
    violation: string;
    severity: Severity;
    family: ScenarioFamily;
    scenarioDescription?: string;
    gatesFailed?: string[];
  }>;
  triage: {
    targetFunction: string | null;
    targetFile: string | null;
    failurePattern: string | null;
    confidence: TriageConfidence;
  };
}

export interface ProposedEdit {
  file: string;
  search?: string;
  replace: string;
  line?: number;  // 1-based line number — preferred over search for reliability
}

export interface FixCandidate {
  id: string;
  strategy: string;
  edits: ProposedEdit[];
  rationale: string;
}

export interface CandidateResult {
  candidateId: string;
  strategy: string;
  edits: ProposedEdit[];
  improvements: string[];   // scenario IDs that went dirty→clean
  regressions: string[];    // scenario IDs that went clean→dirty
  score: number;
  timedOut?: boolean;        // subprocess timed out (not necessarily a regression)
  appliedEdits?: number;     // how many edits were successfully applied
  skippedEdits?: number;     // how many edits failed to apply (search not found)
  partialScore?: number;     // (improvements - regressions) / totalDirty — for reporting
  holdoutSize?: number;      // holdout set size (for transparency)
}

export type ImprovementVerdict =
  | 'accepted'              // winner passed holdout
  | 'rejected_regression'   // best candidate has regressions
  | 'rejected_overfitting'  // holdout caught overfitting
  | 'rejected_no_fix'       // no candidate improved anything
  | 'skipped_all_clean'     // no violations to fix
  | 'skipped_no_llm';       // needs LLM but no provider configured

export interface ImprovementEntry {
  id: string;
  timestamp: string;
  bundle: {
    id: string;
    violationCount: number;
    triageConfidence: TriageConfidence;
  };
  diagnosis: string | null;
  candidates: CandidateResult[];
  winner: string | null;
  holdoutResult: 'clean' | 'regression' | 'skipped';
  verdict: ImprovementVerdict;
  cost: { inputTokens: number; outputTokens: number; calls: number };
}

export interface ImproveConfig {
  llm: 'gemini' | 'anthropic' | 'ollama' | 'claude' | 'claude-code' | 'none';
  apiKey?: string;
  ollamaModel?: string;
  ollamaHost?: string;
  /** Claude model override (default: claude-sonnet-4-20250514) */
  claudeModel?: string;
  maxCandidates: number;
  maxLines: number;
  dryRun: boolean;
}

export type LLMCallFn = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

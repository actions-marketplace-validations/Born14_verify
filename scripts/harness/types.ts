/**
 * Self-Test Harness Types
 * =======================
 * Shared interfaces for the autonomous testing loop.
 */

import type { Edit, Predicate, VerifyConfig, VerifyResult } from '../../src/types.js';

// =============================================================================
// SCENARIO
// =============================================================================

export type ScenarioFamily = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

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
  /** For multi-step scenarios (B family), ordered steps */
  steps?: VerifyScenario[];
  /** Expected verify() outcome (if known) */
  expectedSuccess?: boolean;
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
}

// =============================================================================
// ORACLE
// =============================================================================

export type InvariantCategory =
  | 'fingerprint' | 'k5' | 'gate_sequence' | 'containment'
  | 'grounding' | 'pipeline' | 'robustness';

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
  oneLiner: string;
}

// =============================================================================
// RUNNER
// =============================================================================

export interface RunConfig {
  appDir: string;
  families?: ScenarioFamily[];
  dockerEnabled?: boolean;
  maxDockerScenarios?: number;
  parallelBatch?: number;
  ledgerPath?: string;
  failOnBug?: boolean;
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
  search: string;
  replace: string;
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
  llm: 'gemini' | 'anthropic' | 'ollama' | 'none';
  apiKey?: string;
  ollamaModel?: string;
  ollamaHost?: string;
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

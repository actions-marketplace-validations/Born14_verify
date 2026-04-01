/**
 * Benchmark Types — Head-to-Head: Agent With Verify vs. Without
 * ==============================================================
 *
 * The one question: does verify actually make agents produce better code?
 * Not internally. Not synthetic. Real tasks, real agents, real outcomes.
 */

import type { Edit, Predicate, VerifyResult, GroundingContext } from '../../src/types.js';
import type { GovernResult, StopReason } from '../../src/govern.js';

// =============================================================================
// TASK DEFINITION
// =============================================================================

/** A single benchmark task — a real coding goal to attempt */
export interface BenchmarkTask {
  /** Unique task ID */
  id: string;
  /** Human-readable goal */
  goal: string;
  /** App directory to modify */
  appDir: string;
  /** Predicates the goal claims should be true after */
  predicates: Predicate[];
  /** Category for grouping results */
  category: string;
  /** Difficulty rating */
  difficulty: 'trivial' | 'moderate' | 'hard' | 'adversarial';
}

// =============================================================================
// INDEPENDENT VALIDATION (not verify — that's the whole point)
// =============================================================================

/**
 * Ground-truth check — did the edit actually work?
 * These checks are independent of verify's gate logic.
 */
export interface GroundTruthResult {
  /** Did the file changes actually apply? (file exists, content changed) */
  filesApplied: boolean;
  /** Details of file check failures */
  fileErrors: string[];

  /** Did the app's own tests pass? (npm test, pytest, etc.) */
  testsPass: boolean | null;
  /** Test output (truncated) */
  testOutput: string;

  /** Does the app start without crashing? */
  appStarts: boolean | null;
  /** Startup error if any */
  startupError: string;

  /** Do content predicates hold? (checked independently, not by verify) */
  contentPredicatesPass: boolean;
  /** Per-predicate results */
  predicateResults: Array<{
    predicate: Predicate;
    passed: boolean;
    reason: string;
  }>;

  /** Overall: is the goal actually achieved? */
  goalAchieved: boolean;
}

// =============================================================================
// PER-TASK RESULTS
// =============================================================================

/** Result of running one task WITHOUT verify (raw agent output) */
export interface RawRunResult {
  /** The edits the agent produced */
  edits: Edit[];
  /** Predicates the agent claimed */
  predicates: Predicate[];
  /** Did the agent produce any edits at all? */
  agentProducedEdits: boolean;
  /** Agent error if it crashed */
  agentError: string | null;
  /** Independent ground-truth check of the raw output */
  groundTruth: GroundTruthResult;
  /** Time taken (ms) */
  durationMs: number;
  /** LLM tokens used */
  tokens: { input: number; output: number };
}

/** Result of running one task WITH verify (govern loop) */
export interface GovernedRunResult {
  /** Final edits after convergence (or last attempt) */
  edits: Edit[];
  /** Final predicates */
  predicates: Predicate[];
  /** How many attempts govern used */
  attempts: number;
  /** Why govern stopped */
  stopReason: StopReason;
  /** Did govern converge (verify said pass)? */
  verifyPassed: boolean;
  /** Agent error if it crashed */
  agentError: string | null;
  /** Independent ground-truth check of the governed output */
  groundTruth: GroundTruthResult;
  /** Time taken (ms) */
  durationMs: number;
  /** Total LLM tokens across all attempts */
  tokens: { input: number; output: number };
}

// =============================================================================
// COMPARISON
// =============================================================================

/** Head-to-head result for one task */
export interface TaskComparison {
  task: BenchmarkTask;
  raw: RawRunResult;
  governed: GovernedRunResult;

  /** The verdict: who actually achieved the goal? */
  verdict: {
    /** Raw agent achieved the goal (ground truth) */
    rawAchieved: boolean;
    /** Governed agent achieved the goal (ground truth) */
    governedAchieved: boolean;
    /** Classification */
    outcome:
      | 'verify_saved'        // raw failed, governed succeeded — verify made the difference
      | 'both_succeeded'      // both achieved the goal — verify didn't hurt
      | 'both_failed'         // neither achieved — verify didn't help here
      | 'verify_overhead'     // raw succeeded, governed also succeeded but used more resources
      | 'verify_regression'   // raw succeeded, governed failed — verify made it worse (should be rare)
      | 'raw_no_edits'        // raw agent didn't produce edits
      | 'governed_no_edits'   // governed agent didn't produce edits
      | 'both_no_edits';      // neither produced edits
  };
}

// =============================================================================
// AGGREGATE RESULTS
// =============================================================================

/** Full benchmark run results */
export interface BenchmarkRun {
  /** Run identifier */
  runId: string;
  /** When it started */
  startedAt: string;
  /** When it completed */
  completedAt: string;

  /** LLM provider used */
  llmProvider: string;
  /** Model name */
  model: string;
  /** App(s) tested */
  apps: string[];

  /** Per-task comparisons */
  comparisons: TaskComparison[];

  /** Aggregate stats */
  summary: BenchmarkSummary;
}

/** The numbers that matter */
export interface BenchmarkSummary {
  totalTasks: number;

  // Raw agent (no verify)
  raw: {
    goalsAchieved: number;
    goalsFailed: number;
    noEdits: number;
    successRate: number;  // goalsAchieved / totalTasks
    avgDurationMs: number;
    totalTokens: { input: number; output: number };
  };

  // Governed agent (with verify)
  governed: {
    goalsAchieved: number;
    goalsFailed: number;
    noEdits: number;
    successRate: number;
    avgAttempts: number;
    avgDurationMs: number;
    totalTokens: { input: number; output: number };
  };

  // Head-to-head
  headToHead: {
    verifySaved: number;        // verify made the difference
    bothSucceeded: number;      // both fine
    bothFailed: number;         // neither worked
    verifyOverhead: number;     // both worked but verify used more resources
    verifyRegression: number;   // verify made it worse
  };

  // The headline number
  /** (governed.successRate - raw.successRate) / raw.successRate */
  improvementPercent: number;
  /** Net tasks saved by verify (verifySaved - verifyRegression) */
  netTasksSaved: number;
}

// =============================================================================
// CONFIG
// =============================================================================

export interface BenchmarkConfig {
  /** Tasks to run */
  tasks: BenchmarkTask[];
  /** LLM call function */
  llm: LLMCallFn;
  /** Provider name for reporting */
  llmProvider: string;
  /** Model name for reporting */
  model: string;
  /** Max attempts for govern() (default: 3) */
  maxGovAttempts: number;
  /** State directory */
  stateDir: string;
  /** Show verbose output */
  verbose: boolean;
  /** Skip ground-truth checks that require Docker */
  skipDocker: boolean;
}

export type LLMCallFn = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

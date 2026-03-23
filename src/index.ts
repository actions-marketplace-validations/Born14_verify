/**
 * @sovereign-labs/verify
 * ======================
 *
 * Verification gate for AI-generated code.
 * Every edit gets a fair trial before it touches your users.
 *
 * Usage:
 *   import { verify } from '@sovereign-labs/verify';
 *
 *   const result = await verify(edits, predicates, {
 *     appDir: './my-app',
 *     docker: { compose: true },
 *   });
 *
 *   if (!result.success) {
 *     console.log(result.narrowing); // what to try next
 *   }
 */

// The one function
export { verify } from './verify.js';

// Types — everything a consumer needs
export type {
  // Core
  Edit,
  Predicate,
  VerifyConfig,
  VerifyResult,
  Invariant,

  // Gate results
  GateResult,
  GateContext,
  Narrowing,
  NextMove,
  PredicateResult,

  // Runners
  ContainerRunner,
  ContainerRunnerOptions,
  CommandResult,

  // Grounding
  GroundingContext,
} from './types.js';

// Constraint store — for advanced users who want persistent learning
export { ConstraintStore, extractSignature, predicateFingerprint, classifyChangeType } from './store/constraint-store.js';

// Docker runner — for users who need custom container setup
export { LocalDockerRunner, isDockerAvailable, hasDockerCompose } from './runners/docker-runner.js';

// Grounding — for users who want to scan before submitting
export { groundInReality, validateAgainstGrounding } from './gates/grounding.js';

// Individual gates — for users who want to run gates separately
export { runSyntaxGate, applyEdits } from './gates/syntax.js';
export { runFilesystemGate, hashFile, isFilesystemPredicate } from './gates/filesystem.js';
export type { FilesystemGateResult, FilesystemPredicateResult } from './gates/filesystem.js';
export { runBrowserGate } from './gates/browser.js';
export { runVisionGate } from './gates/vision.js';
export { geminiVision, openaiVision, anthropicVision } from './vision-helpers.js';
export { runHttpGate } from './gates/http.js';
export { runInvariantsGate } from './gates/invariants.js';

// Fault ledger — track real-world gate faults for improvement
export { FaultLedger } from './store/fault-ledger.js';
export type {
  FaultEntry,
  FaultClassification,
  FaultSummary,
  CrossCheckEvidence,
  RecordContext,
} from './store/fault-ledger.js';

// External scenario store — encode faults as permanent self-test scenarios
export { ExternalScenarioStore, classifyTransferability, classifyCategory } from './store/external-scenarios.js';
export type {
  SerializedScenario,
  ScenarioIntent,
  ScenarioTransferability,
  ScenarioCategory,
} from './store/external-scenarios.js';

// Message gate — governed outbound communication assertions
export { governMessage, runMessageGate } from './gates/message.js';
export type {
  MessageEnvelope,
  MessagePolicy,
  MessageGateResult,
  MessageGateContext,
  MessageVerdict,
  MessageBlockReason,
  MessageClarifyReason,
  ClaimResult,
  EvidenceProvider,
  EvidenceResult,
  ReviewVerdict,
  TopicResolution,
} from './gates/message.js';

// Parsers — convert external formats into Edit[]
export { parseDiff } from './parsers/git-diff.js';

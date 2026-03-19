/**
 * Fault Ledger — Real-World Gate Fault Discovery
 * ================================================
 *
 * Captures cases where verify judged wrong — false positives, false negatives,
 * and bad hints. This is the bridge between "failure discovered" and
 * "scenario encoded in the harness."
 *
 * Append-only JSONL. Each entry is a gate fault waiting to be encoded as a
 * permanent self-test scenario. Once encoded, the improve loop guards it forever.
 *
 * Two entry modes:
 *   - Auto-classified: verify's own telemetry + cross-check probes
 *   - Human-classified: operator reviews ambiguous cases
 *
 * Usage:
 *   import { FaultLedger } from '@sovereign-labs/verify';
 *
 *   const ledger = new FaultLedger('.verify/faults.jsonl');
 *   ledger.recordFromResult(result, { app: 'myapp', goal: 'change color' });
 *   ledger.getUnencoded();  // faults waiting for scenarios
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { extractSignature, predicateFingerprint } from './constraint-store.js';
import type { VerifyResult, Predicate } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * How verify was wrong:
 * - false_positive: verify said PASS but the app is actually broken
 * - false_negative: verify said FAIL but the edit was actually correct
 * - bad_hint: verify's narrowing/hint sent the agent in the wrong direction
 * - correct: verify judged correctly (not a fault — logged for completeness)
 * - agent_fault: the agent was wrong, verify was right (not a verify bug)
 * - ambiguous: auto-classifier couldn't determine (needs human review)
 */
export type FaultClassification =
  | 'false_positive'
  | 'false_negative'
  | 'bad_hint'
  | 'correct'
  | 'agent_fault'
  | 'ambiguous';

/**
 * How this fault was classified:
 * - auto: cross-check probes determined the classification
 * - human: operator manually classified
 * - auto_override: was auto, human corrected it
 */
export type ClassificationSource = 'auto' | 'human' | 'auto_override';

/**
 * Confidence in the auto-classification:
 * - high: cross-check evidence is unambiguous (verify said PASS, health returns 500)
 * - medium: evidence suggests a fault but not certain
 * - low: weak signal, needs human review
 */
export type ClassificationConfidence = 'high' | 'medium' | 'low';

/**
 * Cross-check probe results used for auto-classification.
 * These are independent checks run after verify produces its verdict.
 */
export interface CrossCheckEvidence {
  /** HTTP health probe result (null if not run) */
  healthProbe?: {
    path: string;
    status: number | null;
    ok: boolean;
  };
  /** Playwright screenshot/DOM check (null if not run) */
  browserProbe?: {
    passed: boolean;
    detail: string;
  };
  /** Database schema check (null if not run) */
  dbProbe?: {
    passed: boolean;
    detail: string;
  };
  /** Custom probe results */
  custom?: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}

/**
 * A single fault ledger entry — one real-world gate fault (or non-fault).
 */
export interface FaultEntry {
  /** Unique fault ID (vf-{timestamp}-{random}) */
  id: string;

  /** When this was logged */
  timestamp: string;

  /** App this submission was against */
  app: string;

  /** The goal that was submitted */
  goal: string;

  // --- Verify's verdict ---

  /** Did verify say the submission passed? */
  verifyPassed: boolean;

  /** Which gate failed (null if verify passed) */
  failedGate: string | null;

  /** Verify's attestation string */
  attestation: string;

  /** Failure signature from extractSignature() */
  signature: string | null;

  /** Gate results summary */
  gatesSummary: Array<{ gate: string; passed: boolean; durationMs: number }>;

  // --- Classification ---

  /** How verify was wrong (or right) */
  classification: FaultClassification;

  /** How the classification was determined */
  source: ClassificationSource;

  /** Confidence in auto-classification */
  confidence: ClassificationConfidence;

  /** Why this classification was chosen */
  reason: string;

  // --- Evidence ---

  /** Cross-check probe results (for auto-classification) */
  crossCheck?: CrossCheckEvidence;

  /** Predicate fingerprints involved */
  predicateFingerprints?: string[];

  /** Predicate results from verify (expected vs actual) */
  predicateResults?: Array<{
    type: string;
    passed: boolean;
    expected?: string;
    actual?: string;
    fingerprint: string;
  }>;

  /** Narrowing hint verify gave (if any) */
  narrowingHint?: string;

  // --- Scenario linkage ---

  /** Scenario ID once encoded (null = waiting to be encoded) */
  scenarioId: string | null;

  /** Notes from human review */
  notes?: string;
}

/**
 * Input for auto-recording from a VerifyResult.
 */
export interface RecordContext {
  app: string;
  goal: string;
  predicates?: Predicate[];
  crossCheck?: CrossCheckEvidence;
}

/**
 * Summary statistics for the fault ledger.
 */
export interface FaultSummary {
  total: number;
  byClassification: Record<FaultClassification, number>;
  unencoded: number;
  encoded: number;
  needsReview: number;
  recentFaults: FaultEntry[];
}

// =============================================================================
// AUTO-CLASSIFICATION
// =============================================================================

/**
 * Auto-classify a verify result using cross-check evidence.
 *
 * Rules (in priority order):
 * 1. Verify PASS + health probe FAIL → false_positive (high)
 * 2. Verify PASS + browser probe FAIL → false_positive (high)
 * 3. Verify FAIL + all cross-checks PASS → false_negative (medium)
 * 4. Verify FAIL + no cross-check evidence → ambiguous (low)
 * 5. Verify PASS + no cross-check evidence → ambiguous (low)
 * 6. Verify FAIL + cross-checks also FAIL → agent_fault (high)
 * 7. Verify PASS + cross-checks also PASS → correct (high)
 */
function autoClassify(
  result: VerifyResult,
  crossCheck?: CrossCheckEvidence,
): { classification: FaultClassification; confidence: ClassificationConfidence; reason: string } {

  const verifyPassed = result.success;

  // No cross-check evidence — can't determine
  if (!crossCheck) {
    return {
      classification: 'ambiguous',
      confidence: 'low',
      reason: 'No cross-check evidence available',
    };
  }

  const hasHealthProbe = crossCheck.healthProbe !== undefined;
  const hasBrowserProbe = crossCheck.browserProbe !== undefined;
  const hasDbProbe = crossCheck.dbProbe !== undefined;
  const hasAnyProbe = hasHealthProbe || hasBrowserProbe || hasDbProbe || (crossCheck.custom?.length ?? 0) > 0;

  if (!hasAnyProbe) {
    return {
      classification: 'ambiguous',
      confidence: 'low',
      reason: 'Cross-check object present but no probes ran',
    };
  }

  // Gather probe results
  const probeResults: boolean[] = [];
  if (hasHealthProbe) probeResults.push(crossCheck.healthProbe!.ok);
  if (hasBrowserProbe) probeResults.push(crossCheck.browserProbe!.passed);
  if (hasDbProbe) probeResults.push(crossCheck.dbProbe!.passed);
  if (crossCheck.custom) {
    for (const c of crossCheck.custom) probeResults.push(c.passed);
  }

  const allProbesPass = probeResults.every(p => p);
  const anyProbeFail = probeResults.some(p => !p);

  // --- VERIFY SAID PASS ---
  if (verifyPassed) {
    // Verify PASS + health/browser FAIL → false positive (verify missed a real problem)
    if (hasHealthProbe && !crossCheck.healthProbe!.ok) {
      return {
        classification: 'false_positive',
        confidence: 'high',
        reason: `Verify passed but health probe returned ${crossCheck.healthProbe!.status ?? 'null'} on ${crossCheck.healthProbe!.path}`,
      };
    }
    if (hasBrowserProbe && !crossCheck.browserProbe!.passed) {
      return {
        classification: 'false_positive',
        confidence: 'high',
        reason: `Verify passed but browser probe failed: ${crossCheck.browserProbe!.detail}`,
      };
    }
    if (hasDbProbe && !crossCheck.dbProbe!.passed) {
      return {
        classification: 'false_positive',
        confidence: 'medium',
        reason: `Verify passed but DB probe failed: ${crossCheck.dbProbe!.detail}`,
      };
    }
    // Verify PASS + all probes PASS → correct
    if (allProbesPass) {
      return {
        classification: 'correct',
        confidence: 'high',
        reason: 'Verify passed and all cross-check probes confirm',
      };
    }
  }

  // --- VERIFY SAID FAIL ---
  if (!verifyPassed) {
    // Verify FAIL + all probes PASS → likely false negative
    if (allProbesPass) {
      return {
        classification: 'false_negative',
        confidence: 'medium',
        reason: 'Verify failed but all cross-check probes passed — edit may be correct',
      };
    }
    // Verify FAIL + probes also FAIL → agent was wrong, verify was right
    if (anyProbeFail) {
      return {
        classification: 'agent_fault',
        confidence: 'high',
        reason: 'Verify failed and cross-check probes confirm the failure',
      };
    }
  }

  return {
    classification: 'ambiguous',
    confidence: 'low',
    reason: 'Cross-check evidence is inconclusive',
  };
}

/**
 * Detect internal contradictions in verify's own result.
 * These are verify bugs regardless of app state.
 */
function detectContradictions(result: VerifyResult): string[] {
  const contradictions: string[] = [];

  // Success but a gate failed
  if (result.success && result.gates.some(g => !g.passed)) {
    contradictions.push(
      `Attestation says success but gate ${result.gates.find(g => !g.passed)!.gate} failed`
    );
  }

  // Failure but all gates passed
  if (!result.success && result.gates.length > 0 && result.gates.every(g => g.passed)) {
    contradictions.push('All gates passed but result.success is false');
  }

  // Negative duration on any gate
  for (const g of result.gates) {
    if (g.durationMs < 0) {
      contradictions.push(`Gate ${g.gate} has negative duration: ${g.durationMs}ms`);
    }
  }

  // Predicate results contradict gate results
  if (result.predicateResults && result.predicateResults.length > 0) {
    const allPredicatesPass = result.predicateResults.every(p => p.passed);
    const browserGate = result.gates.find(g => g.gate === 'browser');
    if (browserGate && browserGate.passed && !allPredicatesPass) {
      contradictions.push('Browser gate passed but some predicates failed');
    }
  }

  return contradictions;
}


// =============================================================================
// FAULT LEDGER
// =============================================================================

export class FaultLedger {
  private path: string;
  private entries: FaultEntry[];

  constructor(path: string) {
    this.path = path;
    this.entries = this.load();
  }

  // ---------------------------------------------------------------------------
  // LOAD
  // ---------------------------------------------------------------------------

  private load(): FaultEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, 'utf-8');
      return raw
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as FaultEntry);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // APPEND
  // ---------------------------------------------------------------------------

  private append(entry: FaultEntry): void {
    this.entries.push(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  // ---------------------------------------------------------------------------
  // RECORD FROM VERIFY RESULT (auto-classification)
  // ---------------------------------------------------------------------------

  /**
   * Record a fault entry from a VerifyResult with optional cross-check probes.
   * Auto-classifies using cross-check evidence and contradiction detection.
   *
   * Returns the created entry (or null if skipped due to dedup).
   */
  recordFromResult(result: VerifyResult, context: RecordContext): FaultEntry | null {
    // Dedup: skip if same app+goal+attestation within last 60 seconds
    const now = new Date();
    const recent = this.entries.find(e =>
      e.app === context.app &&
      e.goal === context.goal &&
      e.attestation === result.attestation &&
      (now.getTime() - new Date(e.timestamp).getTime()) < 60_000
    );
    if (recent) return null;

    // Check for internal contradictions first
    const contradictions = detectContradictions(result);

    // Auto-classify
    let classified: { classification: FaultClassification; confidence: ClassificationConfidence; reason: string };

    if (contradictions.length > 0) {
      // Internal contradictions are always verify bugs
      classified = {
        classification: result.success ? 'false_positive' : 'false_negative',
        confidence: 'high',
        reason: `Internal contradiction: ${contradictions[0]}`,
      };
    } else {
      classified = autoClassify(result, context.crossCheck);
    }

    // Extract failure info
    const failedGate = result.gates.find(g => !g.passed);
    const failureDetail = failedGate?.detail ?? result.attestation;
    const signature = !result.success ? extractSignature(failureDetail) ?? null : null;

    // Build predicate fingerprints
    const predicateFingerprints = context.predicates
      ? context.predicates.map(p => predicateFingerprint(p))
      : result.effectivePredicates?.map(ep => ep.fingerprint);

    const entry: FaultEntry = {
      id: `vf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now.toISOString(),
      app: context.app,
      goal: context.goal,

      verifyPassed: result.success,
      failedGate: failedGate?.gate ?? null,
      attestation: result.attestation,
      signature,
      gatesSummary: result.gates.map(g => ({
        gate: g.gate,
        passed: g.passed,
        durationMs: g.durationMs,
      })),

      classification: classified.classification,
      source: 'auto',
      confidence: classified.confidence,
      reason: classified.reason,

      crossCheck: context.crossCheck,
      predicateFingerprints,
      predicateResults: result.predicateResults?.map(pr => ({
        type: pr.type,
        passed: pr.passed,
        expected: pr.expected,
        actual: pr.actual,
        fingerprint: pr.fingerprint,
      })),
      narrowingHint: result.narrowing?.resolutionHint,

      scenarioId: null,
    };

    this.append(entry);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // RECORD MANUALLY (human classification)
  // ---------------------------------------------------------------------------

  /**
   * Record a fault entry with human classification.
   */
  recordManual(entry: {
    app: string;
    goal: string;
    verifyPassed: boolean;
    failedGate?: string;
    classification: FaultClassification;
    reason: string;
    attestation?: string;
    signature?: string;
    scenarioId?: string;
    notes?: string;
  }): FaultEntry {
    const fault: FaultEntry = {
      id: `vf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      app: entry.app,
      goal: entry.goal,

      verifyPassed: entry.verifyPassed,
      failedGate: entry.failedGate ?? null,
      attestation: entry.attestation ?? '',
      signature: entry.signature ?? null,
      gatesSummary: [],

      classification: entry.classification,
      source: 'human',
      confidence: 'high',
      reason: entry.reason,

      scenarioId: entry.scenarioId ?? null,
      notes: entry.notes,
    };

    this.append(fault);
    return fault;
  }

  // ---------------------------------------------------------------------------
  // RECLASSIFY (human overrides auto)
  // ---------------------------------------------------------------------------

  /**
   * Override the classification of an existing entry.
   * Rewrites the ledger (append-only semantics preserved via full rewrite).
   */
  reclassify(id: string, classification: FaultClassification, reason: string): FaultEntry | null {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return null;

    entry.classification = classification;
    entry.source = 'auto_override';
    entry.confidence = 'high';
    entry.reason = reason;

    this.rewrite();
    return entry;
  }

  // ---------------------------------------------------------------------------
  // LINK SCENARIO (fault → permanent harness test)
  // ---------------------------------------------------------------------------

  /**
   * Link a fault to an encoded scenario.
   * This marks the fault as "handled" — the improve loop now guards it.
   */
  linkScenario(id: string, scenarioId: string): FaultEntry | null {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return null;

    entry.scenarioId = scenarioId;
    this.rewrite();
    return entry;
  }

  // ---------------------------------------------------------------------------
  // QUERIES
  // ---------------------------------------------------------------------------

  /** All entries */
  all(): FaultEntry[] {
    return [...this.entries];
  }

  /** Faults not yet encoded as scenarios (the inbox) */
  getUnencoded(): FaultEntry[] {
    return this.entries.filter(e =>
      e.scenarioId === null &&
      e.classification !== 'correct' &&
      e.classification !== 'agent_fault'
    );
  }

  /** Faults needing human review (ambiguous or low confidence) */
  getNeedsReview(): FaultEntry[] {
    return this.entries.filter(e =>
      e.classification === 'ambiguous' ||
      (e.source === 'auto' && e.confidence === 'low')
    );
  }

  /** Faults by classification */
  getByClassification(classification: FaultClassification): FaultEntry[] {
    return this.entries.filter(e => e.classification === classification);
  }

  /** Faults for a specific app */
  getByApp(app: string): FaultEntry[] {
    return this.entries.filter(e => e.app === app);
  }

  /** Only confirmed verify bugs (false_positive, false_negative, bad_hint) */
  getVerifyBugs(): FaultEntry[] {
    return this.entries.filter(e =>
      e.classification === 'false_positive' ||
      e.classification === 'false_negative' ||
      e.classification === 'bad_hint'
    );
  }

  /** Summary statistics */
  summarize(): FaultSummary {
    const byClassification: Record<FaultClassification, number> = {
      false_positive: 0,
      false_negative: 0,
      bad_hint: 0,
      correct: 0,
      agent_fault: 0,
      ambiguous: 0,
    };

    for (const e of this.entries) {
      byClassification[e.classification]++;
    }

    const unencoded = this.getUnencoded();
    const encoded = this.entries.filter(e => e.scenarioId !== null);
    const needsReview = this.getNeedsReview();

    return {
      total: this.entries.length,
      byClassification,
      unencoded: unencoded.length,
      encoded: encoded.length,
      needsReview: needsReview.length,
      recentFaults: this.entries.slice(-10),
    };
  }

  // ---------------------------------------------------------------------------
  // INTERNAL
  // ---------------------------------------------------------------------------

  private rewrite(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const content = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(this.path, content);
  }
}

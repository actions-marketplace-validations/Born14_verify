/**
 * Deterministic Triage — 0 LLM tokens
 * =====================================
 *
 * Maps violation patterns to target functions and files.
 * When confidence is 'mechanical', skip LLM diagnosis entirely.
 */

import type { LedgerEntry, EvidenceBundle, Severity, TriageConfidence } from './types.js';

// =============================================================================
// TRIAGE RULES — violation pattern → target function/file
// =============================================================================

interface TriageRule {
  pattern: RegExp;
  targetFunction: string;
  targetFile: string;
  confidence: TriageConfidence;
}

const TRIAGE_RULES: TriageRule[] = [
  // Fingerprint invariants → predicateFingerprint()
  {
    pattern: /^fingerprint_distinct/,
    targetFunction: 'predicateFingerprint()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^fingerprint_deterministic/,
    targetFunction: 'predicateFingerprint()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },

  // K5 constraint invariants → checkConstraints() / seedFromFailure()
  {
    pattern: /^k5_should_block/,
    targetFunction: 'checkConstraints()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^k5_should_pass/,
    targetFunction: 'checkConstraints()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^constraint_monotonicity/,
    targetFunction: 'seedFromFailure()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^constraint_count/,
    targetFunction: 'seedFromFailure()',
    targetFile: 'src/store/constraint-store.ts',
    confidence: 'mechanical',
  },

  // Gate sequencing → verify()
  {
    pattern: /^gate_order/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^disabled_gates_absent/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^gate_count/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^gate_timing/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^failed_gate_has_detail/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'heuristic',
  },

  // Gate sequence consistency
  {
    pattern: /^gate_success_consistency/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^result_well_formedness/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^first_failing_gate/,
    targetFunction: 'verify()',
    targetFile: 'src/verify.ts',
    confidence: 'mechanical',
  },

  // ─── Vision gate invariants → vision.ts ───
  {
    pattern: /^vision_gate_skipped/,
    targetFunction: 'runVisionGate()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^vision_gate_passed/,
    targetFunction: 'runVisionGate()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^vision_gate_failed/,
    targetFunction: 'runVisionGate()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^vision_gate_ran/,
    targetFunction: 'runVisionGate()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^vision_claim_verified/,
    targetFunction: 'parseVisionResponse()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^vision_claim_not_verified/,
    targetFunction: 'parseVisionResponse()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'mechanical',
  },

  // ─── Triangulation invariants → triangulation.ts ───
  {
    pattern: /^triangulation_action/,
    targetFunction: 'triangulate()',
    targetFile: 'src/gates/triangulation.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^triangulation_outlier/,
    targetFunction: 'triangulate()',
    targetFile: 'src/gates/triangulation.ts',
    confidence: 'mechanical',
  },
  {
    pattern: /^triangulation_confidence/,
    targetFunction: 'triangulate()',
    targetFile: 'src/gates/triangulation.ts',
    confidence: 'mechanical',
  },

  // ─── Fault-derived scenario invariants (from external-scenario-loader.ts) ───

  // false_positive intent → should_detect_problem (verify passed but should fail)
  {
    pattern: /^should_detect_problem/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },

  // false_positive + expectedFailedGate → should_fail_at_{gate}
  {
    pattern: /^should_fail_at_grounding/,
    targetFunction: 'runGroundingGate()',
    targetFile: 'src/gates/grounding.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_browser/,
    targetFunction: 'runBrowserGate()',
    targetFile: 'src/gates/browser.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_constraints/,
    targetFunction: 'runConstraintGate()',
    targetFile: 'src/gates/constraints.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_containment/,
    targetFunction: 'runContainmentGate()',
    targetFile: 'src/gates/containment.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_syntax/,
    targetFunction: 'runSyntaxGate()',
    targetFile: 'src/gates/syntax.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_http/,
    targetFunction: 'runHttpGate()',
    targetFile: 'src/gates/http.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_vision/,
    targetFunction: 'runVisionGate()',
    targetFile: 'src/gates/vision.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_triangulation/,
    targetFunction: 'runTriangulationGate()',
    targetFile: 'src/gates/triangulation.ts',
    confidence: 'heuristic',
  },
  {
    pattern: /^should_fail_at_/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },

  // false_negative intent → should_accept_valid_edit
  {
    pattern: /^should_accept_valid_edit/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },

  // bad_hint intent → narrowing_should_be_helpful
  {
    pattern: /^narrowing_should_be_helpful/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },

  // regression_guard intent → outcome_matches_expected
  {
    pattern: /^outcome_matches_expected/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },

  // ─── Robustness → depends on stack trace ───
  {
    pattern: /^should_not_crash/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },
  {
    pattern: /^no_crash/,
    targetFunction: '',
    targetFile: '',
    confidence: 'needs_llm',
  },
];

// =============================================================================
// BUNDLE VIOLATIONS BY ROOT CAUSE
// =============================================================================

export function bundleViolations(entries: LedgerEntry[]): EvidenceBundle[] {
  const dirty = entries.filter(e => !e.clean);
  if (dirty.length === 0) return [];

  // Group by invariant prefix + gate (so grounding bugs and security bugs
  // don't land in the same bundle even if they share an invariant category).
  //
  // For false-positive scenarios (verify passed, gatesFailed is empty), infer
  // the gate from the scenario description so they land in domain-specific
  // bundles instead of one giant "should_detect_problem::invariant" bucket.
  const MAX_BUNDLE_SIZE = 20;
  const groups = new Map<string, EvidenceBundle['violations']>();
  for (const entry of dirty) {
    for (const inv of entry.invariants) {
      if (inv.passed) continue;
      const invariantKey = invariantGroupKey(inv.name);
      let gate = entry.result.gatesFailed[0] ?? '';
      if (!gate) {
        // No gate failed — likely a false positive. Infer gate from description
        // so violations get routed to domain-specific bundles.
        gate = inferGateFromDescription(entry.scenario.description ?? '') ?? 'invariant';
      }
      const key = `${invariantKey}::${gate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        scenarioId: entry.id,
        invariant: inv.name,
        violation: inv.violation ?? 'unknown',
        severity: (inv.severity ?? 'bug') as Severity,
        family: entry.scenario.family as any,
        scenarioDescription: entry.scenario.description,
        gatesFailed: entry.result.gatesFailed,
      });
    }
  }

  // Convert to bundles with triage, splitting oversized groups
  const bundles: EvidenceBundle[] = [];
  let bundleCounter = 0;
  for (const [key, violations] of groups) {
    // Split groups larger than MAX_BUNDLE_SIZE into chunks
    for (let i = 0; i < violations.length; i += MAX_BUNDLE_SIZE) {
      const chunk = violations.slice(i, i + MAX_BUNDLE_SIZE);
      const triage = triageByInvariantKey(key.split('::')[0]);
      const bundle: EvidenceBundle = {
        id: `bundle_${++bundleCounter}`,
        violations: chunk,
        triage,
      };
      refineTriage(bundle);
      bundles.push(bundle);
    }
  }

  return bundles;
}

function invariantGroupKey(name: string): string {
  // Strip trailing specifics: "fingerprint_distinct_A_vs_B" → "fingerprint_distinct"
  // Keep enough to distinguish invariant categories
  const parts = name.split('_');
  // For named invariants like "k5_should_block: description", take before colon
  const base = name.split(':')[0].trim();
  // Group by first 2-3 meaningful segments
  if (base.startsWith('fingerprint_distinct')) return 'fingerprint_distinct';
  if (base.startsWith('fingerprint_deterministic')) return 'fingerprint_deterministic';
  if (base.startsWith('k5_should_block')) return 'k5_should_block';
  if (base.startsWith('k5_should_pass')) return 'k5_should_pass';
  if (base.startsWith('constraint_count')) return 'constraint_count';
  if (base.startsWith('gate_order')) return 'gate_order';
  if (base.startsWith('gate_count')) return 'gate_count';
  if (base.startsWith('should_not_crash')) return 'should_not_crash';
  if (base.startsWith('should_detect_problem')) return 'should_detect_problem';
  if (base.startsWith('vision_gate')) return 'vision_gate';
  if (base.startsWith('vision_claim')) return 'vision_claim';
  if (base.startsWith('triangulation_action')) return 'triangulation_action';
  if (base.startsWith('triangulation_outlier')) return 'triangulation_outlier';
  if (base.startsWith('triangulation_confidence')) return 'triangulation_confidence';
  if (base.startsWith('should_fail_at_')) return base; // keep gate-specific key
  if (base.startsWith('should_accept_valid_edit')) return 'should_accept_valid_edit';
  if (base.startsWith('narrowing_should_be_helpful')) return 'narrowing_should_be_helpful';
  if (base.startsWith('outcome_matches_expected')) return 'outcome_matches_expected';
  return base;
}

function triageByInvariantKey(key: string): EvidenceBundle['triage'] {
  for (const rule of TRIAGE_RULES) {
    if (rule.pattern.test(key)) {
      return {
        targetFunction: rule.targetFunction || null,
        targetFile: rule.targetFile || null,
        failurePattern: key,
        confidence: rule.confidence,
      };
    }
  }
  return {
    targetFunction: null,
    targetFile: null,
    failurePattern: key,
    confidence: 'needs_llm',
  };
}

// Gate name → source file mapping for violation-text extraction
const GATE_FILE_MAP: Record<string, string> = {
  security: 'src/gates/security.ts',
  a11y: 'src/gates/a11y.ts',
  grounding: 'src/gates/grounding.ts',
  browser: 'src/gates/browser.ts',
  constraints: 'src/gates/constraints.ts',
  containment: 'src/gates/containment.ts',
  syntax: 'src/gates/syntax.ts',
  http: 'src/gates/http.ts',
  vision: 'src/gates/vision.ts',
  triangulation: 'src/gates/triangulation.ts',
  filesystem: 'src/gates/filesystem.ts',
  performance: 'src/gates/performance.ts',
  config: 'src/gates/config.ts',
  serialization: 'src/gates/serialization.ts',
  infrastructure: 'src/gates/infrastructure.ts',
  staging: 'src/gates/staging.ts',
  propagation: 'src/gates/propagation.ts',
  observation: 'src/gates/observation.ts',
  contention: 'src/gates/contention.ts',
  temporal: 'src/gates/temporal.ts',
  state: 'src/gates/state.ts',
  capacity: 'src/gates/capacity.ts',
  access: 'src/gates/access.ts',
  message: 'src/gates/message.ts',
  invariants: 'src/gates/invariants.ts',
};

// Predicate type → most likely gate that validates it
const PREDICATE_TYPE_TO_GATE: Record<string, string> = {
  css: 'grounding',
  html: 'grounding',
  content: 'grounding',
  http: 'http',
  http_sequence: 'http',
  db: 'grounding',
  filesystem_exists: 'filesystem',
  filesystem_absent: 'filesystem',
  filesystem_unchanged: 'filesystem',
  filesystem_count: 'filesystem',
  infra_resource: 'infrastructure',
  infra_attribute: 'infrastructure',
  infra_manifest: 'infrastructure',
  serialization: 'serialization',
  config: 'config',
  security: 'security',
  a11y: 'a11y',
  performance: 'performance',
  hallucination: 'grounding',
};

/**
 * Refine triage for bundles with null targetFile by extracting
 * the failing gate name from violation text, sibling violations,
 * or predicate types.
 *
 * Tries patterns in priority order: specific gate mentions first,
 * then sibling violations, then predicate type inference, then
 * last-resort verify.ts (which is frozen, so this is a dead end).
 */
function refineTriage(bundle: EvidenceBundle): void {
  if (bundle.triage.targetFile) return; // already resolved

  for (const v of bundle.violations) {
    // Pattern 1: "verify failed at {gate} but should pass" (false_negative)
    const failedAt = v.violation.match(/failed at (\w+)/);
    if (failedAt) {
      const gate = failedAt[1].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
    // Pattern 2: "Gate {gate} should have failed but passed" (false_positive with expectedFailedGate)
    const shouldFail = v.violation.match(/Gate (\w+) should have failed/);
    if (shouldFail) {
      const gate = shouldFail[1].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
    // Pattern 3: "Crashed: ..." — extract file from stack trace or error
    const crashed = v.violation.match(/Crashed:.*?(src\/[\w\/\-]+\.ts)/);
    if (crashed) {
      const file = crashed[1];
      if (GATE_FILE_MAP[file] || BOUNDED_SURFACE.some(s => s.file === file)) {
        bundle.triage.targetFile = file;
        return;
      }
    }
    // Pattern 4: Extract gate from invariant name (e.g., "should_fail_at_grounding")
    const invariantGate = v.invariant.match(/should_fail_at_(\w+)/);
    if (invariantGate) {
      const gate = invariantGate[1].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
    // Pattern 5: Extract gate from gatesFailed array on the violation
    if (v.gatesFailed?.length) {
      const gate = v.gatesFailed[0].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
    // Pattern 6: "Expected gate {gate} not found in results" — gate didn't run
    const expectedGate = v.violation.match(/Expected gate (\w+) not found/);
    if (expectedGate) {
      const gate = expectedGate[1].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
  }

  // ── Patterns 7-8: cross-violation inference for should_detect_problem ──
  // These scenarios say "verify passed but should fail" — the bug is in a
  // gate that should have caught the problem, NOT in verify.ts.

  // Pattern 7: Look at sibling invariant violations in the same bundle.
  // If any sibling says should_fail_at_{gate}, that's our target.
  for (const v of bundle.violations) {
    const siblingGate = v.invariant.match(/should_fail_at_(\w+)/);
    if (siblingGate) {
      const gate = siblingGate[1].toLowerCase();
      const file = GATE_FILE_MAP[gate];
      if (file) {
        bundle.triage.targetFile = file;
        bundle.triage.targetFunction = `run${gate.charAt(0).toUpperCase()}${gate.slice(1)}Gate()`;
        return;
      }
    }
  }

  // Pattern 8: Infer gate from scenario's predicate types.
  // For false_positive scenarios, the predicate type tells us which gate
  // should have caught the problem. Count predicate types across violations
  // and pick the most common one.
  const gateVotes = new Map<string, number>();
  for (const v of bundle.violations) {
    // The scenario description often contains predicate type hints
    // e.g., "http: health endpoint response contains injection text"
    // e.g., "CSS: selector .foo should not match"
    const descGate = inferGateFromDescription(v.scenarioDescription ?? '');
    if (descGate) {
      gateVotes.set(descGate, (gateVotes.get(descGate) ?? 0) + 1);
    }
  }
  if (gateVotes.size > 0) {
    // Pick the gate with the most votes
    let bestGate = '';
    let bestCount = 0;
    for (const [gate, count] of gateVotes) {
      if (count > bestCount) {
        bestGate = gate;
        bestCount = count;
      }
    }
    const file = GATE_FILE_MAP[bestGate];
    if (file) {
      bundle.triage.targetFile = file;
      bundle.triage.targetFunction = `run${bestGate.charAt(0).toUpperCase()}${bestGate.slice(1)}Gate()`;
      return;
    }
  }

  // Pattern 9 (last resort): "verify passed but should fail"
  // Only route to verify.ts if no gate could be inferred. This is a dead end
  // since verify.ts is frozen, but at least the bundle gets logged.
  for (const v of bundle.violations) {
    if (v.violation.includes('verify passed but should fail')) {
      bundle.triage.targetFile = 'src/verify.ts';
      bundle.triage.targetFunction = 'verify()';
      return;
    }
  }
}

/**
 * Infer a gate name from a scenario description string.
 * Looks for common prefixes and keywords.
 */
function inferGateFromDescription(desc: string): string | null {
  const d = desc.toLowerCase();
  // Explicit prefixes from scenario generators
  if (d.startsWith('sec-') || d.startsWith('sec:') || d.includes('injection') || d.includes('xss') || d.includes('csrf') || d.includes('secret'))
    return 'security';
  if (d.startsWith('a11y') || d.includes('aria-') || d.includes('aria label') || d.includes('alt text') || d.includes('heading hierarchy') || d.includes('focus management') || d.includes('landmark'))
    return 'a11y';
  if (d.startsWith('perf') || d.includes('bundle size') || d.includes('lazy loading') || d.includes('render blocking'))
    return 'performance';
  if (d.startsWith('inj-') && d.includes('http'))
    return 'http';
  if (d.includes('http:') || d.includes('status code') || d.includes('bodycontains') || d.includes('response'))
    return 'http';
  // Cross-file/propagation before config — "Cross-file: server.js vs config.json" is propagation, not config
  if (d.includes('cross-file') || d.includes('propagat'))
    return 'propagation';
  if (d.startsWith('cfg') || d.startsWith('config:') || d.startsWith('config '))
    return 'config';
  if (d.startsWith('ser') || d.includes('serialization') || d.includes('schema'))
    return 'serialization';
  if (d.includes('contention') || d.includes('race'))
    return 'contention';
  if (d.includes('temporal') || d.includes('stale'))
    return 'temporal';
  if (d.includes('filesystem') || d.includes('file exists') || d.includes('file absent'))
    return 'filesystem';
  if (d.includes('access') || d.includes('privilege') || d.includes('permission'))
    return 'access';
  if (d.includes('capacity') || d.includes('resource'))
    return 'capacity';
  if (d.startsWith('css') || d.includes('selector') || d.includes('postcss'))
    return 'grounding';
  if (d.startsWith('html') || d.includes('element'))
    return 'grounding';
  if (d.includes('k5') || d.includes('constraint'))
    return 'constraints';
  if (d.includes('containment') || d.includes('g5'))
    return 'containment';
  if (d.includes('syntax') || d.includes('f9'))
    return 'syntax';
  return null;
}

// =============================================================================
// BOUNDED SURFACE — files the improvement engine is allowed to edit
// =============================================================================
//
// The bounded surface includes PREDICATE GATES — gates that evaluate truth
// claims about the world (CSS values, HTTP responses, file state, etc.).
// These have clear correctness criteria and benefit from self-improvement.
//
// Two gate categories are intentionally EXCLUDED:
//
//   ENVIRONMENT GATES (staging.ts):
//     Staging orchestrates Docker build/start — it's infrastructure, not
//     predicate logic. Letting the improve loop mutate staging risks teaching
//     it to swallow build failures instead of detecting them.
//
//   CONSTITUTIONAL GATES (invariants.ts):
//     Invariants define what "healthy" means. If the loop can rewrite health
//     checks, it can redefine success to make tests pass. That breaks the
//     entire constitution model.
//
// Rule: predicate gates → inside bounded surface.
//       environment/orchestration gates → frozen.
//       system health definitions → frozen.
//

export const BOUNDED_SURFACE: ReadonlyArray<{ file: string; description: string }> = [
  { file: 'src/store/constraint-store.ts', description: 'Fingerprinting, signature extraction, K5 learning' },
  { file: 'src/gates/constraints.ts', description: 'K5 enforcement logic' },
  { file: 'src/gates/containment.ts', description: 'G5 attribution' },
  { file: 'src/gates/grounding.ts', description: 'CSS/HTML parsing, route extraction' },
  { file: 'src/gates/filesystem.ts', description: 'Filesystem state verification (exists/absent/unchanged/count)' },
  { file: 'src/gates/browser.ts', description: 'Playwright CSS/HTML validation' },
  { file: 'src/gates/http.ts', description: 'HTTP predicate validation' },
  { file: 'src/gates/syntax.ts', description: 'F9 edit application' },
  { file: 'src/gates/vision.ts', description: 'Vision model screenshot verification' },
  { file: 'src/gates/triangulation.ts', description: 'Cross-authority verdict synthesis' },
  { file: 'src/gates/security.ts', description: 'Security scanning (secrets, eval, XSS, CSRF, etc.)' },
  { file: 'src/gates/a11y.ts', description: 'Accessibility checks (alt text, labels, headings, etc.)' },
  { file: 'src/gates/performance.ts', description: 'Performance checks (bundle size, connections, etc.)' },
  { file: 'src/gates/config.ts', description: 'Configuration consistency checks' },
  { file: 'src/gates/serialization.ts', description: 'Data serialization validation' },
  { file: 'src/gates/observation.ts', description: 'Observation/drift detection' },
  { file: 'src/gates/propagation.ts', description: 'Cross-file change propagation' },
  { file: 'src/gates/contention.ts', description: 'Edit contention detection' },
  { file: 'src/gates/temporal.ts', description: 'Temporal ordering verification' },
  { file: 'src/gates/state.ts', description: 'State consistency checks' },
  { file: 'src/gates/capacity.ts', description: 'Capacity/size limit checks' },
  { file: 'src/gates/access.ts', description: 'Access control verification' },
  { file: 'src/gates/message.ts', description: 'Message/communication verification' },
  { file: 'src/gates/infrastructure.ts', description: 'Infrastructure health checks (Docker, SSH, DNS)' },
];

export const FROZEN_FILES = new Set([
  'src/verify.ts',
  'src/types.ts',
  'scripts/harness/',
]);

export function isEditAllowed(file: string): boolean {
  for (const frozen of FROZEN_FILES) {
    if (file.startsWith(frozen)) return false;
  }
  return BOUNDED_SURFACE.some(s => file === s.file);
}

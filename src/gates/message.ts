/**
 * Message Gate — Governed Outbound Communication Assertions
 * ==========================================================
 *
 * Validates agent outbound messages before they reach humans or external systems.
 * The gate pipeline checks:
 *
 *   1. Destination — is the target allowed?
 *   2. Forbidden content — does the body contain banned patterns?
 *   3. Required content — does the message include required elements?
 *   4. Claims — does the agent's assertions have evidence?
 *   5. K5 constraints — was this pattern previously denied?
 *   6. Review hook — optional human/model review
 *
 * Four verdicts:
 *   approved  — message can be sent
 *   blocked   — message violates a hard rule
 *   narrowed  — message modified to comply (forbidden content stripped, etc.)
 *   clarify   — ambiguous situation needs human input
 *
 * No Docker required. No LLM calls. Pure deterministic checks.
 */

import type { GateResult } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Platform-agnostic message envelope.
 * Semantic intent — not wire format.
 */
export interface MessageEnvelope {
  destination: {
    /** Target identifier — channel name, email, user ID, etc. */
    target: string;
    /** Platform hint — 'slack', 'email', 'discord', etc. */
    platform?: string;
    /** Thread/topic identifier */
    thread?: string;
  };
  content: {
    /** Message body text */
    body: string;
    /** Subject line (email, etc.) */
    subject?: string;
    /** Content format hint — 'text', 'markdown', 'html' */
    format?: string;
    /** Attachments metadata */
    attachments?: Array<{
      filename: string;
      type?: string;
      size?: number;
      ref?: string;
    }>;
  };
  sender: {
    /** Agent identity */
    identity: string;
    /** Authority context — who authorized this agent */
    authority?: string;
    /** Controller ID for identity binding */
    controller?: string;
  };
  /** Topic classification — determines which policy rules apply */
  topic?: {
    value: string;
    source: 'agent' | 'adapter' | 'policy' | 'inferred';
  };
}

/**
 * Policy governing what messages an agent can send.
 */
export interface MessagePolicy {
  /** Destination allow/deny rules */
  destinations?: {
    allow?: string[];
    deny?: string[];
    rules?: Array<{
      /** Match type: 'exact', 'glob', 'regex' */
      type?: string;
      /** Platforms this rule applies to */
      platforms?: string[];
      /** Sender identity this rule applies to */
      from?: string;
      allow?: string[];
      deny?: string[];
    }>;
  };

  /** Forbidden patterns — content that must never appear */
  forbidden?: Array<string | RegExp | {
    /** Apply only in subject or body */
    in?: 'subject' | 'body';
    pattern: string | RegExp;
  }>;

  /** Required elements for messages matching certain criteria */
  required?: Array<{
    /** Only apply when topic matches */
    topic?: string;
    /** Body must contain these strings */
    contains?: string[];
    /** Body must match these patterns */
    patterns?: Array<string | RegExp>;
    /** Required metadata fields on envelope */
    metadata_fields?: string[];
  }>;

  /**
   * Topic governance — controls how topics are determined and trusted.
   * When defined, the gate detects topics from content keywords rather than
   * trusting the agent's self-label. This prevents an agent from gaming
   * governance by labeling a deploy message as "general."
   */
  topics?: Record<string, {
    /** Trust the agent's topic label? Default: false */
    trust_agent_label?: boolean;
    /** Keywords that indicate this topic is present in the content */
    detect?: string[];
  }>;

  /** Claim governance — topic → assertion rules */
  claims?: Record<string, {
    /** What to do with assertions not in the list */
    unknown_assertions?: 'allow' | 'clarify';
    /** Named assertions with trigger phrases and evidence requirements */
    assertions?: Record<string, {
      /** Phrases that trigger this assertion check */
      triggers: string[];
      /** Evidence provider key — what to check */
      evidence: string;
      /** Maximum evidence age in milliseconds. If set, gate computes freshness from epoch. */
      maxEvidenceAgeMs?: number;
    }>;
  }>;

  /** Optional review hook — async, returns structured verdict */
  review?: (envelope: MessageEnvelope, context: MessageGateContext) => Promise<ReviewVerdict>;
}

export interface ReviewVerdict {
  verdict: 'approved' | 'blocked' | 'clarify';
  reason?: string;
  notes?: string;
}

/**
 * Evidence provider — pluggable async function that checks a claim.
 * Returns { exists: boolean, fresh: boolean, detail: string }.
 */
export type EvidenceProvider = (
  claim: string,
  envelope: MessageEnvelope,
) => Promise<EvidenceResult>;

export interface EvidenceResult {
  exists: boolean;
  /** Provider's self-reported freshness. Gate may override this via epoch comparison. */
  fresh: boolean;
  detail: string;
  /** Timestamp when the evidence was produced (ms since epoch). Used by gate for staleness. */
  timestamp?: number;
  /** Authority epoch of the evidence. Compared against currentEpoch if provided. */
  epoch?: number;
  /** Current authority epoch. If epoch < currentEpoch, evidence is stale. */
  currentEpoch?: number;
}

/**
 * Context passed through the message gate pipeline.
 */
export interface MessageGateContext {
  envelope: MessageEnvelope;
  policy: MessagePolicy;
  evidenceProviders?: Record<string, EvidenceProvider>;
  /** Previously denied patterns (K5-style memory) */
  deniedPatterns?: Array<{ pattern: string; reason: string; timestamp: number }>;
}

// =============================================================================
// RESULT TYPES
// =============================================================================

export type MessageVerdict = 'approved' | 'blocked' | 'narrowed' | 'clarify';

export type MessageBlockReason =
  | 'destination_denied'
  | 'forbidden_content'
  | 'claim_unsupported'
  | 'claim_stale_evidence'
  | 'missing_required'
  | 'identity_scope_violation'
  | 'previously_denied';

export type MessageClarifyReason =
  | 'partial_evidence'
  | 'ambiguous_negation'
  | 'unknown_assertion'
  | 'authority_edge_case'
  | 'review_escalated';

export interface ClaimResult {
  assertion: string;
  trigger: string;
  evidenceKey: string;
  verified: boolean;
  fresh: boolean;
  detail: string;
  /** Raw evidence result from the provider — carried through for review surfaces */
  evidence?: EvidenceResult;
}

/**
 * Topic resolution result — shows how the gate determined the topic.
 */
export interface TopicResolution {
  /** The topic used for governance */
  resolved: string;
  /** The topic the agent declared (if any) */
  agentDeclared?: string;
  /** Was the agent's label overridden? */
  overridden: boolean;
  /** How the topic was determined */
  source: 'agent_trusted' | 'policy_detected' | 'agent_no_policy' | 'none';
  /** Keywords that matched (if policy-detected) */
  matchedKeywords?: string[];
}

export interface MessageGateResult {
  /** Final verdict */
  verdict: MessageVerdict;

  /** Why the message was blocked or needs clarification */
  reason?: MessageBlockReason | MessageClarifyReason;

  /** Human-readable explanation */
  detail: string;

  /** Per-gate results */
  gates: Array<{
    gate: string;
    passed: boolean;
    detail: string;
    durationMs: number;
  }>;

  /** Claim verification results (when claims gate runs) */
  claims?: ClaimResult[];

  /** How long the full pipeline took */
  durationMs: number;

  /** The envelope that was evaluated */
  envelope: MessageEnvelope;

  /** If narrowed, what was changed */
  modifications?: string[];

  /** Topic resolution trace — how the gate determined the topic */
  topicResolution?: TopicResolution;

  /** Narrowing details — what was constrained and why */
  narrowing?: {
    /** What was narrowed: topic scope, evidence admissibility, etc. */
    type: 'topic_override' | 'evidence_staleness' | 'topic_override+evidence_staleness';
    /** What the agent proposed vs what the gate enforced */
    original?: Record<string, unknown>;
    /** What the gate enforced */
    enforced?: Record<string, unknown>;
    /** Resolution hint for the agent */
    resolutionHint: string;
  };

  /**
   * Review bundle — self-contained package for human review surfaces.
   *
   * Populated on `clarify` and `narrowed` verdicts. Contains the original
   * message, gate reasoning, and any evidence artifacts so a review UI
   * (Slack modal, email thread, dashboard card) has everything it needs
   * without chasing cross-references.
   */
  reviewBundle?: {
    /** The original message that triggered review */
    message: {
      destination: string;
      body: string;
      sender: string;
      topic?: string;
    };
    /** Why review is needed */
    gateDetail: string;
    /** Evidence artifacts from claim verification (screenshots, deploy receipts, etc.) */
    evidenceArtifacts: Array<{
      claim: string;
      evidenceKey: string;
      verified: boolean;
      fresh: boolean;
      providerDetail: string;
      /** Raw evidence fields from the provider */
      raw?: Record<string, unknown>;
    }>;
    /** Topic resolution trace (if topic was overridden) */
    topicTrace?: TopicResolution;
    /** Staleness info (if evidence was stale) */
    stalenessInfo?: {
      assertion: string;
      epoch?: number;
      currentEpoch?: number;
      ageMs?: number;
      maxAgeMs?: number;
    };
  };
}

// =============================================================================
// NEGATION DETECTION
// =============================================================================

/**
 * Obvious negation patterns — deterministic suppression.
 * These unambiguously negate the assertion trigger.
 */
const OBVIOUS_NEGATION_PREFIXES = [
  'not yet ',
  'has not ',
  'hasn\'t ',
  'haven\'t ',
  'did not ',
  'didn\'t ',
  'will not ',
  'won\'t ',
  'cannot ',
  'can\'t ',
  'failed to ',
  'unable to ',
  'no longer ',
];

/**
 * Ambiguous negation patterns — require clarification.
 */
const AMBIGUOUS_NEGATION_PATTERNS = [
  /\bnot\b(?! yet| been| completed| deployed| fixed)/i,
  /\bmaybe\b/i,
  /\bpossibly\b/i,
  /\bmight have\b/i,
  /\bcould have\b/i,
  /\bshould have\b/i,
  /\bpartially\b/i,
];

type NegationResult = 'none' | 'obvious' | 'ambiguous';

function detectNegation(text: string, trigger: string): NegationResult {
  // Find the trigger in the text
  const triggerIdx = text.toLowerCase().indexOf(trigger.toLowerCase());
  if (triggerIdx < 0) return 'none';

  // Check a window before the trigger for negation
  const windowStart = Math.max(0, triggerIdx - 40);
  const prefix = text.substring(windowStart, triggerIdx).toLowerCase();

  // Check obvious negation first
  for (const neg of OBVIOUS_NEGATION_PREFIXES) {
    if (prefix.includes(neg.trimEnd())) {
      return 'obvious';
    }
  }

  // Check ambiguous negation
  for (const pattern of AMBIGUOUS_NEGATION_PATTERNS) {
    if (pattern.test(prefix)) {
      return 'ambiguous';
    }
  }

  return 'none';
}

// =============================================================================
// TOPIC RESOLUTION
// =============================================================================

/**
 * Resolve the effective topic for governance.
 *
 * Priority:
 *   1. If policy has topic rules with detect keywords → scan content
 *   2. If topic detected and agent label differs → narrowed (override)
 *   3. If no policy topic rules → trust agent label
 *   4. If no topic at all → no topic governance
 */
function resolveTopic(ctx: MessageGateContext): TopicResolution {
  const agentTopic = ctx.envelope.topic?.value;
  const { topics } = ctx.policy;

  // No topic governance in policy — trust agent label or nothing
  if (!topics || Object.keys(topics).length === 0) {
    if (agentTopic) {
      return { resolved: agentTopic, agentDeclared: agentTopic, overridden: false, source: 'agent_no_policy' };
    }
    return { resolved: '', overridden: false, source: 'none' };
  }

  // Scan content against each policy topic's detect keywords
  const body = ctx.envelope.content.body.toLowerCase();
  const subject = (ctx.envelope.content.subject || '').toLowerCase();
  const text = `${subject} ${body}`;

  const detectedTopics: Array<{ topic: string; keywords: string[] }> = [];

  for (const [topicName, topicConfig] of Object.entries(topics)) {
    if (!topicConfig.detect || topicConfig.detect.length === 0) continue;

    const matched = topicConfig.detect.filter(kw => text.includes(kw.toLowerCase()));
    if (matched.length > 0) {
      detectedTopics.push({ topic: topicName, keywords: matched });
    }
  }

  // If content-based detection found topics
  if (detectedTopics.length > 0) {
    // Use the first detected topic (most keywords matched wins on tie)
    const best = detectedTopics.sort((a, b) => b.keywords.length - a.keywords.length)[0];

    // Check if agent's label should be trusted for this topic
    const topicConfig = topics[best.topic];
    if (agentTopic === best.topic) {
      // Agent and detection agree — no override needed
      return { resolved: best.topic, agentDeclared: agentTopic, overridden: false, source: 'policy_detected', matchedKeywords: best.keywords };
    }

    if (topicConfig?.trust_agent_label && agentTopic) {
      // Policy trusts agent label for this topic — use agent's label
      return { resolved: agentTopic, agentDeclared: agentTopic, overridden: false, source: 'agent_trusted' };
    }

    // Override: agent labeled differently (or didn't label), but content says otherwise
    return { resolved: best.topic, agentDeclared: agentTopic, overridden: true, source: 'policy_detected', matchedKeywords: best.keywords };
  }

  // No content detection matched — trust agent label if present
  if (agentTopic) {
    // Check if the agent's topic has trust_agent_label explicitly set
    const agentTopicConfig = topics[agentTopic];
    if (agentTopicConfig && agentTopicConfig.trust_agent_label === false) {
      // Policy explicitly doesn't trust agent for this topic, and no keywords detected
      // Agent claims a topic but content doesn't support it — use agent label anyway
      // (we can't narrow to "nothing" — that would be blocking, not narrowing)
      return { resolved: agentTopic, agentDeclared: agentTopic, overridden: false, source: 'agent_no_policy' };
    }
    return { resolved: agentTopic, agentDeclared: agentTopic, overridden: false, source: 'agent_no_policy' };
  }

  return { resolved: '', overridden: false, source: 'none' };
}

// =============================================================================
// GATE PIPELINE
// =============================================================================

/**
 * Run the message governance pipeline.
 *
 * Order of operations:
 *   0. Topic resolution (narrowing: agent label may be overridden)
 *   1. Destination gate
 *   2. Forbidden content gate
 *   3. Required content gate
 *   4. Claims gate (trigger detection → evidence lookup → freshness check)
 *   5. K5 denied patterns gate
 *   6. Review hook (optional)
 */
export async function runMessageGate(ctx: MessageGateContext): Promise<MessageGateResult> {
  const start = Date.now();
  const gates: MessageGateResult['gates'] = [];
  const claims: ClaimResult[] = [];
  const modifications: string[] = [];

  // ── Gate 0: Topic resolution ──────────────────────────────────────
  const topicResolution = resolveTopic(ctx);
  let narrowing: MessageGateResult['narrowing'] | undefined;

  if (topicResolution.overridden) {
    modifications.push(`Topic overridden: agent declared "${topicResolution.agentDeclared || '(none)'}", gate enforced "${topicResolution.resolved}" based on content keywords [${topicResolution.matchedKeywords?.join(', ')}]`);
    narrowing = {
      type: 'topic_override',
      original: { topic: topicResolution.agentDeclared || null },
      enforced: { topic: topicResolution.resolved, matchedKeywords: topicResolution.matchedKeywords },
      resolutionHint: `Message content matches topic "${topicResolution.resolved}" rules. Agent label "${topicResolution.agentDeclared || '(none)'}" was overridden. Topic "${topicResolution.resolved}" governance applies.`,
    };
    gates.push({
      gate: 'topic_resolution',
      passed: true, // narrowing is not failure — it's constraint
      detail: `Topic narrowed: "${topicResolution.agentDeclared || '(none)'}" → "${topicResolution.resolved}" (keywords: ${topicResolution.matchedKeywords?.join(', ')})`,
      durationMs: 0,
    });
  }

  // Apply resolved topic to context for downstream gates
  const effectiveCtx: MessageGateContext = {
    ...ctx,
    envelope: {
      ...ctx.envelope,
      topic: topicResolution.resolved
        ? { value: topicResolution.resolved, source: topicResolution.overridden ? 'policy' as const : (ctx.envelope.topic?.source || 'agent' as const) }
        : ctx.envelope.topic,
    },
  };

  // ── Gate 1: Destination ──────────────────────────────────────────
  const destResult = checkDestination(effectiveCtx);
  gates.push(destResult);
  if (!destResult.passed) {
    return buildResult('blocked', 'destination_denied', destResult.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }

  // ── Gate 2: Forbidden content ────────────────────────────────────
  const forbiddenResult = checkForbiddenContent(effectiveCtx);
  gates.push(forbiddenResult);
  if (!forbiddenResult.passed) {
    return buildResult('blocked', 'forbidden_content', forbiddenResult.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }

  // ── Gate 3: Required content ─────────────────────────────────────
  const requiredResult = checkRequiredContent(effectiveCtx);
  gates.push(requiredResult);
  if (!requiredResult.passed) {
    return buildResult('blocked', 'missing_required', requiredResult.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }

  // ── Gate 4: Claims ───────────────────────────────────────────────
  const claimsResult = await checkClaims(effectiveCtx, claims);
  gates.push(claimsResult.gate);
  if (claimsResult.verdict === 'blocked') {
    // Check if this is an epoch-based staleness (narrowing, not hard block)
    if (claimsResult.reason === 'claim_stale_evidence' && claimsResult.staleByEpoch) {
      // Epoch staleness = narrowing of evidence admissibility
      const staleNarrowing: MessageGateResult['narrowing'] = narrowing
        ? { ...narrowing, type: 'topic_override+evidence_staleness', resolutionHint: `${narrowing.resolutionHint} Additionally, evidence for claim "${claimsResult.staleAssertion}" is stale (epoch-based). Re-fetch evidence before retrying.` }
        : { type: 'evidence_staleness', original: { evidenceEpoch: claimsResult.staleEpoch }, enforced: { currentEpoch: claimsResult.currentEpoch }, resolutionHint: `Evidence for claim "${claimsResult.staleAssertion}" is stale (epoch ${claimsResult.staleEpoch} < current ${claimsResult.currentEpoch}). Re-fetch evidence with current authority epoch before retrying.` };
      modifications.push(`Evidence staleness: claim "${claimsResult.staleAssertion}" has epoch ${claimsResult.staleEpoch} but current is ${claimsResult.currentEpoch}`);
      return buildResult('narrowed', 'claim_stale_evidence', claimsResult.gate.detail, gates, claims, effectiveCtx, start, modifications, topicResolution, staleNarrowing);
    }
    return buildResult('blocked', claimsResult.reason as MessageBlockReason, claimsResult.gate.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }
  if (claimsResult.verdict === 'clarify') {
    return buildResult('clarify', claimsResult.reason as MessageClarifyReason, claimsResult.gate.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }

  // ── Gate 5: K5 denied patterns ───────────────────────────────────
  const deniedResult = checkDeniedPatterns(effectiveCtx);
  gates.push(deniedResult);
  if (!deniedResult.passed) {
    return buildResult('blocked', 'previously_denied', deniedResult.detail, gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
  }

  // ── Gate 6: Review hook ──────────────────────────────────────────
  if (effectiveCtx.policy.review) {
    const reviewStart = Date.now();
    try {
      const reviewResult = await effectiveCtx.policy.review(effectiveCtx.envelope, effectiveCtx);
      gates.push({
        gate: 'review',
        passed: reviewResult.verdict === 'approved',
        detail: reviewResult.reason || (reviewResult.verdict === 'approved' ? 'Review approved' : 'Review escalated'),
        durationMs: Date.now() - reviewStart,
      });
      if (reviewResult.verdict === 'blocked') {
        return buildResult('blocked', 'forbidden_content', reviewResult.reason || 'Blocked by review', gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
      }
      if (reviewResult.verdict === 'clarify') {
        return buildResult('clarify', 'review_escalated', reviewResult.reason || 'Review needs human input', gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
      }
    } catch (err) {
      // Review hook failure → clarify (safe default)
      gates.push({
        gate: 'review',
        passed: false,
        detail: `Review hook error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - reviewStart,
      });
      return buildResult('clarify', 'review_escalated', 'Review hook failed — needs human input', gates, claims, effectiveCtx, start, undefined, topicResolution, narrowing);
    }
  }

  // ── All gates passed ─────────────────────────────────────────────
  // If topic was narrowed, final verdict is 'narrowed' (not 'approved')
  const finalVerdict: MessageVerdict = narrowing ? 'narrowed' : 'approved';
  const detail = claims.length > 0
    ? `Message ${finalVerdict} — ${claims.length} claim(s) verified`
    : `Message ${finalVerdict} — all gates passed`;

  return buildResult(finalVerdict, undefined, detail, gates, claims, effectiveCtx, start, modifications, topicResolution, narrowing);
}

// =============================================================================
// INDIVIDUAL GATES
// =============================================================================

function checkDestination(ctx: MessageGateContext): MessageGateResult['gates'][0] {
  const start = Date.now();
  const { destinations } = ctx.policy;
  const target = ctx.envelope.destination.target;

  if (!destinations) {
    return { gate: 'destination', passed: true, detail: 'No destination rules configured', durationMs: Date.now() - start };
  }

  // Check deny list first (deny wins over allow)
  if (destinations.deny) {
    for (const pattern of destinations.deny) {
      if (matchesPattern(target, pattern)) {
        return { gate: 'destination', passed: false, detail: `Destination '${target}' is denied by policy`, durationMs: Date.now() - start };
      }
    }
  }

  // If allow list exists, target must be in it
  if (destinations.allow && destinations.allow.length > 0) {
    const allowed = destinations.allow.some(p => matchesPattern(target, p));
    if (!allowed) {
      return { gate: 'destination', passed: false, detail: `Destination '${target}' is not in allow list`, durationMs: Date.now() - start };
    }
  }

  return { gate: 'destination', passed: true, detail: `Destination '${target}' is allowed`, durationMs: Date.now() - start };
}

function checkForbiddenContent(ctx: MessageGateContext): MessageGateResult['gates'][0] {
  const start = Date.now();
  const { forbidden } = ctx.policy;

  if (!forbidden || forbidden.length === 0) {
    return { gate: 'forbidden_content', passed: true, detail: 'No forbidden patterns configured', durationMs: Date.now() - start };
  }

  const body = ctx.envelope.content.body;
  const subject = ctx.envelope.content.subject || '';

  for (const rule of forbidden) {
    if (typeof rule === 'string') {
      if (body.includes(rule) || subject.includes(rule)) {
        return { gate: 'forbidden_content', passed: false, detail: `Forbidden content detected: "${rule}"`, durationMs: Date.now() - start };
      }
    } else if (rule instanceof RegExp) {
      if (rule.test(body) || rule.test(subject)) {
        return { gate: 'forbidden_content', passed: false, detail: `Forbidden pattern matched: ${rule}`, durationMs: Date.now() - start };
      }
    } else {
      // Scoped pattern: { in?: 'subject' | 'body', pattern: string | RegExp }
      const text = rule.in === 'subject' ? subject : rule.in === 'body' ? body : `${subject} ${body}`;
      const pat = rule.pattern;
      if (typeof pat === 'string') {
        if (text.includes(pat)) {
          return { gate: 'forbidden_content', passed: false, detail: `Forbidden content in ${rule.in || 'message'}: "${pat}"`, durationMs: Date.now() - start };
        }
      } else if (pat.test(text)) {
        return { gate: 'forbidden_content', passed: false, detail: `Forbidden pattern in ${rule.in || 'message'}: ${pat}`, durationMs: Date.now() - start };
      }
    }
  }

  return { gate: 'forbidden_content', passed: true, detail: 'No forbidden patterns found', durationMs: Date.now() - start };
}

function checkRequiredContent(ctx: MessageGateContext): MessageGateResult['gates'][0] {
  const start = Date.now();
  const { required } = ctx.policy;

  if (!required || required.length === 0) {
    return { gate: 'required_content', passed: true, detail: 'No required content rules', durationMs: Date.now() - start };
  }

  const topic = ctx.envelope.topic?.value;
  const body = ctx.envelope.content.body;

  for (const rule of required) {
    // Only apply if topic matches (or no topic filter)
    if (rule.topic && topic !== rule.topic) continue;

    // Check required strings
    if (rule.contains) {
      for (const required of rule.contains) {
        if (!body.includes(required)) {
          return {
            gate: 'required_content',
            passed: false,
            detail: `Required content missing: "${required}"`,
            durationMs: Date.now() - start,
          };
        }
      }
    }

    // Check required patterns
    if (rule.patterns) {
      for (const pat of rule.patterns) {
        const regex = typeof pat === 'string' ? new RegExp(pat) : pat;
        if (!regex.test(body)) {
          return {
            gate: 'required_content',
            passed: false,
            detail: `Required pattern not found: ${pat}`,
            durationMs: Date.now() - start,
          };
        }
      }
    }
  }

  return { gate: 'required_content', passed: true, detail: 'All required content present', durationMs: Date.now() - start };
}

interface ClaimsCheckResult {
  gate: MessageGateResult['gates'][0];
  verdict: 'approved' | 'blocked' | 'clarify';
  reason?: string;
  /** True when staleness was determined by epoch comparison, not provider self-report */
  staleByEpoch?: boolean;
  /** The assertion that had stale evidence */
  staleAssertion?: string;
  /** The epoch of the stale evidence */
  staleEpoch?: number;
  /** The current epoch */
  currentEpoch?: number;
}

async function checkClaims(
  ctx: MessageGateContext,
  claims: ClaimResult[],
): Promise<ClaimsCheckResult> {
  const start = Date.now();
  const { claims: claimRules } = ctx.policy;

  if (!claimRules) {
    return {
      gate: { gate: 'claims', passed: true, detail: 'No claim rules configured', durationMs: Date.now() - start },
      verdict: 'approved',
    };
  }

  const topic = ctx.envelope.topic?.value;
  if (!topic || !claimRules[topic]) {
    return {
      gate: { gate: 'claims', passed: true, detail: 'No claim rules for this topic', durationMs: Date.now() - start },
      verdict: 'approved',
    };
  }

  const topicRules = claimRules[topic];
  const body = ctx.envelope.content.body;
  const unknownPolicy = topicRules.unknown_assertions || 'clarify';

  // Detect all trigger matches
  const matchedAssertions = new Set<string>();
  const negatedTriggers: string[] = [];

  if (topicRules.assertions) {
    for (const [assertionName, assertion] of Object.entries(topicRules.assertions)) {
      for (const trigger of assertion.triggers) {
        if (body.toLowerCase().includes(trigger.toLowerCase())) {
          // Check negation
          const negation = detectNegation(body, trigger);

          if (negation === 'obvious') {
            // Obvious negation — suppress this trigger (agent is reporting failure, not claiming success)
            negatedTriggers.push(trigger);
            continue;
          }

          if (negation === 'ambiguous') {
            claims.push({
              assertion: assertionName,
              trigger,
              evidenceKey: assertion.evidence,
              verified: false,
              fresh: false,
              detail: 'Ambiguous negation — needs human clarification',
            });
            return {
              gate: { gate: 'claims', passed: false, detail: `Ambiguous negation around "${trigger}" — needs clarification`, durationMs: Date.now() - start },
              verdict: 'clarify',
              reason: 'ambiguous_negation',
            };
          }

          matchedAssertions.add(assertionName);

          // Look up evidence
          const provider = ctx.evidenceProviders?.[assertion.evidence];
          if (!provider) {
            claims.push({
              assertion: assertionName,
              trigger,
              evidenceKey: assertion.evidence,
              verified: false,
              fresh: false,
              detail: `No evidence provider for "${assertion.evidence}"`,
            });
            return {
              gate: { gate: 'claims', passed: false, detail: `Claim "${assertionName}" has no evidence provider for "${assertion.evidence}"`, durationMs: Date.now() - start },
              verdict: 'blocked',
              reason: 'claim_unsupported',
            };
          }

          try {
            const evidence = await provider(assertionName, ctx.envelope);

            if (!evidence.exists) {
              claims.push({
                assertion: assertionName,
                trigger,
                evidenceKey: assertion.evidence,
                verified: false,
                fresh: false,
                detail: evidence.detail,
                evidence,
              });
              return {
                gate: { gate: 'claims', passed: false, detail: `Claim "${assertionName}" not supported: ${evidence.detail}`, durationMs: Date.now() - start },
                verdict: 'blocked',
                reason: 'claim_unsupported',
              };
            }

            // Gate-side freshness computation (epoch-based staleness)
            // Priority: epoch comparison > timestamp comparison > provider self-report
            let isFresh = evidence.fresh;
            let staleByEpoch = false;

            if (evidence.epoch !== undefined && evidence.currentEpoch !== undefined) {
              // Epoch-based: evidence from an older authority epoch is stale
              isFresh = evidence.epoch >= evidence.currentEpoch;
              staleByEpoch = !isFresh;
            } else if (assertion.maxEvidenceAgeMs !== undefined && evidence.timestamp !== undefined) {
              // Timestamp-based: evidence older than maxEvidenceAgeMs is stale
              const age = Date.now() - evidence.timestamp;
              isFresh = age <= assertion.maxEvidenceAgeMs;
              staleByEpoch = !isFresh; // timestamp-based but gate-computed
            }
            // else: fall through to provider's self-reported fresh field

            if (!isFresh) {
              const staleDetail = staleByEpoch
                ? (evidence.epoch !== undefined
                    ? `epoch ${evidence.epoch} < current ${evidence.currentEpoch}`
                    : `evidence age ${Date.now() - (evidence.timestamp || 0)}ms > max ${assertion.maxEvidenceAgeMs}ms`)
                : evidence.detail;

              claims.push({
                assertion: assertionName,
                trigger,
                evidenceKey: assertion.evidence,
                verified: true,
                fresh: false,
                detail: staleDetail,
                evidence,
              });
              return {
                gate: { gate: 'claims', passed: false, detail: `Claim "${assertionName}" has stale evidence: ${staleDetail}`, durationMs: Date.now() - start },
                verdict: 'blocked',
                reason: 'claim_stale_evidence',
                staleByEpoch,
                staleAssertion: assertionName,
                staleEpoch: evidence.epoch,
                currentEpoch: evidence.currentEpoch,
              };
            }

            claims.push({
              assertion: assertionName,
              trigger,
              evidenceKey: assertion.evidence,
              verified: true,
              fresh: true,
              detail: evidence.detail,
              evidence,
            });
          } catch (err) {
            claims.push({
              assertion: assertionName,
              trigger,
              evidenceKey: assertion.evidence,
              verified: false,
              fresh: false,
              detail: `Evidence check error: ${err instanceof Error ? err.message : String(err)}`,
            });
            return {
              gate: { gate: 'claims', passed: false, detail: `Evidence check failed for "${assertionName}"`, durationMs: Date.now() - start },
              verdict: 'clarify',
              reason: 'partial_evidence',
            };
          }
        }
      }
    }
  }

  // Check for unknown assertions (trigger-like phrases not in our assertion list)
  // This is a simple heuristic — look for claim-like language not covered by known triggers
  const claimIndicators = [
    /\bsuccessfully\b/i,
    /\bcompleted\b/i,
    /\bfixed\b/i,
    /\bresolved\b/i,
    /\bdeployed\b/i,
    /\bverified\b/i,
    /\bconfirmed\b/i,
    /\bpassed\b/i,
  ];

  if (topicRules.assertions && matchedAssertions.size === 0) {
    // No known assertions matched, but check if body has claim-like language
    // Skip indicators that appear within negated trigger phrases
    const negatedWords = new Set(
      negatedTriggers.flatMap(t => t.toLowerCase().split(/\s+/))
    );

    for (const indicator of claimIndicators) {
      const match = body.match(indicator);
      if (match) {
        // If the matched word is part of a negated trigger, skip it
        const matchedWord = match[0].toLowerCase();
        if (negatedWords.has(matchedWord)) continue;

        // Found claim-like language but no matching assertion rule
        if (unknownPolicy === 'clarify') {
          return {
            gate: { gate: 'claims', passed: false, detail: `Unknown assertion detected in governed topic "${topic}" — needs clarification`, durationMs: Date.now() - start },
            verdict: 'clarify',
            reason: 'unknown_assertion',
          };
        }
        // unknown_assertions: 'allow' — let it through
        break;
      }
    }
  }

  const claimCount = claims.filter(c => c.verified).length;
  const detail = claimCount > 0
    ? `${claimCount} claim(s) verified`
    : 'No claims requiring evidence';

  return {
    gate: { gate: 'claims', passed: true, detail, durationMs: Date.now() - start },
    verdict: 'approved',
  };
}

function checkDeniedPatterns(ctx: MessageGateContext): MessageGateResult['gates'][0] {
  const start = Date.now();
  const { deniedPatterns } = ctx;

  if (!deniedPatterns || deniedPatterns.length === 0) {
    return { gate: 'denied_patterns', passed: true, detail: 'No denied patterns', durationMs: Date.now() - start };
  }

  const body = ctx.envelope.content.body.toLowerCase();
  const target = ctx.envelope.destination.target.toLowerCase();

  for (const denied of deniedPatterns) {
    if (body.includes(denied.pattern.toLowerCase()) || target.includes(denied.pattern.toLowerCase())) {
      return {
        gate: 'denied_patterns',
        passed: false,
        detail: `Previously denied pattern matched: "${denied.pattern}" (${denied.reason})`,
        durationMs: Date.now() - start,
      };
    }
  }

  return { gate: 'denied_patterns', passed: true, detail: 'No denied patterns matched', durationMs: Date.now() - start };
}

// =============================================================================
// HELPERS
// =============================================================================

function matchesPattern(target: string, pattern: string): boolean {
  // Exact match
  if (target === pattern) return true;

  // Simple glob: * matches anything
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(target);
  }

  return false;
}

function buildResult(
  verdict: MessageVerdict,
  reason: MessageBlockReason | MessageClarifyReason | undefined,
  detail: string,
  gates: MessageGateResult['gates'],
  claims: ClaimResult[],
  ctx: MessageGateContext,
  startTime: number,
  modifications?: string[],
  topicResolution?: TopicResolution,
  narrowing?: MessageGateResult['narrowing'],
): MessageGateResult {
  const result: MessageGateResult = {
    verdict,
    reason,
    detail,
    gates,
    claims: claims.length > 0 ? claims : undefined,
    durationMs: Date.now() - startTime,
    envelope: ctx.envelope,
    modifications: modifications && modifications.length > 0 ? modifications : undefined,
    topicResolution,
    narrowing,
  };

  // Build review bundle for verdicts that need human attention
  if (verdict === 'clarify' || verdict === 'narrowed') {
    const evidenceArtifacts: MessageGateResult['reviewBundle'] extends { evidenceArtifacts: infer T } ? T : never = [];
    if (result.claims) {
      for (const claim of result.claims) {
        const artifact: (typeof evidenceArtifacts)[0] = {
          claim: claim.assertion,
          evidenceKey: claim.evidenceKey,
          verified: claim.verified,
          fresh: claim.fresh,
          providerDetail: claim.detail,
        };
        if (claim.evidence) {
          const { exists, fresh, detail: d, ...rest } = claim.evidence;
          artifact.raw = { exists, fresh, detail: d, ...rest };
        }
        evidenceArtifacts.push(artifact);
      }
    }

    // Extract staleness info from narrowing if present
    let stalenessInfo: MessageGateResult['reviewBundle'] extends { stalenessInfo?: infer S } ? S : never;
    if (narrowing && (narrowing.type === 'evidence_staleness' || narrowing.type === 'topic_override+evidence_staleness')) {
      stalenessInfo = {
        assertion: (narrowing.original as Record<string, unknown>)?.evidenceEpoch !== undefined
          ? result.claims?.find(c => !c.fresh)?.assertion || 'unknown'
          : 'unknown',
        epoch: (narrowing.original as Record<string, unknown>)?.evidenceEpoch as number | undefined,
        currentEpoch: (narrowing.enforced as Record<string, unknown>)?.currentEpoch as number | undefined,
      };
    }

    result.reviewBundle = {
      message: {
        destination: ctx.envelope.destination.target,
        body: ctx.envelope.content.body,
        sender: ctx.envelope.sender.identity,
        topic: ctx.envelope.topic?.value,
      },
      gateDetail: detail,
      evidenceArtifacts,
      topicTrace: topicResolution?.overridden ? topicResolution : undefined,
      stalenessInfo,
    };
  }

  return result;
}

// =============================================================================
// HIGH-LEVEL API
// =============================================================================

/**
 * governMessage() — the human-facing API.
 *
 * Simple inputs: where is it going, what does it say, who says it, what's not allowed, prove it.
 * Internally compiles to the full gate pipeline.
 *
 * @example
 * ```typescript
 * import { governMessage } from '@sovereign-labs/verify';
 *
 * const result = await governMessage(
 *   {
 *     destination: { target: '#deployments', platform: 'slack' },
 *     content: { body: 'Deploy v2.3 completed successfully' },
 *     sender: { identity: 'deploy-bot' },
 *     topic: { value: 'deploy', source: 'adapter' },
 *   },
 *   {
 *     destinations: { allow: ['#deployments', '#alerts'] },
 *     forbidden: ['password', /secret/i],
 *     claims: {
 *       deploy: {
 *         unknown_assertions: 'clarify',
 *         assertions: {
 *           deploy_success: {
 *             triggers: ['completed successfully', 'deployed successfully'],
 *             evidence: 'checkpoint',
 *           },
 *         },
 *       },
 *     },
 *   },
 *   {
 *     checkpoint: async (claim, envelope) => ({
 *       exists: true, fresh: true, detail: 'CP-138 exists',
 *     }),
 *   },
 * );
 *
 * if (result.verdict === 'approved') {
 *   sendToSlack(result.envelope);
 * } else if (result.verdict === 'clarify') {
 *   notifyHuman(result.detail);
 * }
 * ```
 */
export async function governMessage(
  envelope: MessageEnvelope,
  policy: MessagePolicy,
  evidenceProviders?: Record<string, EvidenceProvider>,
  deniedPatterns?: Array<{ pattern: string; reason: string; timestamp: number }>,
): Promise<MessageGateResult> {
  return runMessageGate({
    envelope,
    policy,
    evidenceProviders,
    deniedPatterns,
  });
}

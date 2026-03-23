#!/usr/bin/env bun
/**
 * Message Gate E2E Smoke Test
 * ===========================
 *
 * Exercises the governMessage() API end-to-end as a real consumer would,
 * covering the full feature surface including the new narrowing features:
 *
 *   1. Clean pass — destination allowed, no claims, no topic governance
 *   2. Blocked — forbidden content detected
 *   3. Claims verified — trigger matched, evidence provider confirms
 *   4. Negation — "has not deployed" suppresses trigger
 *   5. Topic trust enforcement — agent labels "general", gate narrows to "deploy"
 *   6. Epoch-based staleness — provider says fresh, gate says stale via epoch
 *   7. Timestamp staleness — maxEvidenceAgeMs exceeded
 *   8. Combined narrowing — topic override + epoch staleness
 *   9. Unknown assertion — clarify verdict
 *  10. Denied pattern — K5-style memory blocks repeat
 *
 * Run:
 *   bun run packages/verify/scripts/message-smoke-test.ts
 */

import { governMessage } from '../src/index.js';
import type {
  MessageEnvelope,
  MessagePolicy,
  EvidenceProvider,
  MessageGateResult,
  TopicResolution,
} from '../src/index.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    destination: { target: '#deployments', platform: 'slack' },
    content: { body: 'Status update: all systems operational' },
    sender: { identity: 'deploy-bot' },
    ...overrides,
  };
}

const basePolicy: MessagePolicy = {
  destinations: { allow: ['#deployments', '#alerts'], deny: ['#general'] },
  forbidden: ['password', 'secret', /api[_-]?key/i],
  claims: {
    deploy: {
      unknown_assertions: 'clarify',
      assertions: {
        deploy_success: {
          triggers: ['deployed successfully', 'completed successfully'],
          evidence: 'checkpoint',
        },
      },
    },
  },
};

const topicPolicy: MessagePolicy = {
  ...basePolicy,
  topics: {
    deploy: {
      trust_agent_label: false,
      detect: ['deployed', 'deploy completed', 'deployment'],
    },
    incident: {
      trust_agent_label: false,
      detect: ['outage', 'incident', 'downtime'],
    },
    general: {
      trust_agent_label: true,
      detect: [],
    },
  },
};

const validEvidence: Record<string, EvidenceProvider> = {
  checkpoint: async () => ({ exists: true, fresh: true, detail: 'CP-200 verified' }),
};

async function main() {
  console.log('\n  Message Gate E2E Smoke Test\n');

  // ── 1. Clean pass ──────────────────────────────────────────────────
  console.log('  1. Clean pass');
  {
    const r = await governMessage(envelope(), basePolicy);
    assert(r.verdict === 'approved', 'verdict=approved');
    assert(r.gates.length >= 2, `${r.gates.length} gates ran`);
    assert(!r.narrowing, 'no narrowing');
  }

  // ── 2. Blocked — forbidden content ────────────────────────────────
  console.log('\n  2. Blocked — forbidden content');
  {
    const r = await governMessage(
      envelope({ content: { body: 'Here is the api_key: sk-12345' } }),
      basePolicy,
    );
    assert(r.verdict === 'blocked', 'verdict=blocked');
    assert(r.reason === 'forbidden_content', `reason=${r.reason}`);
  }

  // ── 3. Claims verified ────────────────────────────────────────────
  console.log('\n  3. Claims verified');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      basePolicy,
      validEvidence,
    );
    assert(r.verdict === 'approved', `verdict=${r.verdict}`);
    assert(r.claims?.length === 1, `${r.claims?.length} claim(s)`);
    assert(r.claims?.[0]?.verified === true, 'claim verified');
    assert(r.claims?.[0]?.fresh === true, 'claim fresh');
    // Evidence threading on approved claims
    assert(r.claims?.[0]?.evidence !== undefined, 'evidence threaded on ClaimResult');
    assert(r.claims?.[0]?.evidence?.detail === 'CP-200 verified', `evidence.detail=${r.claims?.[0]?.evidence?.detail}`);
    // No reviewBundle on approved verdict
    assert(r.reviewBundle === undefined, 'no reviewBundle on approved');
  }

  // ── 4. Negation suppresses trigger ────────────────────────────────
  console.log('\n  4. Negation suppresses trigger');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 has not deployed successfully yet' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      basePolicy,
      validEvidence,
    );
    assert(r.verdict === 'approved', `verdict=${r.verdict} (negation suppressed)`);
    assert(!r.claims || r.claims.length === 0, 'no claims verified (trigger negated)');
  }

  // ── 5. Topic trust enforcement → narrowed ─────────────────────────
  console.log('\n  5. Topic trust enforcement → narrowed');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully to production' },
        topic: { value: 'general', source: 'agent' },
      }),
      topicPolicy,
      validEvidence,
    );
    assert(r.verdict === 'narrowed', `verdict=${r.verdict}`);
    assert(r.topicResolution !== undefined, 'topicResolution present');
    assert(r.topicResolution?.overridden === true, 'topic was overridden');
    assert(r.topicResolution?.resolved === 'deploy', `resolved=${r.topicResolution?.resolved}`);
    assert(r.topicResolution?.source === 'policy_detected', `source=${r.topicResolution?.source}`);
    assert(r.topicResolution?.agentDeclared === 'general', `agentDeclared=${r.topicResolution?.agentDeclared}`);
    assert(r.narrowing?.type === 'topic_override', `narrowing.type=${r.narrowing?.type}`);
    assert(!!r.narrowing?.resolutionHint, 'resolutionHint present');
    assert(r.modifications !== undefined && r.modifications.length > 0, 'modifications recorded');
    // Claims should still pass (evidence is valid)
    assert(r.claims?.length === 1 && r.claims[0].verified, 'claims still verified after topic override');
  }

  // ── 5b. Topic agreement — no override ─────────────────────────────
  console.log('\n  5b. Topic agreement — no override');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully to production' },
        topic: { value: 'deploy', source: 'agent' },
      }),
      topicPolicy,
      validEvidence,
    );
    assert(r.verdict === 'approved', `verdict=${r.verdict} (agent and detection agree)`);
    assert(r.topicResolution?.overridden === false, 'not overridden');
    assert(!r.narrowing, 'no narrowing when topics agree');
  }

  // ── 6. Epoch-based staleness → narrowed ───────────────────────────
  console.log('\n  6. Epoch-based staleness → narrowed');
  {
    const epochStaleEvidence: Record<string, EvidenceProvider> = {
      checkpoint: async () => ({
        exists: true,
        fresh: true, // Provider claims fresh — gate should override
        detail: 'CP-100 exists',
        epoch: 3,
        currentEpoch: 5,
      }),
    };
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      basePolicy,
      epochStaleEvidence,
    );
    assert(r.verdict === 'narrowed', `verdict=${r.verdict}`);
    assert(r.reason === 'claim_stale_evidence', `reason=${r.reason}`);
    assert(r.narrowing?.type === 'evidence_staleness', `narrowing.type=${r.narrowing?.type}`);
    assert(!!r.narrowing?.resolutionHint, 'resolutionHint present');
    assert(r.claims?.[0]?.fresh === false, 'claim marked not fresh');
    // Review bundle with evidence artifacts
    assert(r.reviewBundle !== undefined, 'narrowed has reviewBundle');
    assert(r.reviewBundle?.evidenceArtifacts.length === 1, `${r.reviewBundle?.evidenceArtifacts.length} evidence artifact(s)`);
    assert(r.reviewBundle?.evidenceArtifacts[0]?.raw?.epoch === 3, 'raw evidence epoch threaded');
    assert(r.reviewBundle?.evidenceArtifacts[0]?.raw?.currentEpoch === 5, 'raw evidence currentEpoch threaded');
    assert(r.reviewBundle?.stalenessInfo !== undefined, 'stalenessInfo present');
    // Claim-level evidence threading
    assert(r.claims?.[0]?.evidence !== undefined, 'evidence threaded on ClaimResult');
    assert(r.claims?.[0]?.evidence?.epoch === 3, `evidence.epoch=${r.claims?.[0]?.evidence?.epoch}`);
  }

  // ── 7. Timestamp staleness → narrowed ─────────────────────────────
  console.log('\n  7. Timestamp staleness → narrowed');
  {
    const timestampStaleEvidence: Record<string, EvidenceProvider> = {
      checkpoint: async () => ({
        exists: true,
        fresh: true,
        detail: 'CP-100 exists',
        timestamp: Date.now() - 2 * 3600 * 1000, // 2 hours ago
      }),
    };
    const policyWithMaxAge: MessagePolicy = {
      ...basePolicy,
      claims: {
        deploy: {
          unknown_assertions: 'clarify',
          assertions: {
            deploy_success: {
              triggers: ['deployed successfully', 'completed successfully'],
              evidence: 'checkpoint',
              maxEvidenceAgeMs: 30 * 60 * 1000, // 30 minutes
            },
          },
        },
      },
    };
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      policyWithMaxAge,
      timestampStaleEvidence,
    );
    assert(r.verdict === 'narrowed', `verdict=${r.verdict}`);
    assert(r.reason === 'claim_stale_evidence', `reason=${r.reason}`);
    assert(r.narrowing?.type === 'evidence_staleness', `narrowing.type=${r.narrowing?.type}`);
  }

  // ── 8. Combined narrowing — topic override + epoch staleness ──────
  console.log('\n  8. Combined narrowing');
  {
    const epochStaleEvidence: Record<string, EvidenceProvider> = {
      checkpoint: async () => ({
        exists: true,
        fresh: true,
        detail: 'CP-100',
        epoch: 2,
        currentEpoch: 4,
      }),
    };
    const r = await governMessage(
      envelope({
        content: { body: 'v2.3 deployed successfully' },
        topic: { value: 'general', source: 'agent' },
      }),
      topicPolicy,
      epochStaleEvidence,
    );
    assert(r.verdict === 'narrowed', `verdict=${r.verdict}`);
    assert(r.narrowing?.type === 'topic_override+evidence_staleness', `narrowing.type=${r.narrowing?.type}`);
    assert(r.topicResolution?.overridden === true, 'topic overridden');
    assert(r.topicResolution?.resolved === 'deploy', `resolved=${r.topicResolution?.resolved}`);
  }

  // ── 9. Unknown assertion → clarify ────────────────────────────────
  console.log('\n  9. Unknown assertion → clarify');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'The migration was completed and verified' },
        topic: { value: 'deploy', source: 'adapter' },
      }),
      basePolicy,
    );
    assert(r.verdict === 'clarify', `verdict=${r.verdict}`);
    assert(r.reason === 'unknown_assertion', `reason=${r.reason}`);
    assert(r.reviewBundle !== undefined, 'clarify has reviewBundle');
    assert(r.reviewBundle?.message.body === 'The migration was completed and verified', 'reviewBundle.message.body correct');
    assert(r.reviewBundle?.message.destination === '#deployments', 'reviewBundle.message.destination correct');
    assert(r.reviewBundle?.message.sender === 'deploy-bot', 'reviewBundle.message.sender correct');
    assert(r.reviewBundle?.gateDetail.length > 0, 'reviewBundle.gateDetail present');
  }

  // ── 10. Denied pattern — K5 memory ────────────────────────────────
  console.log('\n  10. Denied pattern (K5 memory)');
  {
    const r = await governMessage(
      envelope({
        content: { body: 'Sending daily metrics report' },
      }),
      basePolicy,
      undefined,
      [{ pattern: 'metrics report', reason: 'Previously caused alert spam', timestamp: Date.now() }],
    );
    assert(r.verdict === 'blocked', `verdict=${r.verdict}`);
    assert(r.reason === 'previously_denied', `reason=${r.reason}`);
  }

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});

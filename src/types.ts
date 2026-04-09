/**
 * @sovereign-labs/verify — Public Types
 * =====================================
 *
 * Everything a team needs to call verify() and understand the result.
 * No Sovereign internals. No daemon concepts. Just inputs and outputs.
 */

// =============================================================================
// MULTI-AGENT BATCH
// =============================================================================

/**
 * One agent's submission — edits and predicates bundled with an agent name.
 * Used by verifyBatch() for sequential multi-agent verification.
 */
export interface AgentSubmission {
  /** Agent name — appears in attestation on failure */
  agent: string;
  edits: Edit[];
  predicates: Predicate[];
}

/**
 * Result of verifyBatch() — per-agent results in submission order.
 */
export interface BatchResult {
  /** True only if every agent's edits passed all gates */
  success: boolean;
  /** Per-agent results in submission order */
  agentResults: Array<{
    agent: string;
    result: VerifyResult;
  }>;
}

// =============================================================================
// INPUT: What the caller provides
// =============================================================================

/**
 * A single code edit — search/replace within a file.
 * This is what any coding agent produces.
 */
export interface Edit {
  /** File path relative to app directory */
  file: string;
  /** Exact string to find in the file (must be unique) */
  search: string;
  /** Replacement string */
  replace: string;
}

/**
 * A predicate — a testable claim about what should be true after the edits.
 *
 * The caller says "I changed the button color" AND "the button should be orange."
 * Verify checks both the edit and the claim independently.
 */
export interface Predicate {
  /** What kind of check */
  type: 'css' | 'html' | 'content' | 'db' | 'http' | 'http_sequence'
    | 'filesystem_exists' | 'filesystem_absent' | 'filesystem_unchanged' | 'filesystem_count'
    | 'infra_resource' | 'infra_attribute' | 'infra_manifest'
    | 'serialization' | 'config' | 'security' | 'a11y' | 'performance'
    | 'hallucination';

  /** CSS selector (for css/html types) */
  selector?: string;

  /** CSS property to check (for css type) */
  property?: string;

  /** Expected value. "exists" or a specific value. */
  expected?: string;

  /** Route path this predicate applies to (e.g., "/", "/about") */
  path?: string;

  /** File path for content predicates */
  file?: string;

  /** Human-readable description */
  description?: string;

  /** Content pattern to search for */
  pattern?: string;

  // --- DB predicate fields ---
  table?: string;
  column?: string;
  assertion?: 'table_exists' | 'column_exists' | 'column_type'
    | 'column_order' | 'row_value' | 'row_count' | 'function_exists' | 'json_path'
    | 'absent' | 'no_production_drift';

  // --- HTTP predicate fields ---
  method?: string;
  body?: Record<string, unknown>;
  expect?: {
    status?: number;
    bodyContains?: string | string[];
    bodyRegex?: string;
    contentType?: string;
  };

  // --- HTTP sequence fields ---
  steps?: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
    expect?: {
      status?: number;
      bodyContains?: string | string[];
      bodyRegex?: string;
    };
    /** Optional delay before this step in ms (simulates timing races) */
    delayBeforeMs?: number;
  }>;

  // --- Filesystem predicate fields ---
  /** Expected file/directory count (for filesystem_count) */
  count?: number;
  /** SHA-256 hash captured at grounding time (for filesystem_unchanged) */
  hash?: string;

  // --- Infrastructure predicate fields ---
  /** Resource address (e.g., "aws_db_instance.production") for infra_resource/infra_attribute */
  resource?: string;
  /** Resource attribute path (e.g., "tags.Environment", "deletion_protection") for infra_attribute */
  attribute?: string;
  /** State file path relative to infra dir (for infra_manifest) */
  stateFile?: string;

  // --- Serialization predicate fields ---
  /** JSON schema to validate against (for serialization) */
  schema?: Record<string, unknown>;
  /** Comparison mode: 'strict' (exact), 'structural' (shape only), 'subset' (contains) */
  comparison?: 'strict' | 'structural' | 'subset';

  // --- Config predicate fields ---
  /** Config key to check (e.g., "DATABASE_URL", "features.darkMode") */
  key?: string;
  /** Config source: 'env', 'json', 'yaml', 'dotenv' */
  source?: 'env' | 'json' | 'yaml' | 'dotenv';

  // --- Security predicate fields ---
  /** Security check type */
  securityCheck?: 'xss' | 'sql_injection' | 'csrf' | 'secrets_in_code' | 'csp' | 'cors' | 'auth_header';

  // --- A11y predicate fields ---
  /** Accessibility check type */
  a11yCheck?: 'aria_label' | 'alt_text' | 'heading_hierarchy' | 'landmark' | 'color_contrast' | 'focus_management';

  // --- Performance predicate fields ---
  /** Performance check type */
  perfCheck?: 'response_time' | 'bundle_size' | 'image_optimization' | 'lazy_loading' | 'connection_count'
    | 'unminified_assets' | 'render_blocking' | 'dom_depth' | 'cache_headers' | 'duplicate_deps';
  /** Threshold value (ms for timing, bytes for size) */
  threshold?: number;

  // --- Hallucination predicate fields ---
  /** What the agent asserts (e.g., "users table has phone column") */
  claim?: string;
  // source field already exists above (reused for hallucination: 'schema' | 'routes' | 'css' | file path)
  /** Expected: is this claim grounded in reality or fabricated? */
  halAssert?: 'grounded' | 'fabricated';
}

/**
 * Compile-time exhaustiveness check over Predicate['type'].
 *
 * This is a WEAK form of exhaustiveness: it proves that every type literal
 * in the Predicate union is known, but it does NOT prove that gates narrow
 * predicate fields correctly by type. The strong form (assertNever over
 * variant interfaces in a gate switch) requires the discriminated union
 * refactor, which is filed as a known gap (see src/extractor/GAPS.md #6)
 * and deferred to a follow-up branch.
 *
 * If a new predicate type is added to Predicate['type'] without updating
 * this switch, the `const _exhaustive: never = t` assignment in the default
 * branch will fail to compile because `t` is narrowed to the unhandled
 * literal rather than `never`. That's the whole point. The function has no
 * runtime callers and is not exported.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _exhaustivePredicateTypeCheck(t: Predicate['type']): void {
  switch (t) {
    case 'css':
    case 'html':
    case 'content':
    case 'db':
    case 'http':
    case 'http_sequence':
    case 'filesystem_exists':
    case 'filesystem_absent':
    case 'filesystem_unchanged':
    case 'filesystem_count':
    case 'infra_resource':
    case 'infra_attribute':
    case 'infra_manifest':
    case 'serialization':
    case 'config':
    case 'security':
    case 'a11y':
    case 'performance':
    case 'hallucination':
      return;
    default: {
      // If a new predicate type is added to Predicate['type'] without a
      // matching case above, `t` is narrowed to the unhandled literal here
      // rather than `never`, and this assignment will fail to compile.
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}

/**
 * A database migration to apply during staging.
 */
export interface Migration {
  name: string;
  sql: string;
}

/**
 * System invariant — must hold after EVERY change, regardless of goal.
 * Think: "health endpoint still responds", "homepage still loads."
 */
export interface Invariant {
  name: string;
  type: 'http' | 'command';
  /** For http: path to check. For command: shell command to run. */
  path?: string;
  command?: string;
  expect?: {
    status?: number;
    contains?: string;
  };
}

/**
 * Configuration for verify().
 */
export interface VerifyConfig {
  /** Path to the app directory (where Dockerfile lives) */
  appDir: string;

  /** Goal description — what the edits are trying to achieve */
  goal?: string;

  // --- Docker options ---
  docker?: {
    /** Enable Docker compose mode (default: false) */
    compose?: boolean;
    /** Docker compose file path (default: docker-compose.yml) */
    composefile?: string;
    /** Service name in compose file (default: "app") */
    service?: string;
    /** Port the app listens on inside the container (default: 3000) */
    port?: number;
    /** Health check path (default: "/") */
    healthPath?: string;
    /** Timeout for container startup in ms (default: 60000) */
    startupTimeoutMs?: number;
    /** Timeout for build in ms (default: 120000) */
    buildTimeoutMs?: number;
  };

  // --- Gate toggles (progressive adoption) ---
  gates?: {
    /** Grounding: Reject fabricated selectors (default: true) */
    grounding?: boolean;
    /** F9: Syntax validation (default: true) */
    syntax?: boolean;
    /** K5: Constraint learning (default: true) */
    constraints?: boolean;
    /** G5: Containment attribution (default: true) */
    containment?: boolean;
    /** Staging: Docker build + start test (default: true when Docker available) */
    staging?: boolean;
    /** Browser: Playwright CSS/HTML validation (default: false — needs Playwright image) */
    browser?: boolean;
    /** HTTP: Endpoint validation against staging (default: true when staging enabled) */
    http?: boolean;
    /** Invariants: System health checks (default: true when invariants.json exists) */
    invariants?: boolean;
    /** Vision: Screenshot + model verification (default: false — needs API key) */
    vision?: boolean;
    /** Triangulation: Cross-authority verdict synthesis (default: auto when 2+ authorities) */
    triangulation?: boolean;
  };

  // --- Vision options ---
  vision?: {
    /** Vision model callback — you bring your own LLM.
     *  Receives a PNG image buffer and a prompt, returns raw text response.
     *  Verify owns the prompt and parsing — you own the API call.
     *
     *  Example with the bundled Gemini helper:
     *    import { geminiVision } from '@sovereign-labs/verify';
     *    vision: { call: geminiVision(process.env.GEMINI_API_KEY) }
     *
     *  Example with your own model:
     *    vision: { call: async (image, prompt) => myModel.analyze(image, prompt) }
     */
    call: (image: Buffer, prompt: string) => Promise<string>;
    /** Pre-captured screenshots — skip Docker/Playwright entirely.
     *  Map of route path → PNG buffer (e.g., { '/': Buffer, '/roster': Buffer }). */
    screenshots?: Record<string, Buffer>;
  };

  // --- State directory for learning ---
  /** Where to store constraints, outcomes, and receipts (default: .verify/) */
  stateDir?: string;

  /** Constraint IDs to explicitly override (bypass K5 for known risks) */
  overrideConstraints?: string[];

  /** Pre-seed constraints for testing (harness use) */
  constraints?: Array<Record<string, unknown>>;

  /** K5 constraint learning mode:
   *  - 'session' (default): constraints seeded during this call are cleaned up afterward.
   *    Each verify() call is isolated — failures don't poison subsequent calls.
   *  - 'persistent': constraints persist across calls. Use this in convergence loops
   *    (e.g., govern()) where you want the system to learn from prior failures.
   */
  learning?: 'session' | 'persistent';

  /** Migrations to apply during staging */
  migrations?: Migration[];

  /** System invariants to check after staging */
  invariants?: Invariant[];

  /** Log function for progress output */
  log?: (message: string) => void;

  /** App URL for HTTP/browser gates when staging is skipped.
   *  If provided and staging is disabled, this URL is used for HTTP predicates.
   *  Example: 'http://localhost:4567' */
  appUrl?: string;
}


// =============================================================================
// OUTPUT: What verify() returns
// =============================================================================

/**
 * Per-gate pass/fail result.
 */
export interface GateResult {
  /** Gate identifier */
  gate: 'grounding' | 'F9' | 'K5' | 'G5' | 'staging' | 'browser' | 'http' | 'invariants' | 'vision' | 'triangulation'
    | 'infrastructure' | 'serialization' | 'config' | 'security' | 'a11y' | 'performance'
    | 'filesystem' | 'access' | 'capacity' | 'contention' | 'state' | 'temporal' | 'propagation'
    | 'observation' | 'goal' | 'content' | 'hallucination';
  /** Did this gate pass? */
  passed: boolean;
  /** Human-readable detail */
  detail: string;
  /** How long this gate took */
  durationMs: number;
}

/**
 * What the caller's agent should change on the next attempt.
 * This is the learning loop — each failure makes the next attempt smarter.
 */
export interface Narrowing {
  /** New constraints seeded from this failure */
  constraints: Array<{
    id: string;
    signature: string;
    type: string;
    reason: string;
  }>;

  /** Predicate fingerprints that are now banned (K5 learned these fail) */
  bannedFingerprints?: string[];

  /** Actionable guidance — what to do differently */
  resolutionHint?: string;

  /** Prior winning fixes for matching failure signatures */
  patternRecall?: string[];

  /** Expected vs actual values from failed predicates */
  fileEvidence?: string;

  /** 2-5 valid predicate alternatives derived from reality */
  nextMoves?: NextMove[];
}

/**
 * A suggested predicate alternative when the caller's predicates fail.
 */
export interface NextMove {
  type: string;
  predicate: Partial<Predicate>;
  score: number;
  rationale: string;
  kind: string;
}

/**
 * Per-predicate result from verification.
 */
export interface PredicateResult {
  predicateId: string;
  type: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  fingerprint: string;
  groundingMiss?: boolean;
  /** Human-readable detail about the result */
  detail?: string;
  /** CSS selector (for css/html types) */
  selector?: string;
  /** CSS property checked */
  property?: string;
}

/**
 * The full result from verify().
 */
export interface VerifyResult {
  /** Did all enabled gates pass? */
  success: boolean;

  /** Per-gate pass/fail with timing */
  gates: GateResult[];

  /** On failure: what to change and what's now banned */
  narrowing?: Narrowing;

  /** Per-predicate pass/fail results */
  predicateResults?: PredicateResult[];

  /** Input predicates (for reference) */
  predicates?: Predicate[];

  /** Effective predicate set (post-bounding, post-dedup) */
  effectivePredicates?: Array<{
    id: string;
    type: string;
    fingerprint: string;
    description?: string;
    groundingMiss?: boolean;
  }>;

  /** Human-readable summary of what happened */
  attestation: string;

  /** Timing breakdown */
  timing: {
    totalMs: number;
    perGate: Record<string, number>;
  };

  /** Containment summary — are all edits explained by predicates? */
  containment?: {
    totalMutations: number;
    direct: number;
    scaffolding: number;
    unexplained: number;
  };

  /** Constraint store state — how many constraints before/after */
  constraintDelta?: {
    before: number;
    after: number;
    seeded: string[];
  };

  /** Cross-authority triangulation verdict (when 2+ authorities ran) */
  triangulation?: {
    action: string;
    confidence: string;
    outlier: string;
    authorities: { deterministic: string; browser: string; vision: string };
    authorityCount: number;
    reasoning: string;
  };
}


// =============================================================================
// INTERNAL: Runner + gate interfaces
// =============================================================================

/**
 * Abstraction for running commands against the staging container.
 */
export interface ContainerRunner {
  /** Build the Docker image */
  build(opts?: { noCache?: boolean; timeoutMs?: number }): Promise<CommandResult>;

  /** Start containers */
  start(opts?: { timeoutMs?: number }): Promise<CommandResult>;

  /** Stop and remove containers */
  stop(): Promise<void>;

  /** Run a command inside the running container */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;

  /** Get the URL to reach the app (e.g., http://localhost:3456) */
  getAppUrl(): string;

  /** Get the container name for the app service */
  getContainerName(): string;

  /** Check if the container is healthy */
  isHealthy(path?: string): Promise<boolean>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A gate function — takes context, returns pass/fail.
 */
export interface GateContext {
  /** Resolved config */
  config: VerifyConfig;

  /** Edits to verify */
  edits: Edit[];

  /** Predicates to check */
  predicates: Predicate[];

  /** Container runner (available after staging gate) */
  runner?: ContainerRunner;

  /** Staging workspace directory */
  stageDir?: string;

  /** App URL (available after container starts) */
  appUrl?: string;

  /** Grounding context from filesystem scan */
  grounding?: GroundingContext;

  /** Log function for gate output */
  log: (message: string) => void;
}

/**
 * CSS/HTML/route information extracted from the app's source files.
 */
export interface GroundingContext {
  /** CSS rules per route: route → selector → { property: value } */
  routeCSSMap: Map<string, Map<string, Record<string, string>>>;

  /** HTML elements per route */
  htmlElements: Map<string, Array<{ tag: string; text?: string; attributes?: Record<string, string> }>>;

  /** Discovered routes (pages + API) */
  routes: string[];

  /** Database schema (if available) */
  dbSchema?: Array<{ table: string; columns: Array<{ name: string; type: string }> }>;

  /** Route → class tokens found in HTML template text (for data-dependent soft-fail) */
  routeClassTokens?: Map<string, Set<string>>;

  /** Infrastructure state (parsed from terraform.tfstate / pulumi state) */
  infraState?: InfraStateContext;
}

/**
 * Parsed infrastructure state from Terraform/Pulumi state files.
 */
export interface InfraStateContext {
  /** Parsed resources from the state file */
  resources: InfraResource[];
  /** State file format version */
  version?: number;
  /** Terraform/Pulumi version */
  toolVersion?: string;
}

export interface InfraResource {
  /** Full resource address (e.g., "aws_db_instance.production") */
  address: string;
  /** Resource type (e.g., "aws_db_instance") */
  type: string;
  /** Resource ID */
  id: string;
  /** Flat attribute map (nested keys use dot notation: "tags.Environment") */
  attributes: Record<string, unknown>;
}

/**
 * Infrastructure manifest — known-good baseline for drift detection.
 */
export interface InfraManifest {
  version: number;
  resources: Array<{
    address: string;
    type: string;
    id: string;
    critical: boolean;
    attributes: Record<string, string>;
  }>;
}

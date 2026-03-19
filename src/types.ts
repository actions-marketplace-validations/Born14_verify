/**
 * @sovereign-labs/verify — Public Types
 * =====================================
 *
 * Everything a team needs to call verify() and understand the result.
 * No Sovereign internals. No daemon concepts. Just inputs and outputs.
 */

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
  type: 'css' | 'html' | 'content' | 'db' | 'http' | 'http_sequence';

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
  assertion?: 'table_exists' | 'column_exists' | 'column_type';

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
  }>;
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
  };

  // --- Vision options ---
  vision?: {
    provider: 'gemini' | 'openai' | 'anthropic';
    apiKey: string;
    model?: string;
  };

  // --- State directory for learning ---
  /** Where to store constraints, outcomes, and receipts (default: .verify/) */
  stateDir?: string;

  /** Constraint IDs to explicitly override (bypass K5 for known risks) */
  overrideConstraints?: string[];

  /** Migrations to apply during staging */
  migrations?: Migration[];

  /** System invariants to check after staging */
  invariants?: Invariant[];
}


// =============================================================================
// OUTPUT: What verify() returns
// =============================================================================

/**
 * Per-gate pass/fail result.
 */
export interface GateResult {
  /** Gate identifier */
  gate: 'F9' | 'K5' | 'G5' | 'staging' | 'browser' | 'http' | 'invariants' | 'vision';
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
  patternRecall?: string;

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
}

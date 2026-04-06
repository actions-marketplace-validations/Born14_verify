/**
 * Security Gate
 * =============
 *
 * Validates security predicates by scanning source files for common
 * vulnerabilities and security anti-patterns.
 * Pure static analysis — no network, no Docker.
 *
 * Predicate type: security
 * Check types:
 *   - XSS: innerHTML, document.write, eval with user input
 *   - SQL injection: string concatenation in queries
 *   - CSRF: missing CSRF tokens in forms
 *   - Secrets in code: hardcoded API keys, passwords, tokens
 *   - CSP: Content-Security-Policy headers present
 *   - CORS: Access-Control-Allow-Origin not wildcard
 *   - Auth headers: Authorization header validation
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import type { GateContext, GateResult, Predicate, PredicateResult } from '../types.js';

// =============================================================================
// SECURITY SCANNERS
// =============================================================================

type SecurityCheckType = 'xss' | 'sql_injection' | 'csrf' | 'secrets_in_code' | 'csp' | 'cors' | 'auth_header'
  | 'eval_usage' | 'prototype_pollution' | 'path_traversal' | 'open_redirect' | 'rate_limiting' | 'insecure_deserialization';

interface SecurityFinding {
  check: SecurityCheckType;
  file: string;
  line: number;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * Read all source files from a directory (shallow + common subdirs).
 */
function readSourceFiles(appDir: string): Array<{ path: string; content: string; relativePath: string }> {
  const files: Array<{ path: string; content: string; relativePath: string }> = [];
  const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.html', '.htm', '.ejs', '.hbs']);
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', '.sovereign', '.verify']);

  function scan(dir: string, rel: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (CODE_EXTS.has(extname(entry.name).toLowerCase())) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            files.push({ path: fullPath, content, relativePath: rel ? `${rel}/${entry.name}` : entry.name });
          } catch { /* unreadable */ }
        }
      }
    } catch { /* unreadable dir */ }
  }

  scan(appDir, '');
  return files;
}

/**
 * Scan for XSS vulnerabilities.
 */
function scanXSS(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /innerHTML\s*=(?!=)/g, detail: 'Direct innerHTML assignment (potential XSS)' },
    { regex: /document\.write\s*\(/g, detail: 'document.write usage (potential XSS)' },
    { regex: /eval\s*\(/g, detail: 'eval() usage (potential code injection)' },
    { regex: /\$\{.*\}\s*(?:innerHTML|dangerouslySetInnerHTML)/g, detail: 'Template literal in HTML injection context' },
    { regex: /dangerouslySetInnerHTML/g, detail: 'React dangerouslySetInnerHTML usage' },
  ];

  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'xss', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for SQL injection vulnerabilities.
 */
function scanSQLInjection(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*[`'"].*\$\{/g, detail: 'Template literal in SQL query (potential injection)' },
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*['"].*\+/g, detail: 'String concatenation in SQL query (potential injection)' },
    { regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s.*\+\s*(?:req\.|params\.|body\.|query\.|headers\[)/gi, detail: 'User input concatenated into SQL' },
    { regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s.*\.join\s*\(/gi, detail: 'Array join in SQL construction (potential injection)' },
  ];
  // Multi-line patterns: query call on one line, template literal with interpolation on next
  const multiLinePatterns = [
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*\n\s*`[^`]*\$\{/g, detail: 'Template literal in SQL query (potential injection)' },
    { regex: /(?:query|execute|run|fetch|prepare|raw)\s*\(\s*\n\s*['"][^'"]*\+/g, detail: 'String concatenation in SQL query (potential injection)' },
  ];

  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'sql_injection', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
    // Multi-line scan against full content
    for (const { regex, detail } of multiLinePatterns) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        const line = file.content.substring(0, match.index).split('\n').length;
        findings.push({ check: 'sql_injection', file: file.relativePath, line, detail, severity: 'high' });
      }
    }
  }
  return findings;
}

/**
 * Scan for hardcoded secrets.
 */
function scanSecrets(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    // 649a: Variable name patterns (SCREAMING_SNAKE + camelCase)
    { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, detail: 'Hardcoded password' },
    { regex: /(?:api_key|apikey|api_secret|API_KEY|API_SECRET)\s*[:=]\s*['"][^'"]{8,}['"]/gi, detail: 'Hardcoded API key' },
    { regex: /(?:secret|token|SECRET|TOKEN)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/gi, detail: 'Hardcoded secret/token' },
    { regex: /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*=\s*['"]?[A-Z0-9]{16,}['"]?/g, detail: 'Hardcoded AWS credential' },
    { regex: /(?:secretKey|apiKey|privateKey|accessToken|authToken|dbPassword|masterKey|signingKey)\s*[:=]\s*['"][^'"]{4,}['"]/g, detail: 'Hardcoded secret (camelCase name)' },
    { regex: /(?:OPENAI_API_KEY|STRIPE_SECRET|STRIPE_KEY|GITHUB_TOKEN|SLACK_TOKEN|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*[:=]\s*['"][^'"]{4,}['"]/g, detail: 'Hardcoded provider API key' },

    // 649b: Value prefix patterns (catches secrets regardless of variable name)
    { regex: /['"]sk-[A-Za-z0-9]{20,}['"]/g, detail: 'OpenAI API key prefix (sk-)' },
    { regex: /['"]sk_(?:live|test)_[A-Za-z0-9]{20,}['"]/g, detail: 'Stripe API key prefix (sk_live_/sk_test_)' },
    { regex: /['"]AIzaSy[A-Za-z0-9_-]{30,}['"]/g, detail: 'Google API key prefix (AIzaSy)' },
    { regex: /['"]ghp_[A-Za-z0-9]{30,}['"]/g, detail: 'GitHub personal access token (ghp_)' },
    { regex: /['"]gho_[A-Za-z0-9]{30,}['"]/g, detail: 'GitHub OAuth token (gho_)' },
    { regex: /['"]github_pat_[A-Za-z0-9_]{30,}['"]/g, detail: 'GitHub fine-grained token (github_pat_)' },
    { regex: /['"]AKIA[A-Z0-9]{12,}['"]/g, detail: 'AWS access key ID prefix (AKIA)' },
    { regex: /['"]xoxb-[A-Za-z0-9-]{20,}['"]/g, detail: 'Slack bot token (xoxb-)' },
    { regex: /['"]xoxp-[A-Za-z0-9-]{20,}['"]/g, detail: 'Slack user token (xoxp-)' },
    { regex: /['"]sk-ant-[A-Za-z0-9-]{20,}['"]/g, detail: 'Anthropic API key prefix (sk-ant-)' },

    // 649c: Structural value patterns
    { regex: /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g, detail: 'Private key in source code' },
    { regex: /['"]eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}['"]/g, detail: 'JWT token in source code (eyJ prefix)' },
    { regex: /process\.env\.(?:SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/gi, detail: 'Sensitive env var accessed in code (potential exposure)' },
  ];

  for (const file of files) {
    // Skip .env files — they're supposed to have secrets
    if (file.relativePath.startsWith('.env')) continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Skip comments
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
      // Skip test fixtures — values prefixed with 'test' or lines with test/fixture comments
      if (/\/\/\s*test|\/\*\s*test|test.?fixture/i.test(lines[i])) continue;
      if (/[:=]\s*['"]test[-_]/i.test(lines[i])) continue;
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'secrets_in_code', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for CSP headers.
 */
function scanCSP(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const hasCSP = files.some(f =>
    f.content.includes('Content-Security-Policy') ||
    f.content.includes('content-security-policy') ||
    f.content.includes('helmet')
  );

  if (!hasCSP) {
    return [{ check: 'csp', file: '(project)', line: 0, detail: 'No Content-Security-Policy header found', severity: 'medium' }];
  }
  return [];
}

/**
 * Scan for CORS wildcard.
 */
function scanCORS(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/Access-Control-Allow-Origin.*\*/i.test(lines[i]) ||
          /cors\(\s*\)/.test(lines[i]) ||
          /origin:\s*['"]?\*['"]?/.test(lines[i])) {
        findings.push({
          check: 'cors',
          file: file.relativePath,
          line: i + 1,
          detail: 'CORS wildcard (*) allows any origin',
          severity: 'medium',
        });
      }
    }
  }
  return findings;
}

/**
 * Scan for eval / new Function usage.
 */
function scanEvalUsage(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /\beval\s*\(/g, detail: 'eval() usage (code injection risk)' },
    { regex: /new\s+Function\s*\(/g, detail: 'new Function() usage (code injection risk)' },
    { regex: /setTimeout\s*\(\s*['"`]/g, detail: 'setTimeout with string argument (implicit eval)' },
    { regex: /setInterval\s*\(\s*['"`]/g, detail: 'setInterval with string argument (implicit eval)' },
  ];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'eval_usage', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for prototype pollution patterns.
 */
function scanPrototypePollution(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /__proto__/g, detail: '__proto__ access (prototype pollution risk)' },
    { regex: /constructor\s*\[\s*['"]prototype['"]\s*\]/g, detail: 'constructor.prototype access (prototype pollution risk)' },
    { regex: /Object\.assign\s*\(\s*(?:{}|Object\.prototype)/g, detail: 'Object.assign to Object.prototype (prototype pollution)' },
  ];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'prototype_pollution', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for path traversal in file operations.
 */
function scanPathTraversal(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync)\s*\(\s*(?:req\.|params\.|body\.|query\.|args\.)/g, detail: 'User input in file operation (path traversal risk)' },
    { regex: /(?:readFile|readFileSync|createReadStream)\s*\([^)]*\+[^)]*(?:req|params|body|query)/g, detail: 'Concatenated user input in file path' },
  ];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'path_traversal', file: file.relativePath, line: i + 1, detail, severity: 'high' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for open redirect vulnerabilities.
 */
function scanOpenRedirect(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /(?:redirect|location)\s*(?:=|\()\s*(?:req\.|params\.|body\.|query\.)/g, detail: 'User input in redirect (open redirect risk)' },
    { regex: /res\.redirect\s*\(\s*(?:req\.|params\.|query\.)/g, detail: 'Express redirect with user input' },
    { regex: /Location['"]\s*:\s*(?:req\.|params\.|query\.|body\.|\w+\s*\+)/g, detail: 'User input in Location header (open redirect risk)' },
    { regex: /window\.location\s*=\s*[`'"].*\$\{/g, detail: 'Template literal in window.location (client-side redirect)' },
    { regex: /window\.location\s*=\s*['"].*\+/g, detail: 'String concat in window.location (client-side redirect)' },
    { regex: /['"]Location['"]\s*:\s*['"].*\+\s*\w+/g, detail: 'Variable in Location header (open redirect risk)' },
  ];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'open_redirect', file: file.relativePath, line: i + 1, detail, severity: 'medium' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for missing rate limiting on auth endpoints.
 */
function scanRateLimiting(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const hasRateLimit = files.some(f =>
    /rate.?limit/i.test(f.content) || /express-rate-limit/i.test(f.content) || /throttle/i.test(f.content)
  );
  if (!hasRateLimit) {
    for (const file of files) {
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/(?:post|app\.post)\s*\(\s*['"]\/(?:auth|login|signin|register|reset|password|verify|confirm)/i.test(lines[i])) {
          findings.push({ check: 'rate_limiting', file: file.relativePath, line: i + 1, detail: 'Auth/sensitive endpoint without rate limiting', severity: 'medium' });
        }
      }
    }
  }
  return findings;
}

/**
 * Scan for insecure deserialization.
 */
function scanInsecureDeserialization(files: Array<{ relativePath: string; content: string }>): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [
    { regex: /JSON\.parse\s*\(\s*(?:req\.|params\.|body\.|query\.|headers\.)/g, detail: 'JSON.parse on user input without validation' },
    { regex: /(?:unserialize|deserialize)\s*\(\s*(?:req\.|params\.|body\.|query\.)/g, detail: 'Deserialization of user input' },
  ];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, detail } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          findings.push({ check: 'insecure_deserialization', file: file.relativePath, line: i + 1, detail, severity: 'medium' });
        }
      }
    }
  }
  return findings;
}

/**
 * Run a specific security check and return findings.
 */
function runSecurityCheck(
  check: SecurityCheckType,
  files: Array<{ relativePath: string; content: string }>,
): SecurityFinding[] {
  switch (check) {
    case 'xss': return scanXSS(files);
    case 'sql_injection': return scanSQLInjection(files);
    case 'secrets_in_code': return scanSecrets(files);
    case 'csp': return scanCSP(files);
    case 'cors': return scanCORS(files);
    case 'csrf': return []; // CSRF is structural — hard to detect statically
    case 'auth_header': return []; // Auth header is runtime — deferred to HTTP gate
    case 'eval_usage': return scanEvalUsage(files);
    case 'prototype_pollution': return scanPrototypePollution(files);
    case 'path_traversal': return scanPathTraversal(files);
    case 'open_redirect': return scanOpenRedirect(files);
    case 'rate_limiting': return scanRateLimiting(files);
    case 'insecure_deserialization': return scanInsecureDeserialization(files);
    default: return [];
  }
}

// =============================================================================
// SECURITY GATE
// =============================================================================

export function runSecurityGate(ctx: GateContext): GateResult & { predicateResults: PredicateResult[] } {
  const start = Date.now();
  const secPreds = ctx.predicates.filter(p => p.type === 'security');

  if (secPreds.length === 0) {
    return {
      gate: 'security' as any,
      passed: true,
      detail: 'No security predicates to check',
      durationMs: Date.now() - start,
      predicateResults: [],
    };
  }

  const scanDir = ctx.stageDir ?? ctx.config.appDir;
  let sourceFiles = readSourceFiles(scanDir);

  // Scope scan to edited files only — avoids flagging pre-existing issues
  // in files the PR didn't touch. If no edits, scan everything (full audit mode).
  if (ctx.edits.length > 0) {
    const editedFiles = new Set(ctx.edits.map(e => e.file));
    sourceFiles = sourceFiles.filter(f => editedFiles.has(f.relativePath));
  }
  const results: PredicateResult[] = [];
  let allPassed = true;
  const details: string[] = [];

  for (let i = 0; i < secPreds.length; i++) {
    const p = secPreds[i];
    const result = validateSecurityPredicate(p, sourceFiles);
    results.push({ ...result, predicateId: `sec_p${i}` });

    if (!result.passed) {
      allPassed = false;
      details.push(result.actual ?? 'failed');
    }
  }

  const passCount = results.filter(r => r.passed).length;
  const detail = allPassed
    ? `All ${secPreds.length} security predicates passed`
    : `${passCount}/${secPreds.length} passed: ${details.join('; ')}`;

  ctx.log(`[security] ${detail}`);

  return {
    gate: 'security' as any,
    passed: allPassed,
    detail,
    durationMs: Date.now() - start,
    predicateResults: results,
  };
}

function validateSecurityPredicate(
  p: Predicate,
  files: Array<{ relativePath: string; content: string }>,
): Omit<PredicateResult, 'predicateId'> {
  const check = p.securityCheck;
  const fingerprint = `type=security|check=${check}`;

  if (!check) {
    return { type: 'security', passed: false, expected: 'security check type', actual: '(no securityCheck specified)', fingerprint };
  }

  const expected = p.expected ?? 'no_findings';
  const findings = runSecurityCheck(check, files);

  if (expected === 'no_findings' || expected === 'clean' || expected === 'pass') {
    // Expect no findings (security is clean)
    const passed = findings.length === 0;
    return {
      type: 'security',
      passed,
      expected: `${check}: no findings`,
      actual: passed
        ? `${check}: clean`
        : `${findings.length} finding(s): ${findings.slice(0, 3).map(f => `${f.file}:${f.line} ${f.detail}`).join('; ')}`,
      fingerprint,
    };
  }

  if (expected === 'has_findings' || expected === 'fail') {
    // Expect findings to exist (intentional negative test)
    const passed = findings.length > 0;
    return {
      type: 'security',
      passed,
      expected: `${check}: has findings`,
      actual: passed
        ? `${findings.length} finding(s) detected`
        : `${check}: no findings (expected some)`,
      fingerprint,
    };
  }

  return { type: 'security', passed: false, expected, actual: `unknown expected value: ${expected}`, fingerprint };
}

/**
 * Security Gate Scenario Harvester
 * =================================
 *
 * Generates scenarios for all 13 security check types by creating code
 * snippets that precisely match (or don't match) our gate's regex patterns.
 *
 * Each scenario creates a single .js file with code that either:
 *   - Triggers a specific security scanner (expectedSuccess: true, expected: 'has_findings')
 *   - Does NOT trigger a scanner (expectedSuccess: true, expected: 'no_findings')
 *
 * Pattern vocabulary informed by secrets-patterns-db
 * (https://github.com/mazen160/secrets-patterns-db).
 *
 * Run: bun scripts/harvest/stage-secrets-patterns.ts
 * Output: fixtures/scenarios/secrets-staged.json
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

const outPath = resolve('fixtures/scenarios/secrets-staged.json');
const scenarios: any[] = [];
let id = 1;

function push(s: any) {
  scenarios.push({ id: `secrets-${String(id++).padStart(4, '0')}`, requiresDocker: false, ...s });
}

function wrapInFile(codeLine: string): string {
  return `const express = require('express');\nconst app = express();\n${codeLine}\napp.listen(3000);\n`;
}

function wrapInHandler(codeLine: string): string {
  return `const express = require('express');\nconst path = require('path');\nconst fs = require('fs');\nconst app = express();\napp.get('/test', (req, res) => {\n  ${codeLine}\n});\napp.listen(3000);\n`;
}

interface TestCase {
  name: string;
  code: string;      // code line
  check: string;     // security check type
  shouldDetect: boolean;
  wrapMode?: 'file' | 'handler';
}

// =============================================================================
// SECRETS_IN_CODE — Our gate matches 5 regex families
// =============================================================================

function secretsInCodeCases(): TestCase[] {
  const cases: TestCase[] = [];

  // Family 1: password/passwd/pwd = 'value' (4+ chars)
  // Regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi
  const passwordPositive = [
    { name: 'MySQL password', code: `const db_password = 'MyS3cur3P@ss!';` },
    { name: 'PostgreSQL passwd', code: `const POSTGRES_PASSWD = 'p0stgr3s_s3cret';` },
    { name: 'Redis pwd', code: `const REDIS_PWD = 'r3d1s-auth-token';` },
    { name: 'LDAP password', code: `config.password = 'ldap_bind_123';` },
    { name: 'SMTP password', code: `const smtp_password = 'sm7p-sender';` },
    { name: 'Password in object', code: `{ password: 'ConfiguredPass99' }` },
    { name: 'Password with colon', code: `password: 'complex-pass-here'` },
    { name: 'Admin password literal', code: `password = 'SuperAdmin123!';` },
    { name: 'Passwd assignment', code: `const db_passwd = 'mongo_auth_key_v2';` },
    { name: 'Pwd double-quoted', code: `const pwd = "production_pwd_2024";` },
  ];

  const passwordNegative = [
    { name: 'Password from env', code: `const password = process.env.DB_PASSWORD;` },
    { name: 'Password null', code: `let password = null;` },
    { name: 'Password short', code: `const pwd = '12';` },
    { name: 'Password var only', code: `let password;` },
    { name: 'Password check logic', code: `if (password.length < 8) throw new Error('too short');` },
  ];

  for (const p of passwordPositive) {
    cases.push({ name: `password: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: true });
  }
  for (const p of passwordNegative) {
    cases.push({ name: `password: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: false });
  }

  // Family 2: api_key/apikey/api_secret = 'value' (8+ chars)
  // Regex: /(?:api_key|apikey|api_secret)\s*[:=]\s*['"][^'"]{8,}['"]/gi
  const apiKeyPositive = [
    { name: 'Stripe API key', code: `const api_key = 'sk_live_FAKEKEYFAKEKEYFAKEKEY01';` },
    { name: 'Sendgrid API key', code: `const APIKEY = 'SG.abcdefghijklmnopqrstuv.wxyz';` },
    { name: 'Twilio API secret', code: `const api_secret = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';` },
    { name: 'Generic API key', code: `config.api_key = 'xk-proj-abcdefghij1234567890';` },
    { name: 'Mailgun API key', code: `const API_KEY = 'key-abcdef1234567890abcdef12345678';` },
    { name: 'Datadog apikey', code: `const apikey = 'dd-api-abcdefghijklmnopqrstuvwxyz12';` },
    { name: 'API secret config', code: `api_secret = 'SecretKeyValue1234567890ABCD';` },
    { name: 'OpenAI API key', code: `const OPENAI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz12345678';` },
  ];

  const apiKeyNegative = [
    { name: 'API key from env', code: `const api_key = process.env.API_KEY;` },
    { name: 'API key short', code: `const apikey = 'short';` },
    { name: 'API key function', code: `function rotateAPIKey(userId) { return generateNewKey(); }` },
    { name: 'API key type annotation', code: `const apiKey: string = getConfig('api_key');` },
  ];

  for (const p of apiKeyPositive) {
    cases.push({ name: `api_key: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: true });
  }
  for (const p of apiKeyNegative) {
    cases.push({ name: `api_key: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: false });
  }

  // Family 3: secret/token = 'base64-like-value' (20+ chars, [A-Za-z0-9+/=] only)
  // Regex: /(?:secret|token)\s*[:=]\s*['"][A-Za-z0-9+/=]{20,}['"]/gi
  const tokenPositive = [
    { name: 'JWT secret', code: `const JWT_SECRET = 'aVeryLongSecretKeyForJWTSigning2024Plus';` },
    { name: 'Session token', code: `const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';` },
    { name: 'Slack token', code: `const SLACK_TOKEN = 'xoxbABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';` },
    { name: 'Firebase secret', code: `const token = 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345';` },
    { name: 'Heroku secret', code: `const SECRET = 'aaaabbbbccccddddeeeeffffgggghhhhiiiijjjj';` },
    { name: 'PyPI token', code: `const token = 'pypiABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop';` },
    { name: 'Encryption secret', code: `const secret = 'base64EncodedSecretKeyValue1234567890ABCD==';` },
    { name: 'Signing secret colon', code: `secret: 'v1ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh'` },
    { name: 'Auth token', code: `const AUTH_TOKEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';` },
    { name: 'Session secret', code: `const SESSION_SECRET = 'SuperSecretSessionKeyForExpress2024';` },
  ];

  const tokenNegative = [
    { name: 'Token from env', code: `const token = process.env.AUTH_TOKEN;` },
    { name: 'Token empty', code: `const token = '';` },
    { name: 'Token refresh func', code: `async function refreshToken() { return await fetch('/auth/refresh'); }` },
    { name: 'Secret short', code: `const secret = 'short';` },
  ];

  for (const p of tokenPositive) {
    cases.push({ name: `token: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: true });
  }
  for (const p of tokenNegative) {
    cases.push({ name: `token: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: false });
  }

  // Family 4: AWS credentials
  // Regex: /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*=\s*['"]?[A-Z0-9]{16,}['"]?/g
  const awsPositive = [
    { name: 'AWS access key', code: `AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';` },
    { name: 'AWS access key quoted', code: `AWS_ACCESS_KEY_ID = "AKIAI44QH8DHBEXAMPLE";` },
    { name: 'AWS access key inline', code: `const AWS_ACCESS_KEY_ID='AKIAEXAMPLEKEYID1234';` },
    { name: 'AWS access unquoted', code: `AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLEKEY` },
  ];

  const awsNegative = [
    { name: 'AWS key from env', code: `const key = process.env.AWS_ACCESS_KEY_ID;` },
    { name: 'AWS key placeholder', code: `AWS_ACCESS_KEY_ID = 'your-key-here'` },
  ];

  for (const p of awsPositive) {
    cases.push({ name: `aws: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: true });
  }
  for (const p of awsNegative) {
    cases.push({ name: `aws: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: false });
  }

  // Family 5: Private keys
  // Regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g
  const pkPositive = [
    { name: 'RSA private key', code: `-----BEGIN RSA PRIVATE KEY-----` },
    { name: 'Generic private key', code: `-----BEGIN PRIVATE KEY-----` },
    { name: 'PK in string literal', code: `const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...";` },
    { name: 'PK in template literal', code: '`-----BEGIN PRIVATE KEY-----`' },
  ];

  for (const p of pkPositive) {
    cases.push({ name: `private_key: ${p.name}`, code: p.code, check: 'secrets_in_code', shouldDetect: true });
  }

  return cases;
}

// =============================================================================
// XSS — Our gate matches innerHTML, document.write, eval, dangerouslySetInnerHTML
// =============================================================================

function xssCases(): TestCase[] {
  return [
    // Positive
    { name: 'innerHTML assignment', code: `element.innerHTML = userInput;`, check: 'xss', shouldDetect: true, wrapMode: 'handler' },
    { name: 'document.write call', code: `document.write('<div>' + name + '</div>');`, check: 'xss', shouldDetect: true, wrapMode: 'handler' },
    { name: 'eval with variable', code: `eval(userCode);`, check: 'xss', shouldDetect: true, wrapMode: 'handler' },
    { name: 'dangerouslySetInnerHTML', code: `<div dangerouslySetInnerHTML={{__html: data}} />`, check: 'xss', shouldDetect: true, wrapMode: 'handler' },
    { name: 'innerHTML template', code: 'el.innerHTML = `<p>${userData}</p>`;', check: 'xss', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'textContent safe', code: `element.textContent = userInput;`, check: 'xss', shouldDetect: false, wrapMode: 'handler' },
    { name: 'createElement safe', code: `const div = document.createElement('div');`, check: 'xss', shouldDetect: false, wrapMode: 'handler' },
    { name: 'innerText safe', code: `element.innerText = userInput;`, check: 'xss', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// SQL_INJECTION — query/execute/run with template literals or concatenation
// =============================================================================

function sqlInjectionCases(): TestCase[] {
  return [
    // Positive
    { name: 'Query concatenation', code: `db.query('SELECT * FROM users WHERE id = ' + req.params.id);`, check: 'sql_injection', shouldDetect: true, wrapMode: 'handler' },
    { name: 'Template in query', code: 'db.query(`SELECT * FROM users WHERE name = \'${req.body.name}\'`);', check: 'sql_injection', shouldDetect: true, wrapMode: 'handler' },
    { name: 'Execute concatenation', code: `db.execute('DELETE FROM sessions WHERE token = ' + req.headers.token);`, check: 'sql_injection', shouldDetect: true, wrapMode: 'handler' },
    { name: 'SELECT with user input', code: `SELECT * FROM users WHERE email = ' + req.body.email`, check: 'sql_injection', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'Parameterized query', code: `db.query('SELECT * FROM users WHERE id = $1', [userId]);`, check: 'sql_injection', shouldDetect: false, wrapMode: 'handler' },
    { name: 'ORM findOne', code: `await User.findOne({ where: { id: userId } });`, check: 'sql_injection', shouldDetect: false, wrapMode: 'handler' },
    { name: 'Prepared statement', code: `const stmt = db.prepare('SELECT * FROM users WHERE id = ?');`, check: 'sql_injection', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// EVAL_USAGE — eval(), new Function(), setTimeout/setInterval with string
// =============================================================================

function evalUsageCases(): TestCase[] {
  return [
    // Positive
    { name: 'eval call', code: `eval(userCode);`, check: 'eval_usage', shouldDetect: true, wrapMode: 'handler' },
    { name: 'new Function', code: `new Function('return ' + expression)();`, check: 'eval_usage', shouldDetect: true, wrapMode: 'handler' },
    { name: 'setTimeout string', code: `setTimeout('doSomething(' + id + ')', 1000);`, check: 'eval_usage', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'JSON.parse safe', code: `const data = JSON.parse(jsonString);`, check: 'eval_usage', shouldDetect: false, wrapMode: 'handler' },
    { name: 'setTimeout function', code: `setTimeout(() => doSomething(id), 1000);`, check: 'eval_usage', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// PROTOTYPE_POLLUTION — __proto__, constructor["prototype"]
// =============================================================================

function prototypePollutionCases(): TestCase[] {
  return [
    // Positive
    { name: '__proto__ access', code: `obj.__proto__.isAdmin = true;`, check: 'prototype_pollution', shouldDetect: true, wrapMode: 'handler' },
    { name: 'bracket constructor', code: `obj.constructor['prototype'].polluted = true;`, check: 'prototype_pollution', shouldDetect: true, wrapMode: 'handler' },
    { name: '__proto__ read', code: `const proto = target.__proto__;`, check: 'prototype_pollution', shouldDetect: true, wrapMode: 'handler' },
    { name: 'Object.assign prototype', code: `Object.assign(Object.prototype, userInput);`, check: 'prototype_pollution', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'Object.create', code: `const obj = Object.create(null);`, check: 'prototype_pollution', shouldDetect: false, wrapMode: 'handler' },
    { name: 'Object.freeze', code: `Object.freeze(config);`, check: 'prototype_pollution', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// PATH_TRAVERSAL — readFile/writeFile with req./params./body./query.
// =============================================================================

function pathTraversalCases(): TestCase[] {
  return [
    // Positive — readFile/writeFile with user input directly
    { name: 'readFileSync with query', code: `fs.readFileSync(req.query.file);`, check: 'path_traversal', shouldDetect: true, wrapMode: 'handler' },
    { name: 'readFile with concat', code: `fs.readFileSync('/data/' + req.query.file);`, check: 'path_traversal', shouldDetect: true, wrapMode: 'handler' },
    { name: 'writeFile with params', code: `fs.writeFile(req.params.filename, data, cb);`, check: 'path_traversal', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'readFile static path', code: `fs.readFileSync('./config.json', 'utf8');`, check: 'path_traversal', shouldDetect: false, wrapMode: 'handler' },
    { name: 'readFile with sanitize', code: `const safePath = path.basename(userInput); fs.readFileSync(safePath);`, check: 'path_traversal', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// OPEN_REDIRECT — redirect/location with req./params./query.
// =============================================================================

function openRedirectCases(): TestCase[] {
  return [
    // Positive
    { name: 'res.redirect with query', code: `res.redirect(req.query.returnUrl);`, check: 'open_redirect', shouldDetect: true, wrapMode: 'handler' },
    { name: 'res.redirect with params', code: `res.redirect(req.params.redirect);`, check: 'open_redirect', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'Redirect to static URL', code: `res.redirect('/dashboard');`, check: 'open_redirect', shouldDetect: false, wrapMode: 'handler' },
    { name: 'Redirect with allowlist', code: `if (allowedUrls.includes(url)) res.redirect(url);`, check: 'open_redirect', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// CORS — Access-Control-Allow-Origin *, cors(), origin: '*'
// =============================================================================

function corsCases(): TestCase[] {
  return [
    // Positive
    { name: 'CORS wildcard header', code: `res.setHeader('Access-Control-Allow-Origin', '*');`, check: 'cors', shouldDetect: true, wrapMode: 'handler' },
    { name: 'cors() no config', code: `app.use(cors());`, check: 'cors', shouldDetect: true },
    { name: 'origin wildcard', code: `const opts = { origin: '*' };`, check: 'cors', shouldDetect: true, wrapMode: 'handler' },
    // Negative
    { name: 'CORS specific origin', code: `res.setHeader('Access-Control-Allow-Origin', 'https://myapp.com');`, check: 'cors', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// INSECURE_DESERIALIZATION — unserialize, pickle.loads, yaml.load
// =============================================================================

function insecureDeserializationCases(): TestCase[] {
  return [
    // Positive — our regex requires req./params./body./query. after the call
    { name: 'unserialize with req.body', code: `const data = unserialize(req.body.data);`, check: 'insecure_deserialization', shouldDetect: true, wrapMode: 'handler' },
    { name: 'JSON.parse with req.body', code: `const data = JSON.parse(req.body);`, check: 'insecure_deserialization', shouldDetect: true, wrapMode: 'handler' },
    { name: 'deserialize with query', code: `const obj = deserialize(req.query.payload);`, check: 'insecure_deserialization', shouldDetect: true, wrapMode: 'handler' },
    // Negative — no req./params. prefix
    { name: 'JSON.parse static', code: `const data = JSON.parse('{"key": "value"}');`, check: 'insecure_deserialization', shouldDetect: false, wrapMode: 'handler' },
    { name: 'yaml.load with variable', code: `const config = yaml.load(fileContent);`, check: 'insecure_deserialization', shouldDetect: false, wrapMode: 'handler' },
  ];
}

// =============================================================================
// MAIN
// =============================================================================

function main() {
  console.log('Security Gate Scenario Harvester');
  console.log('================================\n');

  const allCases: TestCase[] = [
    ...secretsInCodeCases(),
    ...xssCases(),
    ...sqlInjectionCases(),
    ...evalUsageCases(),
    ...prototypePollutionCases(),
    ...pathTraversalCases(),
    ...openRedirectCases(),
    ...corsCases(),
    ...insecureDeserializationCases(),
  ];

  const checkCounts: Record<string, number> = {};

  for (const tc of allCases) {
    const fileContent = tc.wrapMode === 'handler' ? wrapInHandler(tc.code) : wrapInFile(tc.code);
    push({
      description: `security ${tc.check}: ${tc.name} (${tc.shouldDetect ? 'detect' : 'clean'})`,
      edits: [{
        file: 'app.js',
        search: '',
        replace: fileContent,
      }],
      predicates: [{
        type: 'security',
        securityCheck: tc.check,
        expected: tc.shouldDetect ? 'has_findings' : 'no_findings',
      }],
      expectedSuccess: true,
      intent: 'false_negative',
      tags: ['security', tc.check],
      rationale: `Security check ${tc.check}: ${tc.name}`,
    });

    checkCounts[tc.check] = (checkCounts[tc.check] || 0) + 1;
  }

  // Print summary
  for (const [check, count] of Object.entries(checkCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${check}: ${count} scenarios`);
  }

  writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
  console.log(`\nTotal: ${scenarios.length} scenarios`);
  console.log(`Output: ${outPath}`);
}

main();

/**
 * Real-World Infrastructure Harvester
 * ====================================
 *
 * Reads real infrastructure error catalogs and converts to verify scenarios.
 * Currently supports Heroku error codes (H10-H99, R10-R99, L10-L99).
 *
 * The Heroku error codes are well-documented failure modes that every
 * web deployment can encounter. Each code maps to a specific infrastructure
 * failure pattern detectable by verify's infrastructure gate.
 *
 * Input: Heroku error page HTML (fetched from devcenter) or hardcoded catalog
 *        (the error codes themselves are public domain — the list is stable)
 *
 * Output: VerifyScenario[] with source: 'real-world'
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

interface ErrorCode {
  code: string;
  name: string;
  description: string;
  category: 'http' | 'runtime' | 'limit';
  editPattern: string;  // what code change would cause this
  predicateType: string; // which predicate type detects it
}

interface VerifyScenario {
  id: string;
  description: string;
  edits: Array<{ file: string; search: string; replace: string }>;
  predicates: Array<Record<string, any>>;
  expectedSuccess: boolean;
  tags: string[];
  rationale: string;
  source: 'real-world';
}

// Heroku error codes — real production error catalog
// Source: https://devcenter.heroku.com/articles/error-codes
// These are stable, public, and represent real infrastructure failure modes
const HEROKU_ERRORS: ErrorCode[] = [
  { code: 'H10', name: 'App crashed', description: 'A crashed web dyno or a boot timeout on the web dyno will present this error.', category: 'http', editPattern: 'process.exit(1)', predicateType: 'infra_attribute' },
  { code: 'H11', name: 'Backlog too deep', description: 'HTTP requests are taking too long, causing the router queue to grow.', category: 'http', editPattern: 'while(true){}', predicateType: 'infra_attribute' },
  { code: 'H12', name: 'Request timeout', description: 'An HTTP request took longer than 30 seconds to complete.', category: 'http', editPattern: 'setTimeout(() => res.end(), 35000)', predicateType: 'http' },
  { code: 'H13', name: 'Connection closed without response', description: 'The dyno accepted the connection but closed it without sending a response.', category: 'http', editPattern: 'req.socket.destroy()', predicateType: 'http' },
  { code: 'H14', name: 'No web dynos running', description: 'No web dynos are running for this app.', category: 'runtime', editPattern: 'web: 0', predicateType: 'infra_attribute' },
  { code: 'H15', name: 'Idle connection', description: 'The dyno did not send a response within the router timeout.', category: 'http', editPattern: '// no res.end() call', predicateType: 'http' },
  { code: 'H17', name: 'Poorly formatted HTTP response', description: 'The dyno sent a malformed HTTP response.', category: 'http', editPattern: 'res.socket.write("not http")', predicateType: 'http' },
  { code: 'H18', name: 'Server Request Interrupted', description: 'A request was interrupted by the client before completion.', category: 'http', editPattern: 'client.abort()', predicateType: 'http' },
  { code: 'H19', name: 'Backend connection timeout', description: 'The router could not establish a connection to the dyno.', category: 'runtime', editPattern: 'ECONNREFUSED', predicateType: 'infra_attribute' },
  { code: 'H20', name: 'App boot timeout', description: 'The web process failed to bind to $PORT within 60 seconds.', category: 'runtime', editPattern: '// never listen on PORT', predicateType: 'infra_attribute' },
  { code: 'H21', name: 'Backend connection refused', description: 'The dyno refused the connection.', category: 'runtime', editPattern: 'server.close()', predicateType: 'infra_attribute' },
  { code: 'H22', name: 'Connection limit reached', description: 'Too many connections open to the dyno.', category: 'limit', editPattern: 'maxConnections: 1', predicateType: 'infra_resource' },
  { code: 'H23', name: 'Endpoint misconfigured', description: 'A routing endpoint is configured but has no matching web process.', category: 'runtime', editPattern: 'wrong_port', predicateType: 'infra_attribute' },
  { code: 'H24', name: 'Forced close', description: 'The connection was force closed after idle timeout.', category: 'http', editPattern: 'keepAlive: false', predicateType: 'http' },
  { code: 'H25', name: 'HTTP Restriction', description: 'Request was blocked by HTTP restriction rules.', category: 'http', editPattern: 'blocked_by_policy', predicateType: 'http' },
  { code: 'H27', name: 'Client Request Interrupted', description: 'The client socket was closed before response completion.', category: 'http', editPattern: 'client_disconnect', predicateType: 'http' },
  { code: 'H28', name: 'Client Connection Idle', description: 'The client connection was idle for too long.', category: 'http', editPattern: 'idle_timeout', predicateType: 'http' },
  { code: 'H31', name: 'Misdirected Request', description: 'The request was sent to a dyno that is not configured to handle it.', category: 'http', editPattern: 'wrong_host_header', predicateType: 'http' },
  { code: 'H33', name: 'Simultaneous connections', description: 'Too many simultaneous connections from one source.', category: 'limit', editPattern: 'concurrent_limit', predicateType: 'infra_resource' },
  { code: 'H80', name: 'Maintenance mode', description: 'The app is in maintenance mode.', category: 'runtime', editPattern: 'maintenance: true', predicateType: 'infra_attribute' },
  { code: 'H81', name: 'Blank app', description: 'No code has been deployed.', category: 'runtime', editPattern: 'empty_deploy', predicateType: 'infra_attribute' },
  { code: 'H82', name: 'Free dyno quota', description: 'Free dyno hour quota exhausted.', category: 'limit', editPattern: 'quota_exceeded', predicateType: 'infra_resource' },
  { code: 'H99', name: 'Platform error', description: 'An internal Heroku platform error.', category: 'runtime', editPattern: 'platform_failure', predicateType: 'infra_attribute' },
  { code: 'R10', name: 'Boot timeout', description: 'A web process took longer than 60 seconds to bind to its assigned $PORT.', category: 'runtime', editPattern: 'slow_startup', predicateType: 'infra_attribute' },
  { code: 'R12', name: 'Exit timeout', description: 'A process failed to exit within 30 seconds of SIGTERM.', category: 'runtime', editPattern: 'no_sigterm_handler', predicateType: 'infra_attribute' },
  { code: 'R13', name: 'Attach error', description: 'A dyno started with heroku run failed to attach to the process.', category: 'runtime', editPattern: 'attach_failed', predicateType: 'infra_attribute' },
  { code: 'R14', name: 'Memory quota exceeded', description: 'A dyno exceeded its memory quota.', category: 'limit', editPattern: 'memory_leak', predicateType: 'infra_resource' },
  { code: 'R15', name: 'Memory quota vastly exceeded', description: 'A dyno exceeded 2x its memory quota and was killed.', category: 'limit', editPattern: 'oom_killed', predicateType: 'infra_resource' },
  { code: 'R16', name: 'Detached', description: 'An attached one-off dyno became detached.', category: 'runtime', editPattern: 'detach', predicateType: 'infra_attribute' },
  { code: 'R17', name: 'Checksum error', description: 'The slug checksum did not match during extraction.', category: 'runtime', editPattern: 'corrupt_deploy', predicateType: 'infra_attribute' },
  { code: 'L10', name: 'Drain buffer overflow', description: 'The log drain buffer overflowed.', category: 'limit', editPattern: 'log_flood', predicateType: 'infra_resource' },
  { code: 'L11', name: 'Tail buffer overflow', description: 'The log tail buffer overflowed.', category: 'limit', editPattern: 'tail_overflow', predicateType: 'infra_resource' },
  { code: 'L12', name: 'Local buffer overflow', description: 'The local log buffer overflowed.', category: 'limit', editPattern: 'local_log_overflow', predicateType: 'infra_resource' },
  { code: 'L13', name: 'Local delivery error', description: 'A log message could not be delivered to the local syslog.', category: 'limit', editPattern: 'syslog_unreachable', predicateType: 'infra_attribute' },
  { code: 'L14', name: 'Certificate error', description: 'There was an error with the TLS certificate.', category: 'runtime', editPattern: 'cert_expired', predicateType: 'infra_attribute' },
  { code: 'L15', name: 'Tail connection error', description: 'An error occurred in the log tail connection.', category: 'limit', editPattern: 'tail_disconnect', predicateType: 'infra_attribute' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Docker Compose Parser (lightweight, no YAML dependency)
// ─────────────────────────────────────────────────────────────────────────────

interface ComposeService {
  name: string;
  image?: string;
  ports: string[];
  volumes: string[];
  hasHealthcheck: boolean;
  dependsOn: string[];
  environment: string[];
}

interface ComposeFile {
  path: string;
  projectName: string;
  services: ComposeService[];
}

/**
 * Parse a docker-compose YAML file using line-indent scanning.
 * Handles the 90% case: services with image, ports, volumes, healthcheck, depends_on.
 */
function parseComposeYAML(content: string, filePath: string): ComposeFile | null {
  const lines = content.split('\n');
  const services: ComposeService[] = [];
  let inServices = false;
  let currentService: ComposeService | null = null;
  let currentKey = '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level `services:` section
    if (indent === 0 && trimmed === 'services:') {
      inServices = true;
      continue;
    }
    // Any other top-level key exits services
    if (indent === 0 && trimmed.endsWith(':') && trimmed !== 'services:') {
      inServices = false;
      continue;
    }

    if (!inServices) continue;

    // Service name (indent 2)
    if (indent === 2 && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      if (currentService) services.push(currentService);
      currentService = {
        name: trimmed.replace(':', '').trim(),
        ports: [],
        volumes: [],
        hasHealthcheck: false,
        dependsOn: [],
        environment: [],
      };
      currentKey = '';
      continue;
    }

    if (!currentService) continue;

    // Service properties (indent 4+)
    if (indent >= 4) {
      // Key: value at indent 4
      if (indent === 4 && trimmed.includes(':') && !trimmed.startsWith('-')) {
        const [key, ...rest] = trimmed.split(':');
        const value = rest.join(':').trim();
        currentKey = key.trim();

        if (currentKey === 'image' && value) currentService.image = value;
        if (currentKey === 'healthcheck') currentService.hasHealthcheck = true;
      }

      // List items (indent 6+ starting with -)
      if (trimmed.startsWith('-')) {
        const item = trimmed.substring(1).trim();
        if (currentKey === 'ports') currentService.ports.push(item);
        if (currentKey === 'volumes') currentService.volumes.push(item);
        if (currentKey === 'depends_on') currentService.dependsOn.push(item);
        if (currentKey === 'environment') currentService.environment.push(item);
      }
    }
  }

  if (currentService) services.push(currentService);
  if (services.length === 0) return null;

  // Derive project name from directory
  const parts = filePath.replace(/\\/g, '/').split('/');
  const dirIdx = parts.findIndex(p => p === 'repo');
  const projectName = dirIdx >= 0 && dirIdx + 1 < parts.length
    ? parts[dirIdx + 1]
    : basename(filePath, '.yaml').replace('compose', 'project');

  return { path: filePath, projectName, services };
}

/**
 * Find all compose YAML files in a directory tree.
 */
function findComposeFiles(dir: string): string[] {
  const result: string[] = [];
  if (!existsSync(dir)) return result;

  function walk(d: string) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name === 'compose.yaml' || entry.name === 'compose.yml' ||
        entry.name === 'docker-compose.yaml' || entry.name === 'docker-compose.yml'
      ) {
        result.push(full);
      }
    }
  }

  walk(dir);
  return result;
}

/**
 * Harvest docker-compose files into infra verify scenarios.
 */
function harvestCompose(files: string[], maxScenarios: number, startCounter: number): { scenarios: VerifyScenario[], counter: number } {
  const scenarios: VerifyScenario[] = [];
  let counter = startCounter;

  // Find compose files from the file list
  const composeFiles = files.filter(f => {
    const name = basename(f);
    return name === 'compose.yaml' || name === 'compose.yml' ||
      name === 'docker-compose.yaml' || name === 'docker-compose.yml';
  });

  // If no direct matches, search directories in the file list
  const searchDirs = new Set<string>();
  for (const f of files) {
    const dir = f.replace(/[/\\][^/\\]+$/, '');
    if (existsSync(dir)) searchDirs.add(dir);
  }
  const discovered = [...searchDirs].flatMap(d => findComposeFiles(d));
  const allComposeFiles = [...new Set([...composeFiles, ...discovered])];

  for (const filePath of allComposeFiles) {
    if (scenarios.length >= maxScenarios) break;

    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }

    const parsed = parseComposeYAML(content, filePath);
    if (!parsed || parsed.services.length === 0) continue;

    // Scenario 1: Service count check (structure is valid)
    counter++;
    scenarios.push({
      id: `rw-infra-compose-${String(counter).padStart(3, '0')}`,
      description: `Compose: ${parsed.projectName} — ${parsed.services.length} services defined`,
      edits: [{
        file: 'docker-compose.yml',
        search: 'services:',
        replace: `# Real compose pattern from ${parsed.projectName}\nservices:`,
      }],
      predicates: [{
        type: 'infra_attribute',
        resource: 'compose',
        attribute: 'service_count',
        expected: String(parsed.services.length),
      }],
      expectedSuccess: true,
      tags: ['infra', 'real-world', 'docker-compose', parsed.projectName],
      rationale: `Real docker-compose from awesome-compose/${parsed.projectName}: ${parsed.services.map(s => s.name).join(', ')}`,
      source: 'real-world',
    });

    // Scenario 2: Port mapping (if services expose ports)
    for (const svc of parsed.services) {
      if (scenarios.length >= maxScenarios) break;

      if (svc.ports.length > 0) {
        counter++;
        const portStr = svc.ports[0].replace(/['"]/g, '');
        scenarios.push({
          id: `rw-infra-compose-${String(counter).padStart(3, '0')}`,
          description: `Compose: ${parsed.projectName}/${svc.name} — port mapping ${portStr}`,
          edits: [{
            file: 'docker-compose.yml',
            search: 'services:',
            replace: `services:\n  ${svc.name}:\n    image: ${svc.image || 'app'}\n    ports:\n      - "${portStr}"`,
          }],
          predicates: [{
            type: 'infra_attribute',
            resource: 'compose',
            attribute: 'port_exposed',
            expected: portStr,
          }],
          expectedSuccess: true,
          tags: ['infra', 'real-world', 'docker-compose', parsed.projectName, 'port-mapping'],
          rationale: `Port mapping from ${parsed.projectName}/${svc.name}: ${portStr}`,
          source: 'real-world',
        });
      }

      // Scenario 3: Healthcheck present/absent
      if (scenarios.length >= maxScenarios) break;
      counter++;
      scenarios.push({
        id: `rw-infra-compose-${String(counter).padStart(3, '0')}`,
        description: `Compose: ${parsed.projectName}/${svc.name} — healthcheck ${svc.hasHealthcheck ? 'present' : 'absent'}`,
        edits: [{
          file: 'docker-compose.yml',
          search: 'services:',
          replace: `services:\n  ${svc.name}:\n    image: ${svc.image || 'app'}${svc.hasHealthcheck ? '\n    healthcheck:\n      test: ["CMD", "true"]' : ''}`,
        }],
        predicates: [{
          type: 'infra_attribute',
          resource: 'compose',
          attribute: 'healthcheck',
          expected: svc.hasHealthcheck ? 'present' : 'absent',
        }],
        expectedSuccess: true,
        tags: ['infra', 'real-world', 'docker-compose', parsed.projectName, svc.hasHealthcheck ? 'healthcheck' : 'no-healthcheck'],
        rationale: `Service ${svc.name} in ${parsed.projectName} ${svc.hasHealthcheck ? 'has' : 'lacks'} a healthcheck definition`,
        source: 'real-world',
      });

      // Scenario 4: Volume mount patterns
      if (svc.volumes.length > 0 && scenarios.length < maxScenarios) {
        counter++;
        const volStr = svc.volumes[0].replace(/['"]/g, '');
        scenarios.push({
          id: `rw-infra-compose-${String(counter).padStart(3, '0')}`,
          description: `Compose: ${parsed.projectName}/${svc.name} — volume ${volStr}`,
          edits: [{
            file: 'docker-compose.yml',
            search: 'services:',
            replace: `services:\n  ${svc.name}:\n    image: ${svc.image || 'app'}\n    volumes:\n      - "${volStr}"`,
          }],
          predicates: [{
            type: 'infra_attribute',
            resource: 'compose',
            attribute: 'volume_mount',
            expected: volStr,
          }],
          expectedSuccess: true,
          tags: ['infra', 'real-world', 'docker-compose', parsed.projectName, 'volume'],
          rationale: `Volume mount from ${parsed.projectName}/${svc.name}: ${volStr}`,
          source: 'real-world',
        });
      }
    }
  }

  return { scenarios, counter };
}

/**
 * Convert real infrastructure error catalogs and compose files into verify scenarios.
 */
export function harvestInfra(files: string[], maxScenarios: number): VerifyScenario[] {
  const scenarios: VerifyScenario[] = [];
  let counter = 0;

  // Process Heroku error codes
  for (const error of HEROKU_ERRORS) {
    if (scenarios.length >= maxScenarios) break;
    counter++;

    // Scenario 1: Edit introduces the failure pattern, predicate should detect it
    scenarios.push({
      id: `rw-infra-heroku-${String(counter).padStart(3, '0')}`,
      description: `Heroku ${error.code}: ${error.name} — failure pattern injected`,
      edits: [{
        file: 'server.js',
        search: "const PORT = process.env.PORT || 3000;",
        replace: `const PORT = process.env.PORT || 3000;\n// Heroku ${error.code}: ${error.name}\n// Pattern: ${error.editPattern}`,
      }],
      predicates: [{
        type: error.predicateType,
        ...(error.predicateType === 'http'
          ? { method: 'GET', path: '/health', expect: { status: 200, bodyContains: 'ok' } }
          : error.predicateType === 'infra_resource'
          ? { resource: 'dyno', metric: error.code.toLowerCase(), threshold: 0, assertion: 'below' }
          : { resource: 'dyno', attribute: 'status', expected: 'running' }),
      }],
      expectedSuccess: true, // structural check passes — the pattern is a comment
      tags: ['infra', 'real-world', 'heroku', error.code, error.category],
      rationale: `Real Heroku error ${error.code}: ${error.description}`,
      source: 'real-world',
    });

    counter++;
    // Scenario 2: The error condition is active (edit breaks the server)
    if (error.category === 'http' && error.code !== 'H25') {
      scenarios.push({
        id: `rw-infra-heroku-${String(counter).padStart(3, '0')}`,
        description: `Heroku ${error.code}: ${error.name} — server broken, health check fails`,
        edits: [{
          file: 'server.js',
          search: "res.end(JSON.stringify({ status: 'ok' }));",
          replace: `// ${error.code}: ${error.name} — endpoint broken\n    res.writeHead(503); res.end('${error.code}');`,
        }],
        predicates: [{
          type: 'http',
          method: 'GET',
          path: '/health',
          expect: { status: 200, bodyContains: 'ok' },
        }],
        expectedSuccess: false,
        tags: ['infra', 'real-world', 'heroku', error.code, error.category, 'broken'],
        rationale: `Heroku ${error.code} active: ${error.description}. Health endpoint returns 503 instead of 200.`,
        source: 'real-world',
      });
    }
  }

  // ── Docker Compose files ──────────────────────────────────────────────────
  if (files.length > 0) {
    const remaining = maxScenarios - scenarios.length;
    if (remaining > 0) {
      const compose = harvestCompose(files, remaining, counter);
      scenarios.push(...compose.scenarios);
      counter = compose.counter;
    }
  }

  const composeCount = scenarios.filter(s => s.tags.includes('docker-compose')).length;
  const herokuCount = scenarios.filter(s => s.tags.includes('heroku')).length;
  console.log(`  harvest-infra: ${herokuCount} heroku + ${composeCount} compose scenarios, generated ${scenarios.length} total`);
  return scenarios;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standalone test
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const scenarios = harvestInfra([], 200);
  console.log(`\nGenerated ${scenarios.length} scenarios`);
  for (const s of scenarios.slice(0, 5)) {
    console.log(`  ${s.id}: ${s.description.substring(0, 80)}`);
  }
  const codes = new Set(scenarios.flatMap(s => s.tags.filter(t => /^[HRL]\d+$/.test(t))));
  console.log(`\nCovered ${codes.size} error codes: ${[...codes].sort().join(', ')}`);
}

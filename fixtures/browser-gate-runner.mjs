/**
 * Browser Gate Runner — Fixed, Auditable Predicate Evaluator
 *
 * Baked into the sovereign/browser-gate Docker image at build time.
 * Reads predicates from /data/browser-gate-input.json and writes
 * results to /data/browser-gate-results.json.
 *
 * Runner + data separation: zero injection risk. The script lives in
 * the image (/app/), data is volume-mounted at /data/. No code
 * generation, no selector interpolation.
 *
 * Invocation:
 *   docker run --rm --network={net} -v {dir}:/data sovereign/browser-gate:v1.49.0 node /app/browser-gate-runner.mjs
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

// Budget caps from plan
const PER_PATH_TIMEOUT = 10_000;  // 10s per path
const TOTAL_TIMEOUT = 30_000;     // 30s total
const DOM_SETTLE_MS = 300;        // 300ms no mutations = settled
const DOM_SETTLE_CAP = 3_000;     // 3s hard cap for settle

async function main() {
  const totalStart = Date.now();
  const results = [];
  let browser;

  try {
    // Read input
    const input = JSON.parse(readFileSync('/data/browser-gate-input.json', 'utf-8'));
    const { baseUrl, paths } = input;

    if (!baseUrl || !paths || !Array.isArray(paths)) {
      throw new Error('Invalid input: missing baseUrl or paths');
    }

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
    });

    // Process each path group
    for (const pathGroup of paths) {
      const { path: urlPath, predicates } = pathGroup;
      if (!predicates || predicates.length === 0) continue;

      // Check total budget
      if (Date.now() - totalStart > TOTAL_TIMEOUT) {
        for (const p of predicates) {
          results.push({
            id: p.id,
            passed: false,
            actual: null,
            error: 'Total timeout exceeded (30s)',
          });
        }
        continue;
      }

      const page = await context.newPage();

      try {
        // Inject animation-disabling stylesheet BEFORE navigation
        await page.addInitScript(() => {
          const style = document.createElement('style');
          style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; animation-duration: 0s !important; transition-duration: 0s !important; }';
          document.addEventListener('DOMContentLoaded', () => {
            document.head.appendChild(style);
          });
          // Also inject immediately for already-loaded documents
          if (document.head) document.head.appendChild(style);
        });

        // Navigate to path
        const fullUrl = urlPath === '/'
          ? baseUrl
          : `${baseUrl}${urlPath.startsWith('/') ? urlPath : '/' + urlPath}`;

        await page.goto(fullUrl, {
          timeout: PER_PATH_TIMEOUT,
          waitUntil: 'domcontentloaded',
        });

        // Wait for DOM to settle (no mutations for 300ms, hard cap 3s)
        await page.evaluate(({ settleMs, settleCap }) => {
          return new Promise((resolve) => {
            let timer = null;
            let settled = false;
            const hardCap = setTimeout(() => {
              if (!settled) {
                settled = true;
                if (timer) clearTimeout(timer);
                observer.disconnect();
                resolve(undefined);
              }
            }, settleCap);

            const resetTimer = () => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                settled = true;
                clearTimeout(hardCap);
                observer.disconnect();
                resolve(undefined);
              }, settleMs);
            };

            const observer = new MutationObserver(() => {
              resetTimer();
            });

            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
            });

            // Start initial timer
            resetTimer();
          });
        }, { settleMs: DOM_SETTLE_MS, settleCap: DOM_SETTLE_CAP });

        // Evaluate each predicate
        for (const pred of predicates) {
          try {
            const result = await evaluatePredicate(page, pred);
            results.push(result);
          } catch (err) {
            results.push({
              id: pred.id,
              passed: false,
              actual: null,
              error: `Evaluation error: ${err.message}`,
            });
          }
        }
      } catch (err) {
        // Page-level error — mark all predicates for this path as failed
        for (const pred of predicates) {
          results.push({
            id: pred.id,
            passed: false,
            actual: null,
            error: `Page error (${urlPath}): ${err.message}`,
          });
        }
      } finally {
        await page.close();
      }
    }

    await browser.close();
    browser = null;

    // Write results
    writeFileSync('/data/browser-gate-results.json', JSON.stringify({
      results,
      duration: Date.now() - totalStart,
      timestamp: Date.now(),
    }, null, 2));

    process.exit(0);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});

    // Write error result
    writeFileSync('/data/browser-gate-results.json', JSON.stringify({
      results,
      error: err.message,
      duration: Date.now() - totalStart,
      timestamp: Date.now(),
    }, null, 2));

    console.error(`Browser gate runner error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Evaluate a single predicate against the page.
 * Returns { id, passed, actual, error? }
 */
async function evaluatePredicate(page, pred) {
  const { id, type, selector, property, value, operator } = pred;

  if (type === 'css') {
    // CSS computed style check
    const result = await page.evaluate(({ sel, prop }) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const computed = getComputedStyle(el);
      const val = computed.getPropertyValue(prop);
      return { found: true, value: val };
    }, { sel: selector, prop: property });

    if (!result.found) {
      return {
        id,
        passed: false,
        actual: null,
        error: `Element "${selector}" not found`,
      };
    }

    return {
      id,
      passed: undefined, // Let harness compare with normalizeColor
      actual: result.value,
      expected: value,
      property,
      selector,
    };
  }

  if (type === 'html') {
    if (operator === 'exists' || operator === 'not_exists') {
      // Element existence check
      const exists = await page.evaluate((sel) => {
        return document.querySelector(sel) !== null;
      }, selector);

      const shouldExist = operator === 'exists';
      return {
        id,
        passed: exists === shouldExist,
        actual: exists ? 'exists' : 'not found',
        expected: shouldExist ? 'exists' : 'not exists',
        selector,
      };
    }

    if (operator === '==') {
      // Text content check
      const result = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        return { found: true, text: (el.textContent || '').trim() };
      }, selector);

      if (!result.found) {
        return {
          id,
          passed: false,
          actual: null,
          error: `Element "${selector}" not found`,
          expected: value,
          selector,
        };
      }

      return {
        id,
        passed: result.text === value,
        actual: result.text,
        expected: value,
        selector,
      };
    }
  }

  if (type === 'visibility') {
    // Visibility check: offsetHeight > 0 && opacity !== '0'
    const result = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const style = getComputedStyle(el);
      const visible = el.offsetHeight > 0 && style.opacity !== '0' && style.display !== 'none';
      return { found: true, visible };
    }, selector);

    if (!result.found) {
      return {
        id,
        passed: false,
        actual: null,
        error: `Element "${selector}" not found`,
        selector,
      };
    }

    return {
      id,
      passed: result.visible,
      actual: result.visible ? 'visible' : 'hidden',
      expected: 'visible',
      selector,
    };
  }

  // Unknown type — pass-through to harness
  return {
    id,
    passed: false,
    actual: null,
    error: `Unknown predicate type: ${type}`,
  };
}

main();

import { describe, test, expect } from 'bun:test';
import { groundInReality, validateAgainstGrounding } from '../../src/gates/grounding.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeTempDir(): string {
  const dir = join(tmpdir(), `verify-ground-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('groundInReality', () => {
  test('extracts routes from Express-style code', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'server.js'), `
      const app = express();
      app.get('/api/users', (req, res) => {});
      app.post('/api/items', (req, res) => {});
    `);

    const ctx = groundInReality(dir);
    expect(ctx.routes).toContain('/api/users');
    expect(ctx.routes).toContain('/api/items');
    rmSync(dir, { recursive: true, force: true });
  });

  test('extracts routes from vanilla HTTP server', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'server.js'), `
      if (url.pathname === '/health') { return ok; }
      if (req.url === '/api/data') { return data; }
    `);

    const ctx = groundInReality(dir);
    expect(ctx.routes).toContain('/health');
    expect(ctx.routes).toContain('/api/data');
    rmSync(dir, { recursive: true, force: true });
  });

  test('extracts CSS from style blocks', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), `
      <style>
        h1 { color: red; font-size: 2rem; }
        .nav { background: #333; }
      </style>
    `);

    const ctx = groundInReality(dir);
    const rootCSS = ctx.routeCSSMap.get('/');
    expect(rootCSS).toBeTruthy();
    expect(rootCSS!.has('h1')).toBe(true);
    expect(rootCSS!.get('h1')!.color).toBe('red');
    expect(rootCSS!.get('.nav')!.background).toBe('#333');
    rmSync(dir, { recursive: true, force: true });
  });

  test('extracts HTML elements', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'page.html'), `
      <h1>Welcome</h1>
      <a href="/about" class="nav">About</a>
      <button type="submit">Save</button>
    `);

    const ctx = groundInReality(dir);
    const rootHTML = ctx.htmlElements.get('/');
    expect(rootHTML).toBeTruthy();

    const h1 = rootHTML!.find(e => e.tag === 'h1');
    expect(h1).toBeTruthy();
    expect(h1!.text).toBe('Welcome');

    const button = rootHTML!.find(e => e.tag === 'button');
    expect(button).toBeTruthy();
    expect(button!.text).toBe('Save');
    rmSync(dir, { recursive: true, force: true });
  });

  test('skips node_modules and .git', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'app.get("/hidden", () => {})');
    writeFileSync(join(dir, 'server.js'), 'app.get("/visible", () => {})');

    const ctx = groundInReality(dir);
    expect(ctx.routes).toContain('/visible');
    expect(ctx.routes).not.toContain('/hidden');
    rmSync(dir, { recursive: true, force: true });
  });

  test('handles empty directory', () => {
    const dir = makeTempDir();
    const ctx = groundInReality(dir);
    expect(ctx.routes).toHaveLength(0);
    expect(ctx.routeCSSMap.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('validateAgainstGrounding', () => {
  test('marks CSS predicates with non-existent selectors', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'index.html'), `
      <style>
        h1 { color: red; }
      </style>
    `);

    const ctx = groundInReality(dir);

    const predicates = [
      { type: 'css', selector: 'h1', property: 'color' },        // exists
      { type: 'css', selector: '.nonexistent', property: 'color' }, // fabricated
    ];

    const result = validateAgainstGrounding(predicates, ctx);
    expect(result[0]).not.toHaveProperty('groundingMiss');
    expect((result[1] as any).groundingMiss).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('does not mark HTML predicates as misses', () => {
    const dir = makeTempDir();
    const ctx = groundInReality(dir);

    const predicates = [
      { type: 'html', selector: '.new-element' },
    ];

    const result = validateAgainstGrounding(predicates, ctx);
    expect(result[0]).not.toHaveProperty('groundingMiss');
    rmSync(dir, { recursive: true, force: true });
  });
});

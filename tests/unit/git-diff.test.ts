import { describe, test, expect } from 'bun:test';
import { parseDiff } from '../../src/parsers/git-diff.js';

describe('parseDiff', () => {
  test('parses simple modification', () => {
    const diff = `diff --git a/index.html b/index.html
--- a/index.html
+++ b/index.html
@@ -1,3 +1,3 @@
 <h1>Hello</h1>
-<p>World</p>
+<p>Universe</p>
 <footer>end</footer>`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe('index.html');
    expect(edits[0].search).toContain('World');
    expect(edits[0].replace).toContain('Universe');
  });

  test('parses new file', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe('new.txt');
    expect(edits[0].search).toBe('');
    expect(edits[0].replace).toContain('line one');
    expect(edits[0].replace).toContain('line two');
  });

  test('parses deleted file', () => {
    const diff = `diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-goodbye
-world`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe('old.txt');
    expect(edits[0].search).toContain('goodbye');
    expect(edits[0].replace).toBe('');
  });

  test('parses multiple files', () => {
    const diff = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1 +1 @@
-const x = 1;
+const x = 42;
diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-const y = 2;
+const y = 99;`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(2);
    expect(edits[0].file).toBe('a.js');
    expect(edits[1].file).toBe('b.js');
  });

  test('handles multiple hunks in one file', () => {
    const diff = `diff --git a/server.js b/server.js
--- a/server.js
+++ b/server.js
@@ -1,3 +1,3 @@
 const http = require('http');
-const PORT = 3000;
+const PORT = 8080;
 const server = http.createServer();
@@ -10,3 +10,3 @@
 server.listen(PORT, () => {
-  console.log('Running on 3000');
+  console.log('Running on 8080');
 });`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(2);
    expect(edits[0].search).toContain('3000');
    expect(edits[0].replace).toContain('8080');
    expect(edits[1].search).toContain('Running on 3000');
    expect(edits[1].replace).toContain('Running on 8080');
  });

  test('skips binary files', () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(0);
  });

  test('handles empty diff', () => {
    expect(parseDiff('')).toHaveLength(0);
  });

  test('preserves context lines in search/replace', () => {
    const diff = `diff --git a/style.css b/style.css
--- a/style.css
+++ b/style.css
@@ -1,5 +1,5 @@
 body {
   margin: 0;
-  color: black;
+  color: blue;
   padding: 0;
 }`;

    const edits = parseDiff(diff);
    expect(edits).toHaveLength(1);
    // Context lines should be in both
    expect(edits[0].search).toContain('margin: 0;');
    expect(edits[0].replace).toContain('margin: 0;');
    // Old line only in search
    expect(edits[0].search).toContain('color: black;');
    expect(edits[0].replace).not.toContain('color: black;');
    // New line only in replace
    expect(edits[0].replace).toContain('color: blue;');
    expect(edits[0].search).not.toContain('color: blue;');
  });
});

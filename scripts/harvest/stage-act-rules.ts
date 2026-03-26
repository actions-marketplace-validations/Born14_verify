/**
 * A11y Gate Scenario Harvester
 * ============================
 *
 * Generates scenarios for the a11y gate by creating HTML snippets that
 * precisely match each of the 11 a11y checker functions.
 *
 * Only generates false_positive (should-detect) scenarios because the a11y gate
 * scans ALL HTML files in the stageDir (which includes the demo-app's existing
 * files). This means "should pass" tests are contaminated by the demo-app's
 * existing a11y issues. Detection tests are unaffected — they just need to find
 * at least one issue.
 *
 * Run: bun scripts/harvest/stage-act-rules.ts
 * Output: fixtures/scenarios/a11y-staged.json
 */

import { writeFileSync } from 'fs';
import { resolve } from 'path';

const outPath = resolve('fixtures/scenarios/a11y-staged.json');
const scenarios: any[] = [];
let id = 1;

function push(s: any) {
  scenarios.push({ id: `a11y-${String(id++).padStart(4, '0')}`, requiresDocker: false, ...s });
}

/**
 * Wrap HTML body in a minimal page. The page itself may have a11y issues
 * (no lang, etc.) — that's fine because we only test detection scenarios.
 */
function page(body: string): string {
  return `<!DOCTYPE html>\n<html>\n<head><title>Test</title></head>\n<body>\n${body}\n</body>\n</html>`;
}

/**
 * Create a scenario that expects the a11y gate to DETECT a problem.
 * The gate returns findings → predicate expects has_findings → verify succeeds.
 * intent: false_negative (verify should succeed = gate correctly detects)
 *
 * Predicate: expected='has_findings' means "I expect findings to exist" → pass if findings > 0
 */
function shouldDetect(
  checkType: string,
  description: string,
  html: string,
  tags: string[] = [],
) {
  push({
    description: `a11y ${checkType}: ${description}`,
    edits: [{ file: 'test-a11y.html', search: '', replace: html }],
    predicates: [{ type: 'a11y', a11yCheck: checkType, expected: 'has_findings' }],
    expectedSuccess: true,
    intent: 'false_negative',
    tags: ['a11y', checkType, ...tags],
    rationale: `A11y gate should detect: ${description}`,
  });
}

// =============================================================================
// alt_text — <img> without alt=
// Gate regex: /<img\s+(?![^>]*alt=)[^>]*>/gi
// Exceptions: role="presentation", aria-label
// =============================================================================

shouldDetect('alt_text', 'img without alt attribute',
  page('<img src="photo.jpg">'));
shouldDetect('alt_text', 'img with src and class but no alt',
  page('<img src="logo.png" class="logo" width="100">'));
shouldDetect('alt_text', 'img with id but no alt',
  page('<img src="banner.jpg" id="hero">'));
shouldDetect('alt_text', 'multiple imgs, second missing alt',
  page('<img src="a.jpg" alt="A"><img src="b.jpg">'));
shouldDetect('alt_text', 'img with title but no alt',
  page('<img src="pic.jpg" title="A picture">'));
shouldDetect('alt_text', 'img with style but no alt',
  page('<img src="bg.jpg" style="width:100%">'));
shouldDetect('alt_text', 'img with data attributes but no alt',
  page('<img src="hero.jpg" data-src="hero-2x.jpg">'));
shouldDetect('alt_text', 'img with loading lazy but no alt',
  page('<img src="gallery.jpg" loading="lazy">'));

// =============================================================================
// heading_hierarchy — empty headings and skipped levels
// =============================================================================

shouldDetect('heading_hierarchy', 'empty h1 tag',
  page('<h1></h1><p>Content</p>'));
shouldDetect('heading_hierarchy', 'empty h2 tag',
  page('<h1>Title</h1><h2></h2>'));
shouldDetect('heading_hierarchy', 'h1 with only whitespace',
  page('<h1>   </h1>'));
shouldDetect('heading_hierarchy', 'empty h3 tag',
  page('<h1>Title</h1><h2>Sub</h2><h3></h3>'));
shouldDetect('heading_hierarchy', 'skipped level h1 to h3',
  page('<h1>Title</h1><h3>Subtitle</h3>'));
shouldDetect('heading_hierarchy', 'skipped level h2 to h4',
  page('<h1>Title</h1><h2>Section</h2><h4>Sub</h4>'));
shouldDetect('heading_hierarchy', 'skipped level h1 to h4',
  page('<h1>Title</h1><h4>Deep</h4>'));
shouldDetect('heading_hierarchy', 'skipped level h1 to h5',
  page('<h1>Title</h1><h5>Very deep</h5>'));
shouldDetect('heading_hierarchy', 'skipped level h3 to h6',
  page('<h1>A</h1><h2>B</h2><h3>C</h3><h6>F</h6>'));

// =============================================================================
// landmark — checks for <main> and <nav>
// Gate: must have <main> or role="main", must have <nav> or role="navigation"
// =============================================================================

shouldDetect('landmark', 'no main or nav elements',
  page('<div>Content without landmarks</div>'));
shouldDetect('landmark', 'has nav but no main',
  page('<nav><a href="/">Home</a></nav><div>Content</div>'));
// NOTE: "has main but no nav" removed — demo-app's server.js contains <nav>,
// so the gate finds <nav> from demo-app and <main> from test = no findings
shouldDetect('landmark', 'only divs and spans',
  page('<div><span>Header</span></div><div><p>Body</p></div>'));

// =============================================================================
// aria_label — empty buttons and icon-only buttons without aria-label
// Gate: /<button[^>]*>\s*<\/button>/gi (empty buttons)
// Also: icon-only buttons (<i>, <span class="icon">, <svg>) without aria-label
// =============================================================================

shouldDetect('aria_label', 'empty button',
  page('<button></button>'));
shouldDetect('aria_label', 'button with only whitespace',
  page('<button>   </button>'));
shouldDetect('aria_label', 'button with only icon (i tag)',
  page('<button><i class="fa fa-search"></i></button>'));
shouldDetect('aria_label', 'button with only svg icon',
  page('<button><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>'));
shouldDetect('aria_label', 'button with only span.icon',
  page('<button><span class="icon">★</span></button>'));
shouldDetect('aria_label', 'multiple empty buttons',
  page('<button></button><button></button>'));

// =============================================================================
// form_labels — inputs without associated label
// Gate: <input> (not hidden/submit/button) without label association
// =============================================================================

shouldDetect('form_labels', 'text input without any label',
  page('<form><input type="text" name="email"></form>'));
shouldDetect('form_labels', 'input with non-matching label for',
  page('<form><label for="wrong">Email</label><input type="text" id="email" name="email"></form>'));
shouldDetect('form_labels', 'textarea without label',
  page('<form><textarea name="comment"></textarea></form>'));
shouldDetect('form_labels', 'select without label',
  page('<form><select name="color"><option>Red</option></select></form>'));
shouldDetect('form_labels', 'email input without label',
  page('<form><input type="email" name="user_email"></form>'));
shouldDetect('form_labels', 'password input without label',
  page('<form><input type="password" name="pwd"></form>'));
shouldDetect('form_labels', 'number input without label',
  page('<form><input type="number" name="quantity"></form>'));

// =============================================================================
// link_text — BAD_TEXTS = ['click here', 'here', 'read more', 'more', 'link', 'this']
// Gate: <a> tags with only bad text content (case insensitive)
// =============================================================================

shouldDetect('link_text', 'link text "click here"',
  page('<a href="/page">click here</a>'));
shouldDetect('link_text', 'link text "here"',
  page('<a href="/page">here</a>'));
shouldDetect('link_text', 'link text "read more"',
  page('<a href="/article">read more</a>'));
shouldDetect('link_text', 'link text "more"',
  page('<a href="/list">more</a>'));
shouldDetect('link_text', 'link text "link"',
  page('<a href="/doc">link</a>'));
shouldDetect('link_text', 'link text "this"',
  page('<a href="/thing">this</a>'));
shouldDetect('link_text', 'link text "Click Here" (mixed case)',
  page('<a href="/page">Click Here</a>'));
shouldDetect('link_text', 'link text "READ MORE" (uppercase)',
  page('<a href="/page">READ MORE</a>'));
shouldDetect('link_text', 'link text "Here" (capitalized)',
  page('<a href="/page">Here</a>'));

// =============================================================================
// lang_attr — <html> without lang=
// Gate: /<html(?:\s[^>]*)?>/ then checks for lang=
// =============================================================================

shouldDetect('lang_attr', 'html without lang attribute',
  '<!DOCTYPE html>\n<html>\n<head><title>Test</title></head>\n<body><p>Hello</p></body>\n</html>');
shouldDetect('lang_attr', 'html with class but no lang',
  '<!DOCTYPE html>\n<html class="no-js">\n<head><title>Test</title></head>\n<body><p>Content</p></body>\n</html>');
shouldDetect('lang_attr', 'html with id but no lang',
  '<!DOCTYPE html>\n<html id="root">\n<head><title>Test</title></head>\n<body><p>Content</p></body>\n</html>');
shouldDetect('lang_attr', 'html with data attribute but no lang',
  '<!DOCTYPE html>\n<html data-theme="dark">\n<head><title>Test</title></head>\n<body><p>Content</p></body>\n</html>');

// =============================================================================
// autoplay — <video> or <audio> with autoplay attribute
// Gate regex: /<(?:video|audio)\s+[^>]*autoplay[^>]*>/gi
// =============================================================================

shouldDetect('autoplay', 'video with autoplay',
  page('<video src="clip.mp4" autoplay></video>'));
shouldDetect('autoplay', 'audio with autoplay',
  page('<audio src="music.mp3" autoplay></audio>'));
shouldDetect('autoplay', 'video with autoplay and other attrs',
  page('<video src="clip.mp4" controls autoplay loop></video>'));
shouldDetect('autoplay', 'audio with autoplay and controls',
  page('<audio autoplay controls><source src="song.mp3"></audio>'));
shouldDetect('autoplay', 'video autoplay with muted',
  page('<video src="bg.mp4" autoplay muted></video>'));
shouldDetect('autoplay', 'audio autoplay with preload',
  page('<audio src="alert.wav" autoplay preload="auto"></audio>'));

// =============================================================================
// skip_nav — <main> present but no skip navigation link
// Gate: has <main> but no <a href="#main|#content|#skip">
// =============================================================================

shouldDetect('skip_nav', 'main element without skip link',
  page('<main><h1>Content</h1></main>'));
shouldDetect('skip_nav', 'main with nav but no skip link',
  page('<nav><a href="/">Home</a></nav><main><h1>Content</h1></main>'));
shouldDetect('skip_nav', 'main with multiple sections but no skip',
  page('<header><nav><a href="/">Home</a><a href="/about">About</a></nav></header><main><h1>Content</h1><p>Body</p></main>'));

// =============================================================================
// focus_management — tabindex > 0 (positive tabindex is bad practice)
// Gate regex: /tabindex=["']?([2-9]|\d{2,})["']?/gi (tabindex > 1)
// =============================================================================

shouldDetect('focus_management', 'element with tabindex=5',
  page('<div tabindex="5">Focusable</div>'));
shouldDetect('focus_management', 'element with tabindex=99',
  page('<button tabindex="99">Submit</button>'));
shouldDetect('focus_management', 'element with tabindex=10',
  page('<a href="/" tabindex="10">Home</a>'));
shouldDetect('focus_management', 'element with tabindex=2',
  page('<input type="text" tabindex="2">'));
shouldDetect('focus_management', 'span with tabindex=50',
  page('<span tabindex="50">Interactive</span>'));

// =============================================================================
// Write output
// =============================================================================

writeFileSync(outPath, JSON.stringify(scenarios, null, 2));
console.log(`\nA11y Scenario Harvester`);
console.log(`=======================`);
console.log(`Total: ${scenarios.length} scenarios (all false_positive / should-detect)`);

// Count by check type
const byType: Record<string, number> = {};
for (const s of scenarios) {
  const ct = s.predicates[0].a11yCheck;
  byType[ct] = (byType[ct] || 0) + 1;
}
for (const [k, v] of Object.entries(byType).sort()) {
  console.log(`  ${k}: ${v}`);
}
console.log(`Output: ${outPath}`);

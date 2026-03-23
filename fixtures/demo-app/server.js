const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/api/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]));
    return;
  }

  if (req.url === '/about') {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>About - Demo App</title>
  <style>
    body { font-family: Georgia, serif; margin: 3rem; background: #f9f9f9; color: #222; }
    h2 { color: #34495e; font-size: 1.5rem; }
    .hero { background: #3498db; color: white; padding: 2rem; border-radius: 8px; }
    .hero .hero-title { color: white; font-size: 2.5rem; }
    .card { background: white; padding: 1.5rem; margin: 1rem 0; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card .card-title { font-weight: bold; font-size: 1.2rem; }
    .badge { display: inline-block; background: #e74c3c; color: white; padding: 0.25rem 0.75rem; border-radius: 12px; font-size: 0.8rem; }
    a.nav-link { color: #0066cc; margin-right: 1rem; }
    .team-list { list-style: decimal; padding-left: 2rem; }
    .team-list li { padding: 0.3rem 0; }
    .team-list li span.role { color: #7f8c8d; font-style: italic; }
    footer { margin-top: 2rem; color: #aaa; font-size: 0.85rem; }
    .hidden { display: none; }
    #details { border: 1px solid #ddd; padding: 1rem; }
    img.logo { width: 100px; height: 100px; }
    input.search { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; width: 200px; }
    button.primary { background: #3498db; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; }
    table.data-table { width: 100%; border-collapse: collapse; }
    table.data-table th { background: #ecf0f1; padding: 0.5rem; text-align: left; }
    table.data-table td { padding: 0.5rem; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <nav>
    <a class="nav-link" href="/">Home</a>
    <a class="nav-link" href="/about">About</a>
  </nav>
  <div class="hero">
    <span class="hero-title">About This App</span>
    <p>Built with <strong>Node.js</strong> for testing verification pipelines.</p>
  </div>
  <div class="card">
    <span class="card-title">Mission</span>
    <p>Provide a minimal but structurally rich fixture for testing CSS, HTML, and content predicates.</p>
  </div>
  <div class="card">
    <span class="card-title">Version</span>
    <span class="badge">v1.0</span>
  </div>
  <h2>Team</h2>
  <ol class="team-list">
    <li>Alice <span class="role">— Lead</span></li>
    <li>Bob <span class="role">— Backend</span></li>
    <li>Carol <span class="role">— Frontend</span></li>
  </ol>
  <h2>Search</h2>
  <input class="search" type="text" placeholder="Search..." />
  <button class="primary">Go</button>
  <h2>Data</h2>
  <table class="data-table">
    <thead><tr><th>Name</th><th>Role</th></tr></thead>
    <tbody>
      <tr><td>Alice</td><td>Lead</td></tr>
      <tr><td>Bob</td><td>Backend</td></tr>
    </tbody>
  </table>
  <div id="details">
    <p>Additional details appear here.</p>
  </div>
  <img class="logo" src="/logo.png" alt="Demo Logo" />
  <div class="hidden">This content is hidden via CSS.</div>
  <footer>About page footer</footer>
</body>
</html>`);
  return;
  }

  if (req.url === '/form') {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Form - Demo App</title>
  <style>
    body { font-family: monospace; margin: 1.5rem; }
    label { display: block; margin: 0.5rem 0 0.25rem; font-weight: bold; }
    input[type="text"], input[type="email"], textarea, select {
      width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;
    }
    .form-group { margin-bottom: 1rem; }
    .required::after { content: " *"; color: red; }
    button[type="submit"] { background: #27ae60; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; cursor: pointer; font-size: 1rem; }
    .error { color: #e74c3c; font-size: 0.85rem; display: none; }
    fieldset { border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; }
    legend { font-weight: bold; padding: 0 0.5rem; }
  </style>
</head>
<body>
  <h1>Contact Form</h1>
  <form id="contact-form" action="/api/echo" method="POST">
    <div class="form-group">
      <label class="required" for="name">Name</label>
      <input type="text" id="name" name="name" required placeholder="Your name" />
      <span class="error" id="name-error">Name is required</span>
    </div>
    <div class="form-group">
      <label class="required" for="email">Email</label>
      <input type="email" id="email" name="email" required placeholder="you@example.com" />
    </div>
    <div class="form-group">
      <label for="subject">Subject</label>
      <select id="subject" name="subject">
        <option value="general">General Inquiry</option>
        <option value="support">Support</option>
        <option value="feedback">Feedback</option>
      </select>
    </div>
    <fieldset>
      <legend>Message Details</legend>
      <div class="form-group">
        <label for="message">Message</label>
        <textarea id="message" name="message" rows="4" placeholder="Type your message..."></textarea>
      </div>
    </fieldset>
    <button type="submit">Send Message</button>
  </form>
</body>
</html>`);
  return;
  }

  if (req.url === '/api/echo' && req.method === 'POST') {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ echo: body, timestamp: Date.now() }));
  });
  return;
  }

  if (req.url === '/' || !req.url) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Demo App</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; background: #ffffff; color: #333; }
    h1 { color: #1a1a2e; font-size: 2rem; }
    .subtitle { color: #666; font-size: 1rem; }
    a.nav-link { color: #0066cc; text-decoration: none; margin-right: 1rem; }
    a.nav-link:hover { text-decoration: underline; }
    .items { list-style: none; padding: 0; }
    .items li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
    footer { margin-top: 2rem; color: #999; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Demo App</h1>
  <p class="subtitle">A minimal app for testing @sovereign-labs/verify</p>
  <nav>
    <a class="nav-link" href="/">Home</a>
    <a class="nav-link" href="/api/items">API</a>
  </nav>
  <ul class="items">
    <li>Item Alpha</li>
    <li>Item Beta</li>
  </ul>
  <footer>Powered by Node.js</footer>
</body>
</html>`);
  return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Demo app listening on port ${PORT}`);
});

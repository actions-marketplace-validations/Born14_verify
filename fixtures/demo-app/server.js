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
});

server.listen(PORT, () => {
  console.log(`Demo app listening on port ${PORT}`);
});

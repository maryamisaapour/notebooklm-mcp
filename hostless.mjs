// Hostless entrypoint. API access stays disabled until NOTEBOOKLM_API_KEY is set.
// Client: MCP_HTTP_URL=https://your-app NOTEBOOKLM_API_KEY=... node hostless.mjs --client
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiKey = process.env.NOTEBOOKLM_API_KEY || '';
if (process.argv.includes('--client')) {
  if (apiKey.length < 32) throw new Error('Set NOTEBOOKLM_API_KEY (at least 32 characters).');
  const base = new URL(process.env.MCP_HTTP_URL || 'http://localhost:8000');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (url.origin !== base.origin) throw new Error('Refusing to send the API key to another origin.');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiKey}`);
    return originalFetch(input, { ...init, headers, redirect: 'error' });
  };
  await import('./dist/stdio-http-proxy.js');
} else {
  // Store login state in Hostless environment variables to survive redeploys.
  // Never commit this value to GitHub: it contains Google session cookies.
  const dataDir = process.env.DATA_DIR || '/app/data';
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const savedState = process.env.NOTEBOOKLM_STORAGE_STATE_B64;
  if (savedState) {
    let state;
    try {
      if (savedState.length > 2 * 1024 * 1024) throw new Error();
      state = JSON.parse(Buffer.from(savedState, 'base64').toString('utf8'));
    } catch {
      throw new Error('Invalid NOTEBOOKLM_STORAGE_STATE_B64 storage state.');
    }
    if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw new Error('Invalid NOTEBOOKLM_STORAGE_STATE_B64 storage state.');
    }
    const stateDir = join(dataDir, 'browser_state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  }
  const port = Number(process.env.PORT || 8000);
  const upstreamPort = port + 1;
  const child = spawn(process.execPath, ['dist/http-wrapper.js'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(upstreamPort),
      DATA_DIR: dataDir,
      HEADLESS: 'true',
      MAX_SESSIONS: '1',
    },
    stdio: 'inherit',
  });
  child.on('error', () => process.exit(1));
  child.on('exit', (code) => process.exit(code || 1));
  if (apiKey.length < 32) console.warn('API disabled: set NOTEBOOKLM_API_KEY to at least 32 characters.');
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/ready') {
      const probe = http.get({ host: '127.0.0.1', port: upstreamPort, path: '/', timeout: 3000 }, (upstream) => {
        upstream.resume();
        res.writeHead(upstream.statusCode === 200 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: upstream.statusCode === 200, apiConfigured: apiKey.length >= 32 }));
      });
      probe.on('timeout', () => probe.destroy());
      probe.on('error', () => { res.writeHead(503); res.end('Starting'); });
      return;
    }
    const supplied = Buffer.from(req.headers.authorization || '');
    if (apiKey.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(apiKey.length < 32 ? 503 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: apiKey.length < 32 ? 'API key not configured' : 'Unauthorized' }));
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
    delete headers.authorization;
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Backend unavailable');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 600000;
  server.listen(port, '0.0.0.0', () => console.log(`Protected HTTP gateway listening on ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      child.kill(signal);
      server.close();
      setTimeout(() => process.exit(0), 10000).unref();
    });
  }
}

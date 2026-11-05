import { afterAll, expect, test } from 'bun:test';
import { request } from 'node:http';
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

async function startNodeServer(moduleURL = new URL('../server.mjs', import.meta.url).href) {
  const child = Bun.spawn([Bun.which('node'), fileURLToPath(new URL('./server-worker.mjs', import.meta.url)), moduleURL], {
    env: { ...Bun.env, UV_THREADPOOL_SIZE: '2' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const reader = child.stdout.getReader();
  let output = '';
  try {
    while (!output.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Node server did not start: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(value);
    }
    const { port } = JSON.parse(output.split('\n')[0]);
    return { port, async stop() { child.kill(); await child.exited; } };
  } catch (error) {
    child.kill(); await child.exited; throw error;
  } finally {
    clearTimeout(timeout); reader.releaseLock();
  }
}

const server = await startNodeServer();
afterAll(() => server.stop());

function get(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path, ...options }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('all public routes return their unchanged HTML, including aliases and queries', async () => {
  for (const demo of ['', 'dns-resolution', 'nagle-nodelay', 'inetd', 'wdm-oxc']) {
    const expected = await Bun.file(new URL(`../${demo ? `${demo}/` : ''}index.html`, import.meta.url)).text();
    const paths = demo ? [`/${demo}`, `/${demo}/`, `/${demo}/index.html`] : ['/', '/index.html'];
    for (const path of paths) {
      const result = await get(`${path}?theme=dark`);
      expect(result.status).toBe(200);
      expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(result.body.toString()).toBe(expected);
      expect(Number(result.headers['content-length'])).toBe(result.body.length);
    }
  }
});

test('compression negotiation and HEAD preserve all supported representations', async () => {
  const expected = await Bun.file(new URL('../dns-resolution/index.html', import.meta.url)).bytes();
  const cases = [
    ['', undefined], ['gzip', 'gzip'], ['deflate', 'deflate'], ['br', 'br'],
    ['br, gzip, deflate', 'br'], ['br, gzip;q=0.5', 'br'],
    ['gzip ;q=1', 'gzip'], ['gzip;q=0.1, identity;q=1', undefined],
    ['gzip;q=0', undefined], ['*;q=1, gzip;q=0', 'br'], ['*', 'br'],
    ['gzip;q=invalid', undefined], ['br;q=0, gzip;q=0, deflate;q=0', undefined],
  ];
  for (const [encoding, expectedEncoding] of cases) {
    const result = await get('/dns-resolution/', { headers: { 'Accept-Encoding': encoding } });
    const head = await get('/dns-resolution/', { method: 'HEAD', headers: { 'Accept-Encoding': encoding } });
    expect(result.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['content-length']).toBe(String(expected.byteLength));
    expect(head.headers['content-encoding']).toBeUndefined();
    expect(result.headers.vary).toBe('Accept-Encoding');
    const decoder = { br: brotliDecompressSync, gzip: gunzipSync, deflate: inflateSync }[result.headers['content-encoding']];
    const decoded = decoder ? decoder(result.body) : result.body;
    expect(Buffer.from(decoded)).toEqual(Buffer.from(expected));
    expect(result.headers['content-encoding']).toBe(expectedEncoding);
  }
});

test('ETags revalidate each representation, including weak and list validators', async () => {
  for (const encoding of ['', 'gzip', 'br', 'deflate']) {
    const result = await get('/', { headers: { 'Accept-Encoding': encoding } });
    for (const validator of [result.headers.etag, `W/${result.headers.etag}`, `"old", ${result.headers.etag}`, '*']) {
      const cached = await get('/', { headers: { 'Accept-Encoding': encoding, 'If-None-Match': validator } });
      expect(cached.status).toBe(304);
      expect(cached.body.length).toBe(0);
      expect(cached.headers.etag).toBe(result.headers.etag);
    }
    expect((await get('/', { headers: { 'Accept-Encoding': encoding, 'If-None-Match': '"old"' } })).status).toBe(200);
  }
});

test('private files, malformed paths, traversal and unknown routes never expose files', async () => {
  for (const path of ['/package.json', '/bun.lock', '/server.mjs', '/.git/config', '/.agents/', '/tests/dns.test.mjs', '/missing', '/dns-resolution/missing', '/%2e%2e/package.json', '/dns-resolution/%2e%2e/package.json', '/%252e%252e/package.json', '/dns-resolution%5c..%5cpackage.json', '/%00', '//package.json']) {
    const result = await get(path);
    expect(result.status).toBe(404);
    expect(result.body.toString()).toBe('Not found\n');
  }
  expect((await get('/%E0%A4%A')).status).toBe(400);
  const head = await get('/missing', { method: 'HEAD' });
  expect(head.status).toBe(404);
  expect(head.body.length).toBe(0);
  expect(head.headers['content-length']).toBe(String(Buffer.byteLength('Not found\n')));
});

test('unsupported methods are rejected with Allow and no file content', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const result = await get('/', { method });
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD');
    expect(result.body.toString()).toBe('Method not allowed\n');
  }
});

test('an aborted gzip response does not prevent subsequent requests', async () => {
  await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/dns-resolution/', headers: { 'Accept-Encoding': 'gzip' } }, response => {
      response.destroy();
      req.destroy();
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => get('/dns-resolution/')));
  expect(results.every(result => result.status === 200)).toBe(true);
});

test('rapid equal-size edits with restored mtime refresh all concurrent encodings in Node', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'networking-server-test-'));
  const page = join(directory, 'index.html');
  copyFileSync(new URL('../server.mjs', import.meta.url), join(directory, 'server.mjs'));
  const variants = [0, 1].map(index => `<html>${'x'.repeat(60000)}<!-- edit ${index} --></html>`);
  writeFileSync(page, variants[0]);
  const mtime = statSync(page).mtime;
  let fixture;
  const previous = new Map();
  try {
    fixture = await startNodeServer(pathToFileURL(join(directory, 'server.mjs')).href);
    for (let i = 0; i < 80; i++) {
      const expected = variants[i % 2];
      writeFileSync(page, expected);
      utimesSync(page, mtime, mtime);
      const encodings = ['', 'br', 'gzip', 'deflate'];
      const results = await Promise.all(encodings.map(encoding => get('/', { port: fixture.port, headers: { 'Accept-Encoding': encoding } })));
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const encoding = encodings[index];
        const decoder = { br: brotliDecompressSync, gzip: gunzipSync, deflate: inflateSync }[encoding];
        expect(result.status).toBe(200);
        expect((decoder ? decoder(result.body) : result.body).toString()).toBe(expected);
        if (previous.has(encoding)) expect(result.headers.etag).not.toBe(previous.get(encoding));
        previous.set(encoding, result.headers.etag);
      }
    }
  } finally {
    await fixture?.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

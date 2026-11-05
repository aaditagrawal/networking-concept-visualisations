import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompress, constants, deflate, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const compressDeflate = promisify(deflate);
const cache = new Map();

const demos = ['dns-resolution', 'nagle-nodelay', 'inetd', 'wdm-oxc'];
const pages = new Map([['/', 'index.html'], ['/index.html', 'index.html']]);
for (const demo of demos) {
  pages.set(`/${demo}`, `${demo}/index.html`);
  pages.set(`/${demo}/`, `${demo}/index.html`);
  pages.set(`/${demo}/index.html`, `${demo}/index.html`);
}

function selectEncoding(header) {
  const encodings = new Map(header.toLowerCase().split(',').map(entry => {
    const [name, ...parameters] = entry.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const value = quality ? Number(quality.trim().slice(2)) : 1;
    return [name.trim(), Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0];
  }));
  let selected = 'identity';
  let highest = 0;
  for (const encoding of ['br', 'gzip', 'deflate', 'identity']) {
    const quality = encodings.get(encoding) ?? encodings.get('*') ?? 0;
    if (quality > highest) {
      selected = encoding;
      highest = quality;
    }
  }
  return selected;
}

function message(request, response, status, text, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)), ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : text);
}

async function representation(page, encoding) {
  // Filesystem timestamps can collide across rapid equal-size edits.
  const source = await readFile(new URL(page, import.meta.url));
  const revision = createHash('sha256').update(source).digest('hex');
  let entry = cache.get(page);
  if (entry?.revision !== revision) {
    entry = { revision, source, encoded: new Map() };
    cache.set(page, entry);
  }
  if (!entry.encoded.has(encoding)) {
    const current = entry;
    const result = Promise.resolve(current.source).then(async source => {
      const body = encoding === 'br'
        ? await brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
        : encoding === 'gzip' ? await compressGzip(source)
          : encoding === 'deflate' ? await compressDeflate(source) : source;
      return { body, etag: `"${encoding === 'identity' ? revision : createHash('sha256').update(body).digest('hex')}"` };
    }).catch(error => {
      // A failed read/compression can be retried without a file edit.
      if (cache.get(page) === current) cache.delete(page);
      throw error;
    });
    current.encoded.set(encoding, result);
  }
  return entry.encoded.get(encoding);
}

async function respond(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return message(request, response, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
  }
  let path;
  try {
    const url = new URL(request.url.startsWith('/') ? `http://localhost${request.url}` : request.url);
    path = decodeURIComponent(url.pathname);
  } catch {
    return message(request, response, 400, 'Bad request\n');
  }
  const page = pages.get(path);
  if (!page) return message(request, response, 404, 'Not found\n');

  // Resolve only this fixed list, never a user-provided filesystem path.
  // Match the original server's HEAD response without compression work.
  const encoding = request.method === 'HEAD' ? 'identity' : selectEncoding(request.headers['accept-encoding'] ?? '');
  const { body, etag } = await representation(page, encoding);
  if (response.destroyed) return;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Vary': 'Accept-Encoding',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
  const validators = request.headers['if-none-match']?.split(',').map(value => value.trim().replace(/^W\//, '')) ?? [];
  if (validators.includes(etag) || validators.includes('*')) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, { ...headers, 'Content-Length': String(body.byteLength) });
  response.end(request.method === 'HEAD' ? undefined : body);
}

export async function startServer({ hostname = '0.0.0.0', port = 3000 } = {}) {
  const server = createServer((request, response) => {
    respond(request, response).catch(error => {
      console.error('Unable to serve page:', error.message);
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else message(request, response, 500, 'Internal server error\n');
    });
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      ready();
    });
  });
  const address = server.address();
  let stopping;
  return {
    hostname: address.address, port: address.port,
    stop() {
      stopping ??= new Promise((done, reject) => {
        server.close(error => error ? reject(error) : done());
        server.closeAllConnections();
      });
      return stopping;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be an integer from 0 to 65535');
    process.exit(1);
  }
  const server = await startServer({ hostname: process.env.HOST ?? '0.0.0.0', port });
  console.log(`Serving networking demos on ${server.hostname}:${server.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { void server.stop().then(() => process.exit(0)); });
  }
}

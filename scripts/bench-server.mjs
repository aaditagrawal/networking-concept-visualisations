// Run from the repository root: bun scripts/bench-server.mjs [baseline git ref]
// The baseline is installed in a temporary directory, never in the project.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { strict as assert } from 'node:assert';

const base = process.argv[2] ?? '85ad3e71644d9f230081c5e58fda71e65da3166b';
const rounds = Number(process.env.BENCH_ROUNDS ?? 5);
const samples = Number(process.env.BENCH_SAMPLES ?? 40);
const warmup = Number(process.env.BENCH_WARMUP ?? 10);
const label = process.env.BENCH_LABEL ?? 'candidate';
const concurrency = 8;
const loadBefore = loadavg();
const directory = mkdtempSync(join(process.env.BENCH_TMPDIR ?? tmpdir(), 'networking-server-bench-'));
const baselineDirectory = join(directory, 'baseline');
const replacementDirectory = join(directory, 'replacement');
const root = fileURLToPath(new URL('../', import.meta.url));
const pages = ['index.html', ...['dns-resolution', 'nagle-nodelay', 'inetd', 'wdm-oxc'].map(name => `${name}/index.html`)];
const agents = { baseline: new Agent({ keepAlive: true, maxSockets: concurrency }), replacement: new Agent({ keepAlive: true, maxSockets: concurrency }) };
const children = new Set();
const node = Bun.which('node');
const threadpoolSize = Bun.env.UV_THREADPOOL_SIZE ?? '2';

function command(args, cwd = root) {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout;
}

function get(port, path = '/', { method = 'GET', encoding = '', agent, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = request({ hostname: '127.0.0.1', port, path, method, agent, headers: { 'Accept-Encoding': encoding, ...headers } }, response => {
      const firstByte = performance.now() - started;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), firstByte }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.end();
  });
}

function decode(result) {
  switch (result.headers['content-encoding']) {
    case 'br': return brotliDecompressSync(result.body);
    case 'gzip': return gunzipSync(result.body);
    case 'deflate': return inflateSync(result.body);
    default: return result.body;
  }
}

async function launch(name) {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  const started = performance.now();
  const process = Bun.spawn(name === 'baseline'
    ? [node, 'node_modules/serve/build/main.js', '.', '--no-clipboard', '--no-request-logging', '--listen', `tcp://127.0.0.1:${port}`]
    : [node, 'server.mjs'], {
    cwd: name === 'baseline' ? baselineDirectory : replacementDirectory,
    env: { ...Bun.env, UV_THREADPOOL_SIZE: threadpoolSize, HOST: '127.0.0.1', PORT: String(port) }, stdout: 'ignore', stderr: 'pipe',
  });
  children.add(process);
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if (process.exitCode !== null) throw new Error(await new Response(process.stderr).text());
    try {
      if ((await get(port)).status === 200) return { process, port, startup: performance.now() - started };
    } catch {}
    await Bun.sleep(5);
  }
  throw new Error(`${name} did not start within 30 seconds of readiness polling`);
}

async function stop(server) {
  server.process.kill();
  await server.process.exited;
  children.delete(server.process);
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => {
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    return Number((sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)).toFixed(3));
  };
  return { count: sorted.length, median_ms: quantile(0.5), p95_ms: quantile(0.95), min_ms: sorted[0], max_ms: sorted.at(-1) };
}

try {
  const nodeVersion = command([node, '--version']).toString().trim();
  for (const file of ['package.json', 'bun.lock', ...pages]) {
    const destination = join(baselineDirectory, file);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, command(['git', 'show', `${base}:${file}`]));
  }
  for (const file of ['server.mjs', ...pages]) {
    const destination = join(replacementDirectory, file);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, await Bun.file(join(root, file)).bytes());
  }
  command([Bun.which('bun'), 'install', '--frozen-lockfile'], baselineDirectory);
  const startup = { baseline: [], replacement: [] };
  for (let round = 0; round < rounds; round++) {
    for (const name of round % 2 ? ['replacement', 'baseline'] : ['baseline', 'replacement']) {
      const server = await launch(name);
      startup[name].push(server.startup);
      await stop(server);
    }
    console.error(`Startup round ${round + 1}/${rounds} complete`);
  }
  const servers = { baseline: await launch('baseline'), replacement: await launch('replacement') };
  // Check edit freshness against a disposable candidate fixture, never the checkout.
  const pagePath = join(replacementDirectory, 'index.html');
  const original = await Bun.file(pagePath).text();
  const earlier = await get(servers.replacement.port);
  writeFileSync(pagePath, `${original}\n<!-- benchmark edit -->`);
  const edited = await get(servers.replacement.port, '/', { headers: { 'If-None-Match': earlier.headers.etag } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.toString(), `${original}\n<!-- benchmark edit -->`);
  assert.notEqual(edited.headers.etag, earlier.headers.etag);
  for (const encoding of ['br', 'gzip', 'deflate']) {
    await get(servers.replacement.port, '/', { encoding });
  }
  // Equal-length edits must invalidate every cached encoding too.
  writeFileSync(pagePath, `${original}\n<!-- benchmark EDIT -->`);
  const decoders = { br: brotliDecompressSync, gzip: gunzipSync, deflate: inflateSync };
  for (const encoding of ['', 'br', 'gzip', 'deflate']) {
    const refreshed = await get(servers.replacement.port, '/', { encoding });
    const body = decoders[encoding] ? decoders[encoding](refreshed.body) : refreshed.body;
    assert.equal(body.toString(), `${original}\n<!-- benchmark EDIT -->`);
  }
  writeFileSync(pagePath, original);
  // Abort a bounded HTML response after headers and verify recovery.
  for (const name of ['baseline', 'replacement']) {
    await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: servers[name].port, path: '/dns-resolution/', headers: { 'Accept-Encoding': 'br, gzip, deflate' } }, response => {
        response.destroy(); req.destroy(); resolve();
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal((await get(servers[name].port)).status, 200);
  }
  const validators = {};
  for (const name of ['baseline', 'replacement']) {
    const response = await get(servers[name].port, '/dns-resolution/');
    assert.equal(response.status, 200);
    assert.equal(typeof response.headers.etag, 'string');
    validators[name] = response.headers.etag;
    assert.equal((await get(servers[name].port, '/dns-resolution/', { headers: { 'If-None-Match': validators[name] } })).status, 304);
  }
  // Verify byte-for-byte payload equivalence before timing.
  for (const path of ['/', '/nagle-nodelay/', '/dns-resolution/']) {
    for (const encoding of ['', 'gzip', 'br', 'deflate', 'br, gzip, deflate']) {
      const before = await get(servers.baseline.port, path, { encoding });
      const after = await get(servers.replacement.port, path, { encoding });
      assert.equal(after.status, before.status);
      assert.equal(after.headers['content-encoding'], before.headers['content-encoding']);
      assert.deepEqual(decode(after), decode(before));
    }
  }
  const cases = [
    { name: 'small GET', path: '/' },
    { name: 'small gzip GET', path: '/', encoding: 'gzip' },
    { name: 'small browser GET', path: '/', encoding: 'br, gzip, deflate' },
    { name: 'typical GET', path: '/nagle-nodelay/' },
    { name: 'typical gzip GET', path: '/nagle-nodelay/', encoding: 'gzip' },
    { name: 'typical browser GET', path: '/nagle-nodelay/', encoding: 'br, gzip, deflate' },
    { name: 'large GET', path: '/dns-resolution/' },
    { name: 'large gzip GET', path: '/dns-resolution/', encoding: 'gzip' },
    { name: 'large browser GET', path: '/dns-resolution/', encoding: 'br, gzip, deflate' },
    { name: 'large deflate GET', path: '/dns-resolution/', encoding: 'deflate' },
    { name: 'large HEAD', path: '/dns-resolution/', method: 'HEAD' },
    { name: 'large gzip HEAD', path: '/dns-resolution/', method: 'HEAD', encoding: 'gzip' },
    { name: 'large browser HEAD', path: '/dns-resolution/', method: 'HEAD', encoding: 'br, gzip, deflate' },
    { name: 'large conditional 304', path: '/dns-resolution/', conditional: true },
    { name: 'no-slash GET', path: '/dns-resolution?theme=dark' },
    { name: 'missing path', path: '/missing' },
    { name: 'traversal rejection', path: '/%2e%2e/missing' },
    { name: 'concurrent large gzip x8', path: '/dns-resolution/', encoding: 'gzip', concurrent: concurrency },
    { name: 'concurrent large browser x8', path: '/dns-resolution/', encoding: 'br, gzip, deflate', concurrent: concurrency },
    { name: 'edited large GET', path: '/dns-resolution/', coldEdit: true },
    { name: 'edited large gzip GET', path: '/dns-resolution/', encoding: 'gzip', coldEdit: true },
    { name: 'edited large browser GET', path: '/dns-resolution/', encoding: 'br, gzip, deflate', coldEdit: true },
    { name: 'edited large HEAD', path: '/dns-resolution/', method: 'HEAD', coldEdit: true },
    { name: 'edited large gzip HEAD', path: '/dns-resolution/', method: 'HEAD', encoding: 'gzip', coldEdit: true },
    { name: 'edited large browser HEAD', path: '/dns-resolution/', method: 'HEAD', encoding: 'br, gzip, deflate', coldEdit: true },
  ];
  const editedPage = 'dns-resolution/index.html';
  const editedOriginal = await Bun.file(join(replacementDirectory, editedPage)).text();
  const editedVariants = [0, 1].map(index => `${editedOriginal}\n<!-- benchmark edit ${index} -->`);
  const results = [];
  for (const item of cases) {
    const timings = { baseline: [], replacement: [] };
    const firstBytes = { baseline: [], replacement: [] };
    const roundMedians = { baseline: [], replacement: [] };
    const revisions = { baseline: 0, replacement: 0 };
    for (let round = 0; round < rounds; round++) {
      for (const name of round % 2 ? ['replacement', 'baseline'] : ['baseline', 'replacement']) {
        const run = () => Promise.all(Array.from({ length: item.concurrent ?? 1 }, () => get(servers[name].port, item.path, { ...item, agent: agents[name], headers: item.conditional ? { 'If-None-Match': validators[name] } : {} })));
        const sample = async () => {
          const expected = item.coldEdit ? editedVariants[revisions[name]++ % 2] : null;
          if (expected !== null) {
            writeFileSync(join(name === 'baseline' ? baselineDirectory : replacementDirectory, editedPage), expected);
          }
          const started = performance.now();
          const responses = await run();
          const elapsed = performance.now() - started;
          // Writes and decoding/assertions are outside the timed HTTP operation.
          if (expected !== null) {
            for (const response of responses) {
              assert.equal(response.status, 200);
              if (item.method === 'HEAD') {
                assert.equal(response.body.length, 0);
                assert.equal(response.headers['content-encoding'], undefined);
                assert.equal(Number(response.headers['content-length']), Buffer.byteLength(expected));
              } else {
                assert.equal(response.headers['content-encoding'], item.encoding === 'gzip' ? 'gzip' : item.encoding ? 'br' : undefined);
                const decoded = decode(response);
                assert.equal(Buffer.compare(decoded, Buffer.from(expected)), 0,
                  `${item.name}/${name}: expected ${Buffer.byteLength(expected)} bytes ending ${JSON.stringify(expected.slice(-50))}, got ${decoded.length} ending ${JSON.stringify(decoded.toString().slice(-50))}`);
              }
            }
          }
          return { responses, elapsed };
        };
        for (let i = 0; i < warmup; i++) await sample();
        const batch = [];
        for (let i = 0; i < samples; i++) {
          const { responses, elapsed } = await sample();
          batch.push(elapsed);
          firstBytes[name].push(...responses.map(response => response.firstByte));
        }
        timings[name].push(...batch);
        roundMedians[name].push(summary(batch).median_ms);
      }
    }
    const baseline = summary(timings.baseline);
    const replacement = summary(timings.replacement);
    if (item.coldEdit) {
      for (const fixture of [baselineDirectory, replacementDirectory]) writeFileSync(join(fixture, editedPage), editedOriginal);
    }
    results.push({ name: item.name, cache_state: item.coldEdit ? 'file edited before every request' : 'warm', equivalent_payload: !['missing path', 'traversal rejection'].includes(item.name), baseline, replacement, first_byte: { baseline: summary(firstBytes.baseline), replacement: summary(firstBytes.replacement) }, median_ratio: Number((replacement.median_ms / baseline.median_ms).toFixed(3)), round_medians_ms: roundMedians });
    console.error(`${item.name}: median ${baseline.median_ms} -> ${replacement.median_ms} ms`);
  }
  const bytes = {};
  for (const file of pages) bytes[file] = Bun.file(join(root, file)).size;
  const serverHash = new Bun.CryptoHasher('sha256').update(await Bun.file(join(replacementDirectory, 'server.mjs')).bytes()).digest('hex');
  console.log(JSON.stringify({ label, candidate_server_sha256: serverHash, base, server_runtime: nodeVersion, server_executable: node, node_threadpool_size: threadpoolSize, client_runtime: Bun.version, client_executable: Bun.which('bun'), platform: `${process.platform}/${process.arch}`, kernel: release(), cpu: cpus()[0]?.model, logical_cpus: cpus().length, fixture_directory: directory, load_before: loadBefore, load_after: loadavg(), payload_bytes: bytes, rounds, samples_per_round: samples, warmup_per_round: warmup, concurrency, baseline_logging: 'disabled', startup: { baseline: summary(startup.baseline), replacement: summary(startup.replacement) }, results }, null, 2));
  for (const server of Object.values(servers)) await stop(server);
} finally {
  for (const child of children) { child.kill(); await child.exited; }
  for (const agent of Object.values(agents)) agent.destroy();
  rmSync(directory, { recursive: true, force: true });
}

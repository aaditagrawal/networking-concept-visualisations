import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function page() {
  const html = readFileSync(new URL('../dns-resolution/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test' });
  const { window } = dom;
  window.setTimeout = callback => { callback(); return 0; };
  let tick = 0;
  window.requestAnimationFrame = callback => { callback((tick += 10000)); return tick; };
  window.eval('(function() {\n' + html.match(/<script>([\s\S]*?)<\/script>/)[1] + '\nwindow.api = { start, showBanner, showHierarchy, runRecursive, state };\n})();');
  return { window, api: window.api, close: () => window.close() };
}

const response = {
  domain: '<b>example.test</b>', qtype: 'TXT', tld: 'test', authZone: 'example.test',
  rootServers: ['root.test'], tldServers: ['tld.test'], authServers: ['auth.test'],
  cnameChain: [], finalRecords: [{ type: 'TXT', data: '<img src=x>', ttl: 30 }],
  finalAnswer: { type: 'TXT', data: '<img src=x>', ttl: 30 }, rcode: 0, flags: {}, error: null,
};

test('DNS strings render as literal text in banner, hierarchy and simulation logs', async () => {
  const p = page();
  p.api.showBanner(response); p.api.showHierarchy(response);
  await p.api.runRecursive(response);
  expect(p.window.document.getElementById('bannerResult').textContent).toContain('<img src=x>');
  expect(p.window.document.getElementById('domainHierarchy').querySelector('b')).toBeNull();
  expect(p.window.document.getElementById('recLog').querySelector('img')).toBeNull();
  p.close();
});

test('transport failure clears earlier response details and never animates a DNS answer', async () => {
  const p = page();
  p.api.showBanner(response);
  p.window.fetch = async () => { throw new Error('offline'); };
  await p.api.start();
  expect(p.window.document.querySelector('.banner-details')).toBeNull();
  expect(p.window.document.querySelectorAll('#recSvg line')).toHaveLength(0);
  expect(p.window.document.getElementById('bannerResult').textContent).toContain('offline');
  expect(p.window.document.getElementById('startBtn').disabled).toBe(false);
  p.close();
});

test('mobile arrow endpoints stay inside the rendered diagram', async () => {
  const p = page();
  Object.defineProperty(p.window.document.getElementById('recDiagram'), 'offsetHeight', { value: 400 });
  await p.api.runRecursive(response);
  for (const line of p.window.document.querySelectorAll('#recSvg line')) {
    expect(Number(line.getAttribute('y2'))).toBeLessThan(400);
  }
  p.close();
});

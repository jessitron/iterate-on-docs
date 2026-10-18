// Telemetry smoke tests. The rest of the suite runs with telemetry off; these check the switch,
// the spans a GET and a PUT make, and, given OTel variables that point at Honeycomb, that spans land
// there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from '../vendor/linkedom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, '..', 'server.mjs');

// The environment without any telemetry settings this shell might carry.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTEL_|HRV_TELEMETRY)/.test(k)));
  return { ...env, ...extra };
}

// A stand-in OTLP/HTTP collector. spans() flattens what it received.
async function withCollector(fn) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const collector = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    bodies,
    spans: () =>
      bodies.flatMap(({ body }) =>
        body.resourceSpans.flatMap((rs) =>
          rs.scopeSpans.flatMap((ss) => ss.spans.map((s) => ({ ...s, resource: attrs(rs.resource.attributes), attributes: attrs(s.attributes) }))),
        ),
      ),
  };
  try {
    await fn(collector);
  } finally {
    server.close();
  }
}

const attrs = (list = []) => Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));

// Start the server on a copy of the fixtures, run fn, then stop it the way Ctrl-C does and wait
// for it to exit, so it has flushed its spans.
async function withServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-revisor-'));
  fs.cpSync(path.join(here, 'fixtures'), dir, { recursive: true });
  const child = spawn(process.execPath, [serverFile, dir, '--port', '0'], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => child.on('exit', r));
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no startup line; stderr: ${stderr}`)), 5000);
      child.stdout.on('data', () => {
        const m = stdout.match(/html-revisor: (http:\/\/localhost:\d+\/) serving/);
        if (m) clearTimeout(timer), resolve(m[1]);
      });
      exited.then((code) => reject(new Error(`server exited ${code}; stderr: ${stderr}`)));
    });
    await fn({ base, stdout: () => stdout, stderr: () => stderr });
  } finally {
    child.kill('SIGINT');
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One GET of page.html, under the given traceparent, and one directive PUT on its first <p>.
async function getAndPut(base, traceparent) {
  const html = await (await fetch(base + 'page.html', { headers: { traceparent } })).text();
  const { document } = parseHTML(html);
  const bases = JSON.parse(document.querySelector('script#hrv-bases').textContent);
  const id = document.querySelector('p').getAttribute('data-hrv');
  const res = await fetch(base + 'page.html', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, base: bases[id], directive: 'make it shorter' }),
  });
  assert.equal(res.status, 200);
  return id;
}

const traceId = () => crypto.randomBytes(16).toString('hex');

test('telemetry is off without HRV_TELEMETRY, even with an OTLP endpoint set', () =>
  withCollector(async (collector) => {
    const env = cleanEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint });
    await withServer(env, async ({ base, stdout }) => {
      await getAndPut(base, `00-${traceId()}-${'1'.repeat(16)}-01`);
      assert.doesNotMatch(stdout(), /telemetry on/);
    });
    assert.deepEqual(collector.bodies, []);
  }));

test('with HRV_TELEMETRY, a GET and a PUT send spans for their steps', () =>
  withCollector(async (collector) => {
    const env = cleanEnv({ HRV_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint, OTEL_SERVICE_NAME: 'hrv-test' });
    const trace = traceId(), parent = 'abcdef0123456789';
    let id;
    await withServer(env, async ({ base, stdout }) => {
      assert.match(stdout(), /telemetry on, to http:\/\/127\.0\.0\.1/);
      id = await getAndPut(base, `00-${trace}-${parent}-01`);
    });
    assert.ok(collector.bodies.every((b) => b.url === '/v1/traces'));
    const spans = collector.spans();
    const named = (name) => spans.filter((s) => s.name === name);

    const [get] = named('GET page');
    assert.ok(get, `no GET page span among ${spans.map((s) => s.name)}`);
    assert.equal(get.resource['service.name'], 'hrv-test');
    assert.equal(get.traceId, trace, 'GET continues the traceparent it was sent');
    assert.equal(get.parentSpanId, parent);
    assert.equal(get.attributes['hrv.page'], '/page.html');
    assert.equal(get.attributes['http.response.status_code'], 200);
    assert.ok(get.attributes['hrv.page.bytes'] > 0);
    assert.ok(get.attributes['hrv.answer.bytes'] > get.attributes['hrv.page.bytes']);
    const getSteps = spans.filter((s) => s.parentSpanId === get.spanId).map((s) => s.name);
    for (const step of ['read file', 'normalize', 'parse', 'directives', 'bases', 'markdowns', 'serialize']) {
      assert.ok(getSteps.includes(step), `GET has no ${step} step; it has ${getSteps}`);
    }

    const [put] = named('PUT change');
    assert.ok(put, 'no PUT change span');
    assert.equal(put.attributes['hrv.change.kind'], 'directive');
    assert.equal(put.attributes['hrv.scope.id'], id);
    assert.equal(put.attributes['hrv.directive.count'], 1);
    const putSteps = spans.filter((s) => s.parentSpanId === put.spanId).map((s) => s.name);
    for (const step of ['read file', 'parse', 'check base', 'set directive', 'serialize', 'write file', 'reparse', 'bases']) {
      assert.ok(putSteps.includes(step), `PUT has no ${step} step; it has ${putSteps}`);
    }
  }));

// The browser's spans for one directive save, as client.js posts them, around a real PUT that
// carries the client PUT span as its traceparent.
test('with HRV_TELEMETRY, spans the browser posts join the trace of the PUT they sent', () =>
  withCollector(async (collector) => {
    const env = cleanEnv({ HRV_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint });
    const trace = traceId(), save = 'a'.repeat(16), put = 'b'.repeat(16);
    await withServer(env, async ({ base }) => {
      const html = await (await fetch(base + 'page.html')).text();
      const { document } = parseHTML(html);
      assert.ok(document.querySelector('#hrv-directives').hasAttribute('data-telemetry'), 'the page tells the client to record');
      const bases = JSON.parse(document.querySelector('script#hrv-bases').textContent);
      const id = document.querySelector('p').getAttribute('data-hrv');
      const t0 = Date.now();
      const res = await fetch(base + 'page.html', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', traceparent: `00-${trace}-${put}-01` },
        body: JSON.stringify({ id, base: bases[id], directive: 'make it shorter' }),
      });
      assert.equal(res.status, 200);
      const spans = [
        { name: 'save directive', traceId: trace, spanId: save, start: t0, end: t0 + 50, attributes: { 'hrv.edits': 3, 'hrv.wait.ms': 500 },
          events: [{ name: 'close box', time: t0 + 10, attributes: { 'hrv.close.by': 'done' } }, { name: 'no time' }] },
        { name: 'PUT', kind: 'client', traceId: trace, spanId: put, parentSpanId: save, start: t0, end: t0 + 40, attributes: { nested: { no: 1 } } },
        { name: 'bad', traceId: 'nope', spanId: put, start: t0, end: t0 },
      ];
      const posted = await fetch(base + '.hrv/spans', { method: 'POST', body: JSON.stringify(spans) });
      assert.equal(posted.status, 204);
    });
    const spans = collector.spans();
    const named = (name) => spans.find((s) => s.name === name);
    const root = named('save directive');
    assert.ok(root, `no save directive span among ${spans.map((s) => s.name)}`);
    assert.equal(root.traceId, trace);
    assert.equal(root.spanId, save);
    assert.equal(root.parentSpanId ?? '', '');
    assert.equal(root.attributes['hrv.side'], 'browser');
    assert.equal(root.attributes['hrv.edits'], 3);
    assert.equal(root.attributes['hrv.wait.ms'], 500);
    assert.deepEqual(root.events.map((e) => [e.name, attrs(e.attributes)['hrv.close.by']]), [['close box', 'done']], 'events become span events; one without a time is dropped');
    const clientPut = named('PUT');
    assert.equal(clientPut.spanId, put);
    assert.equal(clientPut.kind, 3, 'SPAN_KIND_CLIENT');
    assert.equal(clientPut.attributes.nested, undefined, 'only plain values become attributes');
    assert.equal(named('PUT change').parentSpanId, put, 'the server span nests under the browser PUT');
    assert.equal(named('bad'), undefined, 'a span with a malformed ID is dropped');
    assert.ok(!spans.some((s) => s.name === 'POST'), 'posting spans makes no span');
  }));

// Done, as client.js sends it: the browser's done span is the POST's traceparent.
test('with HRV_TELEMETRY, Done nests under the browser done span and says whether it announced', () =>
  withCollector(async (collector) => {
    const env = cleanEnv({ HRV_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint });
    const trace = traceId(), done = 'c'.repeat(16);
    await withServer(env, async ({ base }) => {
      const id = await getAndPut(base, `00-${traceId()}-${'1'.repeat(16)}-01`);
      const t0 = Date.now();
      const res = await fetch(base + 'page.html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', traceparent: `00-${trace}-${done}-01` },
        body: JSON.stringify({ id, directive: '' }),
      });
      assert.deepEqual(await res.json(), { announced: true });
      const spans = [{ name: 'done', kind: 'client', traceId: trace, spanId: done, start: t0, end: t0 + 20,
        attributes: { 'hrv.box.session': 'f00d', 'hrv.close.by': 'key', 'hrv.announced': true } }];
      assert.equal((await fetch(base + '.hrv/spans', { method: 'POST', body: JSON.stringify(spans) })).status, 204);
    });
    const spans = collector.spans();
    const browser = spans.find((s) => s.name === 'done');
    assert.equal(browser.attributes['hrv.box.session'], 'f00d');
    const server = spans.find((s) => s.name === 'POST done');
    assert.ok(server, `no POST done span among ${spans.map((s) => s.name)}`);
    assert.equal(server.parentSpanId, done, 'the server span nests under the browser done span');
    assert.equal(server.attributes['hrv.announced'], true);
    const steps = spans.filter((s) => s.parentSpanId === server.spanId).map((s) => s.name);
    assert.deepEqual(steps.sort(), ['announcement', 'parse', 'read file']);
  }));

test('without HRV_TELEMETRY, the page does not ask the client to record', () =>
  withServer(cleanEnv({}), async ({ base }) => {
    const html = await (await fetch(base + 'page.html')).text();
    assert.ok(!parseHTML(html).document.querySelector('#hrv-directives').hasAttribute('data-telemetry'));
  }));

// Real spans, to Honeycomb. Runs when the shell's standard OTel variables point at Honeycomb, as
// .be sets them. An ingest key can send but not query, so this test checks only that the export
// succeeded; it prints the run ID, and an agent finds the spans by it with the Honeycomb MCP.
const honeycombKey = /(?:^|,)\s*x-honeycomb-team=([^,]+)/i.exec(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '')?.[1];
const honeycombApi = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://api.honeycomb.io').replace(/\/$/, '');
const dataset = 'html-revisor-test';

test('with HRV_TELEMETRY, spans go to Honeycomb without an export error', { skip: !honeycombKey && 'set OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<key> to run', timeout: 30_000 }, async () => {
  const run = crypto.randomUUID();
  const env = cleanEnv({
    HRV_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: honeycombApi,
    OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${honeycombKey}`,
    OTEL_SERVICE_NAME: dataset,
    OTEL_RESOURCE_ATTRIBUTES: `hrv.test.run=${run}`,
  });
  const trace = traceId();
  let stderr;
  await withServer(env, async (server) => {
    await getAndPut(server.base, `00-${trace}-${'1'.repeat(16)}-01`);
    stderr = server.stderr;
  });
  assert.doesNotMatch(stderr(), /telemetry export failed/);
  console.log(`Honeycomb: dataset ${dataset}, hrv.test.run=${run}, trace ${trace}`);
});

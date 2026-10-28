// Telemetry: OpenTelemetry spans, sent over OTLP, only when HRV_TELEMETRY is set.
//
// Tier III. The API is always loaded: until an SDK registers, every span is a no-op that costs
// tens of nanoseconds. startTelemetry loads the SDK, and only when HRV_TELEMETRY is set. The
// switch is our own because the standard OTEL_* variables can leak in from a parent process
// (Claude Code reads them for its own telemetry). Once it's on, the standard variables say
// where spans go and what they carry: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
// OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES.
import crypto from 'node:crypto';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '../vendor/opentelemetry-api.mjs';

export const tracer = trace.getTracer('html-revisor');
export { trace };

// A clock for span times, in epoch milliseconds with a fraction. The SDK starts a span at
// Date.now(), a whole millisecond, so steps in one request would claim the same start. This
// clock adds performance.now(), which has microseconds, to an anchor on the wall clock. The
// monotonic clock stops while the machine sleeps, and the wall clock can step; when the two
// part by more than slack milliseconds, the anchor moves to the wall clock again.
export function makeClock({ wall = Date.now, mono = () => performance.now(), origin = performance.timeOrigin, slack = 2 } = {}) {
  let anchor = origin;
  return () => {
    const m = mono(), w = wall();
    if (Math.abs(anchor + m - w) > slack) anchor = w - m;
    return anchor + m;
  };
}
export const spanTime = makeClock();

// Spans made here take their start, end, and event times from the clock. A span given a start
// time stamps an end or event that has none with Date.now(), so each one needs a time too.
function fail(span, err) {
  span.recordException(err, spanTime());
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) });
}

// The span for one HTTP request. It continues the trace in the request's traceparent header,
// if any, and ends when the response closes, with its status code.
export function requestSpan(req, res, fn) {
  const parent = propagation.extract(context.active(), req.headers);
  const attributes = { 'http.request.method': req.method, 'url.path': req.url.split(/[?#]/)[0] };
  return tracer.startActiveSpan(req.method, { kind: SpanKind.SERVER, attributes, startTime: spanTime() }, parent, (span) => {
    res.on('close', () => {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(spanTime());
    });
    return fn(span);
  });
}

// Load the SDK and register it, when env says to. Returns a function that sends the spans
// still waiting and stops, or null when telemetry is off.
export async function startTelemetry(env = process.env) {
  if (!env.HRV_TELEMETRY) return null;
  const sdk = await import('../vendor/opentelemetry-sdk.mjs');
  // The exporter drops a failed batch without a word; say so on stderr, so a bad key shows.
  const exporter = new sdk.OTLPTraceExporter();
  const send = exporter.export.bind(exporter);
  exporter.export = (spans, done) =>
    send(spans, (result) => {
      if (result.code !== 0) console.error(`html-revisor: telemetry export failed: ${result.error?.message ?? result.code}`);
      done(result);
    });
  const provider = new sdk.BasicTracerProvider({
    idGenerator,
    resource: sdk.resourceFromAttributes({ 'service.name': 'html-revisor' }).merge(sdk.detectResources({ detectors: [sdk.envDetector] })),
    spanProcessors: [new sdk.BatchSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new sdk.AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new sdk.W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return () => provider.shutdown();
}

// IDs come from the random source unless a browser span has set the ones to use next.
let forced = null;
const idGenerator = {
  generateTraceId: () => forced?.traceId ?? crypto.randomBytes(16).toString('hex'),
  generateSpanId: () => forced?.spanId ?? crypto.randomBytes(8).toString('hex'),
};

const isHex = (n, s) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

// The attributes whose values OTel takes as they are: strings, numbers, booleans.
function plain(attributes) {
  const out = {};
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

// Spans the browser recorded, as plain objects: {name, traceId, spanId, parentSpanId?, start,
// end (epoch milliseconds), kind?: 'client', error?, attributes, events?: [{name, time,
// attributes}]}. Each becomes an OTel span with
// the browser's IDs and times, so it joins the trace the PUT's traceparent continues. Returns how
// many it kept. With telemetry off, the spans are no-ops.
export function recordBrowserSpans(list) {
  if (!Array.isArray(list)) return 0;
  let kept = 0;
  for (const s of list) {
    if (!s || typeof s.name !== 'string' || !isHex(32, s.traceId) || !isHex(16, s.spanId)) continue;
    if (s.parentSpanId !== undefined && !isHex(16, s.parentSpanId)) continue;
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const parent = s.parentSpanId
      ? trace.setSpanContext(context.active(), { traceId: s.traceId, spanId: s.parentSpanId, traceFlags: 1, isRemote: true })
      : context.active();
    const attributes = { 'hrv.side': 'browser', ...plain(s.attributes) };
    const kind = s.kind === 'client' ? SpanKind.CLIENT : SpanKind.INTERNAL;
    forced = { traceId: s.traceId, spanId: s.spanId };
    let span;
    try {
      span = tracer.startSpan(s.name, { kind, attributes, startTime: s.start, root: !s.parentSpanId }, parent);
    } finally {
      forced = null;
    }
    for (const e of Array.isArray(s.events) ? s.events : []) {
      if (e && typeof e.name === 'string' && Number.isFinite(e.time)) span.addEvent(e.name, plain(e.attributes), e.time);
    }
    if (s.error) span.setStatus({ code: SpanStatusCode.ERROR, message: String(s.error) });
    span.end(s.end);
    kept++;
  }
  return kept;
}

// The adapter for the domain's step port (domain/served-page.mjs): each step is a span.
export const step = (name, fn) => inSpan(name, {}, () => fn());

// Run fn(span) inside a span. The span ends when fn returns, or when the promise it returns
// settles; a throw marks the span as an error.
export function inSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes, startTime: spanTime() }, (span) => {
    const thrown = (err) => {
      fail(span, err);
      span.end(spanTime());
      throw err;
    };
    let out;
    try {
      out = fn(span);
    } catch (err) {
      thrown(err);
    }
    if (typeof out?.then !== 'function') {
      span.end(spanTime());
      return out;
    }
    return out.then((value) => {
      span.end(spanTime());
      return value;
    }, thrown);
  });
}

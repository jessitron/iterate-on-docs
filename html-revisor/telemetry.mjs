// Telemetry: OpenTelemetry spans, sent over OTLP, only when HRV_TELEMETRY is set.
//
// Tier III. The API is always loaded: until an SDK registers, every span is a no-op that costs
// tens of nanoseconds. startTelemetry loads the SDK, and only when HRV_TELEMETRY is set. The
// switch is our own because the standard OTEL_* variables can leak in from a parent process
// (Claude Code reads them for its own telemetry). Once it's on, the standard variables say
// where spans go and what they carry: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
// OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES.
import crypto from 'node:crypto';
import { trace, context, propagation, SpanKind, SpanStatusCode } from './vendor/opentelemetry-api.mjs';

export const tracer = trace.getTracer('html-revisor');
export { trace };

// The span for one HTTP request. It continues the trace in the request's traceparent header,
// if any, and ends when the response closes, with its status code.
export function requestSpan(req, res, fn) {
  const parent = propagation.extract(context.active(), req.headers);
  const attributes = { 'http.request.method': req.method, 'url.path': req.url.split(/[?#]/)[0] };
  return tracer.startActiveSpan(req.method, { kind: SpanKind.SERVER, attributes }, parent, (span) => {
    res.on('close', () => {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    return fn(span);
  });
}

// Load the SDK and register it, when env says to. Returns a function that sends the spans
// still waiting and stops, or null when telemetry is off.
export async function startTelemetry(env = process.env) {
  if (!env.HRV_TELEMETRY) return null;
  const sdk = await import('./vendor/opentelemetry-sdk.mjs');
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

// Run fn(span) inside a span. The span ends when fn returns, or when the promise it returns
// settles; a throw marks the span as an error.
export function inSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    const fail = (err) => {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) });
      span.end();
      throw err;
    };
    let out;
    try {
      out = fn(span);
    } catch (err) {
      fail(err);
    }
    if (typeof out?.then !== 'function') {
      span.end();
      return out;
    }
    return out.then((value) => {
      span.end();
      return value;
    }, fail);
  });
}

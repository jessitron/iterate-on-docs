// The served page: the file's document with the client and its data added. Tier II, a pure
// function over a DOM. Appended to the served copy, never written to the file, so none of it
// has an ID.

// directives: {id: text}. bases: {id: base}, sent back with each change. markdowns: {id: markdown}.
// committed: {id: markdown} at the last commit. css, js: the client assets.
// telemetry: the client records spans for its saves.
export function injectClient(document, { directives, bases, markdowns = {}, committed = {}, telemetry = false }, version, { css, js }) {
  const head = document.querySelector('head') ?? document.documentElement;
  const body = document.querySelector('body') ?? document.documentElement;

  const style = document.createElement('style');
  style.textContent = css;
  head.appendChild(style);

  const data = document.createElement('script');
  data.setAttribute('type', 'application/json');
  data.setAttribute('id', 'hrv-directives');
  if (version) data.setAttribute('data-version', version);
  if (telemetry) data.setAttribute('data-telemetry', '');
  data.textContent = JSON.stringify(directives).replace(/</g, '\\u003c');
  body.appendChild(data);

  const baseData = document.createElement('script');
  baseData.setAttribute('type', 'application/json');
  baseData.setAttribute('id', 'hrv-bases');
  baseData.textContent = JSON.stringify(bases);
  body.appendChild(baseData);

  const markdownData = document.createElement('script');
  markdownData.setAttribute('type', 'application/json');
  markdownData.setAttribute('id', 'hrv-markdown');
  markdownData.textContent = JSON.stringify(markdowns).replace(/</g, '\\u003c');
  body.appendChild(markdownData);

  const committedData = document.createElement('script');
  committedData.setAttribute('type', 'application/json');
  committedData.setAttribute('id', 'hrv-committed');
  committedData.textContent = JSON.stringify(committed).replace(/</g, '\\u003c');
  body.appendChild(committedData);

  const script = document.createElement('script');
  script.textContent = js;
  body.appendChild(script);
}

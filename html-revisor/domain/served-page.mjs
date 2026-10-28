// The served page: the file's document with the client and its data added. Tier II, a pure
// function over a DOM. Appended to the served copy, never written to the file, so none of it
// has an ID.
import { ID } from './identity.mjs';
import { collectDirectives, threadsOf, removeThreads } from './directives.mjs';
import { basesOf } from './bases.mjs';

// The step port: step(name, fn) runs fn and returns what it returns. The caller supplies it to
// observe each step, as a span; left out, the steps just run.
const justRun = (name, fn) => fn();

// What a tab keeps of the page besides its HTML: each element's directive, the settled turns of
// each thread, and every element's base. Lifts the threads out of the document.
export function tabStateOf(document, author, step = justRun) {
  const { directives, threads } = step('directives', () => {
    const found = { directives: collectDirectives(document, author), threads: threadsOf(document, author) };
    removeThreads(document, author);
    return found;
  });
  const bases = step('bases', () => basesOf(document.querySelectorAll(`[${ID}]`), author));
  return { directives, threads, bases };
}

// directives: {id: text}, each element's open turn. threads: {id: [{prefix, text}]}, the settled
// turns of each thread with a reply. bases: {id: base}, sent back with each change. markdowns:
// {id: markdown}. committed: {id: markdown} at the last commit. css, js: the client assets.
// telemetry: the client records spans for its saves.
export function injectClient(document, { directives, threads = {}, bases, markdowns = {}, committed = {}, telemetry = false }, version, { css, js }) {
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

  const threadData = document.createElement('script');
  threadData.setAttribute('type', 'application/json');
  threadData.setAttribute('id', 'hrv-threads');
  threadData.textContent = JSON.stringify(threads).replace(/</g, '\\u003c');
  body.appendChild(threadData);

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

// Read-side helpers. No persistence or business rules belong in this module.
export function debounce(callback, delay = 300) {
  let timer;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
  run.cancel = () => clearTimeout(timer);
  return run;
}

export function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

export class InvalidatedReadError extends Error {
  constructor() { super('Leitura invalidada. Tente novamente.'); this.name = 'InvalidatedReadError'; }
}

export function createReadCache() {
  let generation = 0;
  const completed = new Set();
  const pending = new Map();
  return {
    has: key => completed.has(key),
    invalidate() {
      generation++;
      completed.clear();
      pending.clear();
    },
    async get(key, read, apply) {
      if (completed.has(key)) return;
      if (pending.has(key)) return pending.get(key);
      const started = generation;
      const request = Promise.resolve().then(read).then(value => {
        if (generation !== started) throw new InvalidatedReadError();
        apply(value);
        completed.add(key);
      }).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
      pending.set(key, request);
      return request;
    }
  };
}

// Keep the existing scrolling layout while mounting only nearby card groups.
// Expanded details survive unmounting; the measured spacer preserves position.
export function renderWindowedBlocks(container, blocks) {
  container._windowCleanup?.();
  container.replaceChildren();
  if (!('IntersectionObserver' in window) || blocks.length <= 2) {
    container.innerHTML = blocks.map(block => block.html()).join('');
    return;
  }
  const mounted = new Map();
  const expanded = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const element = entry.target;
      const index = Number(element.dataset.windowBlock);
      if (entry.isIntersecting && !mounted.has(index)) {
        element.style.minHeight = '';
        element.innerHTML = blocks[index].html();
        element.querySelectorAll('details').forEach((details, i) => { details.open = expanded.get(index)?.has(i) || false; });
        mounted.set(index, element);
      } else if (!entry.isIntersecting && mounted.has(index) && !element.contains(document.activeElement)) {
        const height = element.getBoundingClientRect().height;
        expanded.set(index, new Set([...element.querySelectorAll('details')].flatMap((details, i) => details.open ? [i] : [])));
        element.style.minHeight = `${height}px`;
        element.replaceChildren();
        mounted.delete(index);
      }
    }
  }, { rootMargin:'1200px 0px' });
  blocks.forEach((block, index) => {
    const element = document.createElement('div');
    element.dataset.windowBlock = index;
    element.style.display = 'flow-root';
    element.style.minHeight = `${block.height}px`;
    container.append(element);
    observer.observe(element);
  });
  container._windowCleanup = () => observer.disconnect();
}

export function renderWindowedTable(body, rows, rowHtml, emptyHtml, bind) {
  body._windowCleanup?.();
  if (rows.length <= 100 || !('IntersectionObserver' in window)) {
    body.innerHTML = rows.map(rowHtml).join('') || emptyHtml;
    bind();
    return;
  }
  const slots = [];
  const mounted = new Set();
  const columns = body.closest('table').querySelector('thead tr')?.children.length || 10;
  const placeholder = height => `<tr aria-hidden="true"><td colspan="${columns}" style="padding:0;border:0;height:${height}px"></td></tr>`;
  const mount = index => {
    const slot = slots[index];
    slot.innerHTML = rows.slice(index * 40, index * 40 + 40).map(rowHtml).join('');
    mounted.add(index);
    bind();
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const slot = entry.target, index = slots.indexOf(slot);
      if (entry.isIntersecting && !mounted.has(index)) mount(index);
      else if (!entry.isIntersecting && index > 0 && mounted.has(index) && !slot.contains(document.activeElement)) {
        slot.innerHTML = placeholder(slot.getBoundingClientRect().height);
        mounted.delete(index);
      }
    }
  }, { rootMargin:'1000px 0px' });
  for (let offset = 0; offset < rows.length; offset += 40) {
    const slot = offset ? document.createElement('tbody') : body;
    if (offset) {
      slot.className = body.className;
      slots.at(-1).after(slot);
    }
    slots.push(slot);
    slot.innerHTML = placeholder(Math.min(40, rows.length - offset) * 70);
    observer.observe(slot);
  }
  mount(0);
  body._windowCleanup = () => {
    observer.disconnect();
    slots.slice(1).forEach(slot => slot.remove());
  };
}

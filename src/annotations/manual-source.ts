const sources = new WeakSet<Element>();
export function bindDetachedMarkdownSource(root: Element): void { sources.add(root); }
export function isDetachedMarkdownSelection(element: Element): boolean { for (let current: Element | null = element; current; current = current.parentElement) if (sources.has(current)) return true; return false; }

// Finds a page element by selector. It stops the start-up when the page has no such element of that type.
export function element<T extends Element>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`missing element ${selector}`);
  return found;
}

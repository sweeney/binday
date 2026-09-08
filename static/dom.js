// dom.js — a four-line element builder.
//
// Everything on screen is built through `el`, never through innerHTML.
// Council bin labels and descriptions are config data, and config is edited
// by hand; setting them as text nodes means an ampersand in a description
// can never become markup, and there is no escaping helper to forget to
// call.
//
// Custom properties (the bin colours) are set through the CSSOM rather than
// a style attribute, which the page's `style-src 'self'` policy would block.

/**
 * el('div.row', { text, title, on: { click } , vars: { '--bin': '#fff' } }, children)
 *
 * The tag string takes an optional dotted class list: 'p.count.is-today'.
 */
export function el(tag, options = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');

  const { text, vars, on, ...attributes } = options;

  if (text !== undefined) node.textContent = text;

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const [property, value] of Object.entries(vars || {})) {
    node.style.setProperty(property, value);
  }

  for (const [event, listener] of Object.entries(on || {})) {
    node.addEventListener(event, listener);
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }

  return node;
}

/** Replace everything inside `parent` with `children`. */
export function replace(parent, children) {
  parent.replaceChildren(...[].concat(children).filter(Boolean));
}

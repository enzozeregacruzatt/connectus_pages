'use strict';

// DOM mínimo para correr public/app.js en Node: solo lo que ese archivo usa. No imita un navegador; la CSP y el pintado
// real se revisan en uno de verdad.

const ID_TAG = /<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g;
const FORM_BLOCK = /<form\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g;
const FIELD_TAG = /<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g;
const ANY_TAG = /<(\/?)([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/g;
const ID_ATTRIBUTE = /\bid="([^"]+)"/;
const VOID_TAGS = new Set(['input', 'link', 'meta']);

class FakeElement {
  constructor(document, tag, id = null, namespace = null) {
    this.document = document;
    this.tag = tag;
    this.id = id;
    this.namespace = namespace;
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.formFields = null;
    this.ownText = '';
    this.ownValue = null;
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(text) {
    this.children = [];
    this.ownText = String(text);
  }

  // Un select sin selección explícita vale lo que su primera opción.
  get value() {
    if (this.tag === 'select' && this.ownValue === null) return this.children[0]?.value ?? '';
    return this.ownValue ?? '';
  }

  set value(value) {
    this.ownValue = String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.ownText = '';
    this.children = [];
    this.append(...nodes);
    if (this.tag === 'select') this.ownValue = null;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  // Como un clic de verdad: un <a> queda anotado, porque es lo único que inicia una descarga.
  click() {
    if (this.tag === 'a') this.document.anchorClicks.push({ href: this.href, download: this.download, rel: this.rel });
    this.fire('click');
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  // Como en un navegador: lo que está oculto, o dentro de algo oculto, no recibe el foco y no avisa.
  focus() {
    for (let element = this; element; element = element.parent) {
      if (element.hidden) return;
    }
    this.document.activeElement = this;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  fire(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  reset() {
    for (const field of this.formFields || []) field.ownValue = null;
  }
}

function linkParents(html, document) {
  const open = [];
  for (const [, closing, tag, attributes, selfClosed] of html.matchAll(ANY_TAG)) {
    if (closing) {
      open.pop();
      continue;
    }
    const element = document.elements.get(ID_ATTRIBUTE.exec(attributes)?.[1]);
    if (element) element.parent = open.findLast(Boolean) ?? null;
    if (!selfClosed && !VOID_TAGS.has(tag)) open.push(element ?? null);
  }
}

// Los elementos salen de index.html: un id que app.js pida y no exista falla aquí mismo.
function createFakeDocument(html) {
  const document = {
    activeElement: null,
    hidden: false,
    elements: new Map(),
    anchorClicks: [],
    listeners: new Map(),
    createElement: (tag) => new FakeElement(document, tag),
    createElementNS: (namespace, tag) => new FakeElement(document, tag, null, namespace),
    addEventListener(type, listener) {
      document.listeners.set(type, [...(document.listeners.get(type) || []), listener]);
    },
    fire(type) {
      for (const listener of document.listeners.get(type) || []) listener({ type, target: document });
    },
    getElementById(id) {
      const element = document.elements.get(id);
      if (!element) throw new Error(`index.html no tiene el id ${id}`);
      return element;
    },
  };
  for (const [openingTag, tag, id] of html.matchAll(ID_TAG)) {
    const element = new FakeElement(document, tag, id);
    element.hidden = /\shidden[\s>]/.test(openingTag);
    document.elements.set(id, element);
  }
  for (const [, formId, body] of html.matchAll(FORM_BLOCK)) {
    const fieldIds = [...body.matchAll(FIELD_TAG)].map((match) => match[1]);
    document.elements.get(formId).formFields = fieldIds.map((id) => document.elements.get(id));
  }
  linkParents(html, document);
  return document;
}

module.exports = { createFakeDocument };

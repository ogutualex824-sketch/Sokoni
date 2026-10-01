/* mini-dom.js — the smallest DOM that lets a node test DRIVE a component built with createElement / textContent /
 * setAttribute / addEventListener (sokoni-report-wizard.js) and inspect what it rendered. It is NOT a browser:
 * no layout, no CSS, no HTML parser (an innerHTML assignment is stored as a string and searchable, nothing more).
 * What it proves is the component's LOGIC and its accessible structure; rendering is the browser cert's job.
 *
 *   const { makeDocument } = require('./lib/mini-dom');
 *   const document = makeDocument();
 *   selectors: tag, #id, .class, [attr], [attr="v"], compounds of those, and comma lists.
 */
'use strict';

function makeDocument() {
  const listenersOf = new WeakMap();
  function on(node, type, fn, capture) {
    let m = listenersOf.get(node); if (!m) { m = []; listenersOf.set(node, m); }
    m.push({ type, fn, capture: !!capture });
  }
  function off(node, type, fn) {
    const m = listenersOf.get(node); if (!m) return;
    const i = m.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) m.splice(i, 1);
  }
  function fire(node, ev) {
    (listenersOf.get(node) || []).filter((l) => l.type === ev.type).slice().forEach((l) => { ev.currentTarget = node; l.fn.call(node, ev); });
  }

  class Node {
    constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild(new Text(this.ownerDocument, String(v))); }
    addEventListener(t, fn, cap) { on(this, t, fn, cap); }
    removeEventListener(t, fn) { off(this, t, fn); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }
  class Text extends Node {
    constructor(doc, data) { super(doc); this.data = data; this.nodeType = 3; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }
  class Element extends Node {
    constructor(doc, tag) {
      super(doc); this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.attributes = {}; this.style = {};
      this._value = ''; this._checked = false; this._html = null;
    }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'value') this._value = String(v); if (k === 'checked') this._checked = true; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
    removeAttribute(k) { delete this.attributes[k]; }
    get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
    get disabled() { return this.hasAttribute('disabled'); } set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    get checked() { return this._checked; } set checked(v) { this._checked = !!v; }
    get innerHTML() { return this._html != null ? this._html : this.textContent; }
    set innerHTML(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._html = String(v) || null; }
    get offsetParent() { const b = this.ownerDocument.body; return b.contains(this) && !this.hidden ? b : null; }
    focus() { this.ownerDocument.activeElement = this; }
    click() { this.dispatchEvent({ type: 'click' }); }
    closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, sel)) return x; return null; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && matches(n, sel)) out.push(n); }); return out; }
    dispatchEvent(ev) {
      ev.target = ev.target || this; let stop = false;
      ev.preventDefault = ev.preventDefault || (() => { ev.defaultPrevented = true; });
      ev.stopPropagation = () => { stop = true; };
      const path = []; for (let x = this; x; x = x.parentNode) path.push(x);
      path.push(this.ownerDocument);
      for (const n of path) { fire(n, ev); if (stop) break; }
      return true;
    }
  }
  function walk(n, fn) { fn(n); (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) walk(c, fn); }); }
  function matchOne(n, s) {
    s = s.trim(); if (!s) return false;
    const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m, consumed = 0;
    while ((m = re.exec(s))) {
      if (m.index !== consumed) return false; consumed = re.lastIndex;
      if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
      if (m[2] && n.id !== m[2]) return false;
      if (m[3] && !n.className.split(/\s+/).includes(m[3])) return false;
      if (m[4] && (!n.hasAttribute(m[4]) || (m[5] !== undefined && n.getAttribute(m[4]) !== m[5]))) return false;
    }
    return consumed === s.length;
  }
  function matches(n, sel) { return n.nodeType === 1 && String(sel).split(',').some((s) => matchOne(n, s)); }

  const doc = {
    nodeType: 9, activeElement: null,
    createElement: (t) => new Element(doc, t),
    createTextNode: (d) => new Text(doc, d),
    getElementById: (id) => { let hit = null; walk(doc.documentElement, (n) => { if (!hit && n.id === id) hit = n; }); return hit; },
    querySelector: (s) => doc.documentElement.querySelector(s),
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    addEventListener: (t, fn, cap) => on(doc, t, fn, cap),
    removeEventListener: (t, fn) => off(doc, t, fn),
    /* dispatch a key event the way a browser does: capture listeners on document first, then the target */
    key: (key, opts) => { const ev = Object.assign({ type: 'keydown', key, target: doc.activeElement || doc.body }, opts || {});
      ev.preventDefault = () => { ev.defaultPrevented = true; }; fire(doc, ev); return ev; },
  };
  doc.documentElement = new Element(doc, 'html');
  doc.head = doc.documentElement.appendChild(new Element(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new Element(doc, 'body'));
  doc.activeElement = doc.body;
  return doc;
}

module.exports = { makeDocument };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

function extractFunction(source, functionName) {
  const sourceFile = ts.createSourceFile('game.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(found, `${functionName} should exist in source`);
  return source.slice(found.getStart(sourceFile), found.end);
}

function loadMakeCustomDropdown() {
  const gameSourcePath = process.env.GAME_TS_PATH
    || path.join(__dirname, '..', 'public', 'game.ts');
  const source = fs.readFileSync(gameSourcePath, 'utf8');
  const functionSource = extractFunction(source, 'makeCustomDropdown');
  const harnessSource = `
    const allDropdowns = [];
    function closeAllDropdowns() {
      allDropdowns.forEach(dd => {
        if (dd.menu.style.display !== 'none') {
          dd.menu.style.display = 'none';
          dd.onClose();
        }
      });
    }
    ${functionSource}
    module.exports = { makeCustomDropdown };
  `;

  const transpiled = ts.transpileModule(harnessSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const document = new FakeDocument();
  const sandbox = {
    module: { exports: {} },
    exports: {},
    document,
    window: { innerHeight: 600 },
    Math,
  };
  vm.runInNewContext(transpiled, sandbox, { filename: 'makeCustomDropdown.test-harness.js' });
  return { makeCustomDropdown: sandbox.module.exports.makeCustomDropdown, document };
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.listeners = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this.value = '';
    this.title = '';
    this.scrollHeight = 0;
    this._innerHTML = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, referenceNode) {
    child.parentNode = this;
    const index = this.children.indexOf(referenceNode);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  click() {
    for (const callback of this.listeners.get('click') || []) {
      callback({ stopPropagation() {} });
    }
  }

  removeAttribute(name) {
    delete this[name];
  }

  getBoundingClientRect() {
    return { bottom: 20, top: 0, left: 10, width: 160 };
  }
}

test('custom dropdown resumes after selecting a WPM option', () => {
  const { makeCustomDropdown } = loadMakeCustomDropdown();
  const select = new FakeElement('select');
  const parent = new FakeElement('div');
  parent.appendChild(select);

  const calls = [];
  const dropdown = makeCustomDropdown(
    select,
    [
      { text: '30', value: '30' },
      { text: '60', value: '60' },
    ],
    '30',
    (value) => calls.push(`change:${value}`),
    () => calls.push('open'),
    () => calls.push('close'),
  );

  assert.deepEqual(calls, [], 'initial silent selection must not pause/resume or restart');

  dropdown.trigger.click();
  assert.equal(dropdown.menu.style.display, 'block');
  assert.deepEqual(calls, ['open']);

  dropdown.menu.children[1].click();

  assert.equal(select.value, '60');
  assert.equal(dropdown.menu.style.display, 'none');
  assert.deepEqual(calls, ['open', 'change:60', 'close']);
});

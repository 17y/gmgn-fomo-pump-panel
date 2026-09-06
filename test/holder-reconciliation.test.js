const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Minimal DOM models reparenting explicitly: equality alone misses detach/reinsert.
function fixture(names) {
  const removed = [];
  const container = {children: [], insertBefore(node, before) {
    if (node.parent) node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, node); node.parent = this;
  }, get lastElementChild() {return this.children.at(-1);}};
  function node(name) {return {name, parent: null, remove() {
    if (!this.parent) return;
    removed.push(this.name);
    this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null;
  }};}
  names.forEach(name => container.insertBefore(node(name), null));
  return {container, node, removed};
}
for (const file of ['content.js', 'sidepanel.js']) {
  const source = fs.readFileSync(`src/${file}`, 'utf8');
  const c = vm.createContext({Set, Array});
  vm.runInContext(source.slice(source.indexOf('  function updateHolderContent('),
    source.indexOf('  function updateHolderCard(')), c);
  test(`${file}: changing summary leaves all holders continuously attached`, () => {
    const h = fixture(['summary', 'alice', 'bob', 'pump']);
    const cards = h.container.children.slice(1);
    c.updateHolderContent(h.container, [h.node('new-summary'), ...cards]);
    assert.deepEqual(h.removed, ['summary']);
    assert.deepEqual(h.container.children.slice(1), cards);
  });
  test(`${file}: removal, ordering, insertion and empty state stay correct`, () => {
    const h = fixture(['summary', 'alice', 'bob', 'pump']);
    const [summary, alice, bob, pump] = h.container.children;
    c.updateHolderContent(h.container, [summary, bob, pump]);
    assert.deepEqual(h.removed, ['alice'], 'removing one user must not reparent survivors');
    c.updateHolderContent(h.container, [summary, pump, bob, alice]);
    assert.deepEqual(h.container.children.map(n => n.name), ['summary', 'pump', 'bob', 'alice']);
    c.updateHolderContent(h.container, [summary, h.node('empty')]);
    assert.deepEqual(h.container.children.map(n => n.name), ['summary', 'empty']);
  });
}

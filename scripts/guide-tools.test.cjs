const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

function load() {
  const window = {};
  const context = vm.createContext({window, console});
  vm.runInContext(readFileSync(join(__dirname, '..', 'guides', 'tools.js'), 'utf8'), context);
  return window.PixelPressGuides;
}

test('fitDims preserves aspect ratio and never upscales', () => {
  const api = load();
  const fit = api.fitDims(6000, 4000, 600, 450);
  assert.deepEqual({width: fit.width, height: fit.height}, {width: 600, height: 400});
  const small = api.fitDims(320, 240, 1600, 1200);
  assert.deepEqual({width: small.width, height: small.height}, {width: 320, height: 240});
  const tall = api.fitDims(300, 1200, 600, 450);
  assert.deepEqual({width: tall.width, height: tall.height}, {width: 113, height: 450});
});

test('fitDims rejects impossible dimensions', () => {
  const api = load();
  assert.throws(() => api.fitDims(0, 100, 600, 450));
  assert.throws(() => api.fitDims(100, -1, 600, 450));
});

test('bitsPerPixel matches the 20KB target arithmetic', () => {
  const api = load();
  assert.equal(Math.round(api.bitsPerPixel(20480, 600, 450) * 1000) / 1000, 0.607);
  assert.equal(api.bitsPerPixel(102400, 600, 600), 2.2755555555555556);
  assert.throws(() => api.bitsPerPixel(-1, 600, 450));
});

test('print size and pixel conversions agree', () => {
  const api = load();
  const printed = api.printSize(600, 300);
  assert.equal(printed.inches, 2);
  assert.equal(Math.round(printed.cm * 100) / 100, 5.08);
  assert.equal(api.pixelsForPrint(2, 300), 600);
  assert.equal(api.pixelsForPrint(35 / 25.4, 300), 413);
  assert.throws(() => api.printSize(600, 0));
});

test('upload budget removes overhead and reserved space', () => {
  const api = load();
  const plain = api.uploadBudget(500, 5, 0, 10);
  assert.equal(plain.usableKB, 490);
  assert.equal(plain.perFileKB, 98);
  const email = api.uploadBudget(25600, 10, 33, 500);
  assert.equal(Math.round(email.usableKB * 10) / 10, 16652);
  assert.equal(Math.round(email.perFileKB * 10) / 10, 1665.2);
  assert.equal(email.perFileBytes, Math.floor(email.perFileKB * 1024));
  assert.throws(() => api.uploadBudget(0, 5, 0, 0));
  assert.throws(() => api.uploadBudget(500, 0, 0, 0));
});

test('messages are localized and interpolate values', () => {
  const api = load();
  assert.match(api.message('en', 'hit', {size: '19.4 KB', w: 500, h: 375}), /19\.4 KB at 500×375/);
  assert.match(api.message('zh', 'hit', {size: '19.4 KB', w: 500, h: 375}), /已达到目标/);
  assert.equal(api.message('zh', 'missing_key'), 'missing_key');
});

test('presets keep the homepage byte targets', () => {
  const api = load();
  assert.equal(api.PRESETS['20kb'].bytes, 20480);
  assert.equal(api.PRESETS['50kb'].bytes, 51200);
  assert.equal(api.PRESETS['100kb'].bytes, 102400);
  assert.equal(api.PRESETS['2mb'].bytes, 2097152);
  assert.equal(api.fmtBytes(20480), '20.0 KB');
});

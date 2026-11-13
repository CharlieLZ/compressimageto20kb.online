const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesWith(magic, size) {
  const bytes = new Uint8Array(Math.max(size, magic.length));
  bytes.set(magic);
  return bytes;
}

function fakeFile(bytes, {name = 'photo.jpg', type = 'image/jpeg'} = {}) {
  return {
    name,
    type,
    size: bytes.length,
    slice(start, end) {
      const part = bytes.slice(start, end);
      return {arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)};
    }
  };
}

function load(options = {}) {
  const calls = {bitmap: [], canvas: [], ctx: []};
  const context = {
    window: {},
    console,
    Uint8Array,
    ArrayBuffer,
    Blob,
    setTimeout,
    clearTimeout,
    URL: {
      createObjectURL() {
        if (options.decodeFails) throw new Error('decode');
        return 'blob:test';
      },
      revokeObjectURL() {}
    },
    Image: class {
      set src(value) {
        setTimeout(() => this.onerror && this.onerror(new Error('decode')), 0);
      }
    },
    HTMLCanvasElement: {prototype: {toBlob() {}}},
    document: {
      readyState: 'complete',
      documentElement: {lang: options.lang || 'en'},
      addEventListener() {},
      querySelectorAll() { return []; },
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const ctx = {
          fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
          fillRect(...args) { calls.ctx.push(['fillRect', this.fillStyle, ...args]); },
          drawImage(...args) { calls.ctx.push(['drawImage', ...args]); }
        };
        const canvas = {
          width: 0,
          height: 0,
          getContext(kind, attrs) { calls.ctx.push(['getContext', kind, attrs]); return ctx; },
          toBlob(callback, type, quality) {
            const size = options.encodeSize
              ? options.encodeSize(canvas.width, canvas.height, quality)
              : Math.max(800, Math.min(18000, Math.round(canvas.width * canvas.height * quality * 0.08)));
            calls.canvas.push({width: canvas.width, height: canvas.height, quality, size});
            callback(new Blob([bytesWith(JPEG, size)], {type: 'image/jpeg'}));
          }
        };
        return canvas;
      }
    }
  };
  context.createImageBitmap = async (file, opts) => {
    calls.bitmap.push({file, opts});
    if (options.decodeFails) throw new Error('decode');
    return {width: options.width || 1200, height: options.height || 900, close() {}};
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname, '..', 'guides', 'tools.js'), 'utf8'), context);
  return {api: context.window.PixelPressGuides, calls, context};
}

test('fitDims preserves aspect ratio and never upscales', () => {
  const {api} = load();
  const fit = api.fitDims(6000, 4000, 600, 450);
  assert.deepEqual({width: fit.width, height: fit.height}, {width: 600, height: 400});
  const small = api.fitDims(320, 240, 1600, 1200);
  assert.deepEqual({width: small.width, height: small.height}, {width: 320, height: 240});
  const tall = api.fitDims(300, 1200, 600, 450);
  assert.deepEqual({width: tall.width, height: tall.height}, {width: 113, height: 450});
});

test('fitDims rejects impossible dimensions', () => {
  const {api} = load();
  assert.throws(() => api.fitDims(0, 100, 600, 450));
  assert.throws(() => api.fitDims(100, -1, 600, 450));
});

test('bitsPerPixel matches the 20KB target arithmetic', () => {
  const {api} = load();
  assert.equal(Math.round(api.bitsPerPixel(20480, 600, 450) * 1000) / 1000, 0.607);
  assert.equal(api.bitsPerPixel(102400, 600, 600), 2.2755555555555556);
  assert.throws(() => api.bitsPerPixel(-1, 600, 450));
});

test('print size and pixel conversions agree', () => {
  const {api} = load();
  const printed = api.printSize(600, 300);
  assert.equal(printed.inches, 2);
  assert.equal(Math.round(printed.cm * 100) / 100, 5.08);
  assert.equal(api.pixelsForPrint(2, 300), 600);
  assert.equal(api.pixelsForPrint(35 / 25.4, 300), 413);
  assert.throws(() => api.printSize(600, 0));
});

test('upload budget removes overhead and reserved space', () => {
  const {api} = load();
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
  const {api} = load();
  assert.match(api.message('en', 'hit', {size: '19.4 KB', w: 500, h: 375}), /19\.4 KB at 500×375/);
  assert.match(api.message('zh', 'hit', {size: '19.4 KB', w: 500, h: 375}), /已达到目标/);
  assert.match(api.message('zh', 'progress', {n: 3, w: 420, h: 315}), /正在压缩第 3 轮（420×315）/);
  assert.doesNotMatch(api.message('zh', 'progress', {n: 3, w: 420, h: 315}), /Compressing/);
  assert.match(api.message('zh', 'overhead'), /没有剩余字节/);
  assert.match(api.message('en', 'already', {target: '20KB', size: '12 KB'}), /metadata is preserved/);
  assert.equal(api.message('zh', 'missing_key'), 'missing_key');
});

test('presets keep the homepage byte targets', () => {
  const {api} = load();
  assert.equal(api.PRESETS['20kb'].bytes, 20480);
  assert.equal(api.PRESETS['50kb'].bytes, 51200);
  assert.equal(api.PRESETS['100kb'].bytes, 102400);
  assert.equal(api.PRESETS['2mb'].bytes, 2097152);
  assert.equal(api.fmtBytes(20480), '20.0 KB');
});

test('byte signatures are detected without trusting name or MIME', () => {
  const {api} = load();
  assert.equal(api.detectImageFormat(Uint8Array.from(JPEG)), 'jpeg');
  assert.equal(api.detectImageFormat(Uint8Array.from(PNG)), 'png');
  assert.equal(api.detectImageFormat(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp');
  assert.equal(api.detectImageFormat(Uint8Array.from([0x47, 0x49, 0x46, 0x38])), 'gif');
  assert.equal(api.detectImageFormat(Uint8Array.from([0x00, 0x01, 0x02])), '');
});

test('a small PNG renamed .jpg is re-encoded to real JPEG bytes, not passed through', async () => {
  const {api, calls} = load();
  const file = fakeFile(bytesWith(PNG, 12000), {name: 'small-renamed.jpg', type: 'image/jpeg'});
  const out = await api.compressJpg(file, '20kb');
  assert.equal(out.already, false);
  assert.equal(out.hit, true);
  assert.equal(out.converted, true);
  assert.equal(out.sourceFormat, 'png');
  assert.notEqual(out.blob, file);
  assert.deepEqual([...new Uint8Array(await out.blob.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(out.blob.size <= 20480);
  assert.equal(calls.bitmap[0].opts.imageOrientation, 'from-image');
});

test('a genuine JPEG already under target is returned byte-identical without re-encoding', async () => {
  const {api, calls} = load();
  const file = fakeFile(bytesWith(JPEG, 10000));
  const out = await api.compressJpg(file, '20kb');
  assert.equal(out.blob, file);
  assert.equal(out.already, true);
  assert.equal(out.hit, true);
  assert.equal(out.converted, false);
  assert.equal(calls.bitmap.length, 1);
  assert.equal(calls.canvas.length, 0);
});

test('spoofed MIME and a corrupt non-JPEG fail instead of reporting success', async () => {
  const {api} = load({decodeFails: true});
  const spoofed = fakeFile(bytesWith(PNG, 12000), {name: 'photo.jpg', type: 'image/jpeg'});
  await assert.rejects(() => api.compressJpg(spoofed, '20kb'), /type/);
  const corruptJpeg = fakeFile(bytesWith(JPEG, 12000), {name: 'photo.jpg', type: 'image/jpeg'});
  await assert.rejects(() => api.compressJpg(corruptJpeg, '20kb'), /decode/);
  const text = fakeFile(new TextEncoder().encode('not an image at all'), {name: 'photo.jpg', type: 'image/jpeg'});
  await assert.rejects(() => api.compressJpg(text, '20kb'), /type/);
});

test('a target miss reports the smallest real JPEG with hit=false', async () => {
  const {api} = load({encodeSize: () => 25000});
  const out = await api.compressJpg(fakeFile(bytesWith(JPEG, 90000)), '20kb');
  assert.equal(out.hit, false);
  assert.equal(out.already, false);
  assert.equal(out.attempts, 56);
  assert.ok(out.blob.size > 20480);
  assert.deepEqual([...new Uint8Array(await out.blob.arrayBuffer()).slice(0, 3)], [0xff, 0xd8, 0xff]);
});

test('files over 50 MB and non-images are rejected before any encoding', async () => {
  const {api, calls} = load();
  const huge = {name: 'huge.jpg', type: 'image/jpeg', size: 50 * 1024 * 1024 + 1, slice() { throw new Error('should not read'); }};
  await assert.rejects(() => api.compressJpg(huge, '20kb'), /big/);
  await assert.rejects(() => api.compressJpg(null, '20kb'), /type/);
  assert.equal(calls.canvas.length, 0);
});

test('alpha is flattened onto white and progress is localized mid-run', async () => {
  const {api, calls} = load({lang: 'zh'});
  const messages = [];
  const file = fakeFile(bytesWith(PNG, 30000), {name: 'alpha.png', type: 'image/png'});
  let seen = 0;
  const out = await api.compressJpg(file, '20kb', (text) => {
    messages.push(text);
    seen++;
  }, 'zh');
  assert.equal(out.hit, true);
  assert.equal(messages.length, seen);
  assert.ok(messages.length > 0);
  assert.match(messages[0], /^正在压缩第 1 轮（600×450）/);
  assert.ok(messages.every((text) => !/Compressing/.test(text)));
  const matte = calls.ctx.find((call) => call[0] === 'fillRect');
  assert.deepEqual(matte.slice(0, 2), ['fillRect', '#fff']);
});

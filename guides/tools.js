/* PixelPress guide tools: real in-browser compression, print-size math and upload budgets.
   No uploads, no tracking identifiers. Exposes pure helpers for tests via window.PixelPressGuides. */
(function (root) {
  'use strict';

  var PRESETS = {
    '10kb': {label: '10KB', bytes: 10240, maxW: 420, maxH: 315},
    '20kb': {label: '20KB', bytes: 20480, maxW: 600, maxH: 450},
    '30kb': {label: '30KB', bytes: 30720, maxW: 800, maxH: 600},
    '40kb': {label: '40KB', bytes: 40960, maxW: 980, maxH: 735},
    '50kb': {label: '50KB', bytes: 51200, maxW: 1200, maxH: 900},
    '100kb': {label: '100KB', bytes: 102400, maxW: 1600, maxH: 1200},
    '200kb': {label: '200KB', bytes: 204800, maxW: 2200, maxH: 1650},
    '500kb': {label: '500KB', bytes: 512000, maxW: 3200, maxH: 2400},
    '1mb': {label: '1MB', bytes: 1048576, maxW: null, maxH: null},
    '2mb': {label: '2MB', bytes: 2097152, maxW: null, maxH: null}
  };
  var MAX_INPUT_BYTES = 50 * 1024 * 1024;
  var MAX_CANVAS_EDGE = 6000;

  var MESSAGES = {
    en: {
      working: 'Compressing in this browser…',
      progress: 'Compressing pass {n} ({w}×{h})…',
      hit: 'Target reached: {size} at {w}×{h}.',
      hitConverted: 'Target reached: {size} at {w}×{h}. Converted from {format} to real JPEG bytes.',
      miss: 'Closest clean result: {size} at {w}×{h}. This image resists the {target} target without visible damage.',
      already: 'Already under {target}: {size}. Genuine JPEG kept unchanged; its metadata is preserved.',
      type: 'This file is not a JPEG and could not be opened. Choose a JPG/JPEG, or a PNG/WebP file this browser can convert.',
      big: 'That file is larger than 50 MB. Use the homepage compressor for files up to 50 MB, or resize the photo first.',
      decode: 'This browser could not open that JPG. Try another file or a different browser.',
      encode: 'JPEG export is unavailable in this browser. Use a current Chrome, Edge, Firefox or Safari.',
      download: 'Download {size} JPG',
      dpi: 'Enter pixel dimensions and a DPI value between 1 and 2400.',
      print: 'Enter a print size and a DPI value between 1 and 2400.',
      budget: 'Enter a positive limit and at least one file.',
      overhead: 'Overhead and reserved space exceed the limit; no bytes are left for files.'
    },
    zh: {
      working: '正在浏览器本地压缩……',
      progress: '正在压缩第 {n} 轮（{w}×{h}）……',
      hit: '已达到目标：{size}，尺寸 {w}×{h}。',
      hitConverted: '已达到目标：{size}，尺寸 {w}×{h}。已由 {format} 转换为真正的 JPEG 字节。',
      miss: '最接近的清晰结果：{size}，尺寸 {w}×{h}。这张图片在不明显损坏画质的前提下难以压到 {target}。',
      already: '已小于 {target}：{size}。这是真正的 JPEG，原文件保持不变，元数据也保留。',
      type: '这个文件不是 JPEG，也无法打开。请选择 JPG/JPEG，或浏览器能够转换的 PNG/WebP 文件。',
      big: '文件超过 50 MB。请先缩小照片，或使用首页压缩器处理 50 MB 以内的文件。',
      decode: '浏览器无法打开这张 JPG，请换一个文件或浏览器重试。',
      encode: '当前浏览器不支持导出 JPEG，请使用最新版 Chrome、Edge、Firefox 或 Safari。',
      download: '下载 {size} 的 JPG',
      dpi: '请输入像素尺寸，以及 1 到 2400 之间的 DPI。',
      print: '请输入打印尺寸，以及 1 到 2400 之间的 DPI。',
      budget: '请输入正数上限和至少一个文件。',
      overhead: '开销和预留空间已经超过上限，没有剩余字节分给文件。'
    }
  };

  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 102400 ? 1 : 0) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function fitDims(width, height, maxW, maxH) {
    if (!(width > 0) || !(height > 0)) throw new Error('width and height must be positive');
    var scale = 1;
    if (maxW && maxH) scale = Math.min(1, maxW / width, maxH / height);
    scale = Math.min(scale, MAX_CANVAS_EDGE / width, MAX_CANVAS_EDGE / height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale: scale
    };
  }

  function bitsPerPixel(bytes, width, height) {
    if (!(bytes >= 0) || !(width > 0) || !(height > 0)) throw new Error('invalid dimensions');
    return (bytes * 8) / (width * height);
  }

  function printSize(pixels, dpi) {
    if (!(pixels > 0) || !(dpi > 0)) throw new Error('pixels and dpi must be positive');
    var inches = pixels / dpi;
    return {inches: inches, cm: inches * 2.54, mm: inches * 25.4};
  }

  function pixelsForPrint(inches, dpi) {
    if (!(inches > 0) || !(dpi > 0)) throw new Error('inches and dpi must be positive');
    return Math.max(1, Math.round(inches * dpi));
  }

  function uploadBudget(limitKB, files, overheadPct, reservedKB) {
    var limit = Number(limitKB);
    var count = Math.floor(Number(files));
    var overhead = Number(overheadPct) || 0;
    var reserved = Number(reservedKB) || 0;
    if (!(limit > 0) || !(count >= 1) || overhead < 0 || reserved < 0) throw new Error('invalid budget input');
    var usableKB = limit * (1 - overhead / 100) - reserved;
    if (!(usableKB > 0)) return {usableKB: usableKB, perFileKB: 0, perFileBytes: 0};
    var perFileKB = usableKB / count;
    return {usableKB: usableKB, perFileKB: perFileKB, perFileBytes: Math.floor(perFileKB * 1024)};
  }

  function message(lang, key, vars) {
    var table = MESSAGES[lang === 'zh' ? 'zh' : 'en'];
    var text = table[key] || MESSAGES.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (name) {
      text = text.replace('{' + name + '}', vars[name]);
    });
    return text;
  }

  function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, {imageOrientation: 'from-image'}).then(function (bitmap) {
        return {source: bitmap, width: bitmap.width, height: bitmap.height, close: function () { if (bitmap.close) bitmap.close(); }};
      }).catch(function () { return loadImageElement(file); });
    }
    return loadImageElement(file);
  }

  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var width = img.naturalWidth || img.width;
        var height = img.naturalHeight || img.height;
        URL.revokeObjectURL(url);
        if (width && height) resolve({source: img, width: width, height: height, close: function () {}});
        else reject(new Error('dimensions'));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };
      img.src = url;
    });
  }

  function encodeJpeg(image, width, height, quality) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      var ctx = canvas.getContext('2d', {alpha: false});
      if (!ctx) { reject(new Error('encode')); return; }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error('encode'));
      }, 'image/jpeg', quality);
    });
  }

  async function readHead(file) {
    if (!file || typeof file.slice !== 'function') return new Uint8Array(0);
    var head = file.slice(0, 12);
    if (!head || typeof head.arrayBuffer !== 'function') return new Uint8Array(0);
    try {
      return new Uint8Array(await head.arrayBuffer());
    } catch (error) {
      return new Uint8Array(0);
    }
  }

  function detectImageFormat(bytes) {
    if (!bytes || bytes.length < 3) return '';
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';
    return '';
  }

  function formatLabel(format) {
    return {jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', bmp: 'BMP'}[format] || 'image';
  }

  async function compressJpg(file, presetKey, onProgress, lang) {
    var preset = PRESETS[presetKey] || PRESETS['20kb'];
    if (!file) throw new Error('type');
    if (file.size > MAX_INPUT_BYTES) throw new Error('big');
    if (!HTMLCanvasElement.prototype.toBlob) throw new Error('encode');
    var format = detectImageFormat(await readHead(file));
    var genuineJpeg = format === 'jpeg';
    var image;
    try {
      image = await loadImage(file);
    } catch (error) {
      throw new Error(genuineJpeg ? 'decode' : 'type');
    }
    if (genuineJpeg && file.size <= preset.bytes * 0.98) {
      if (image.close) image.close();
      return {blob: file, width: 0, height: 0, already: true, hit: true, converted: false, sourceFormat: 'jpeg'};
    }
    try {
      var first = fitDims(image.width, image.height, preset.maxW, preset.maxH);
      var width = first.width;
      var height = first.height;
      var qualities = [0.82, 0.7, 0.58, 0.46, 0.34, 0.24, 0.16];
      var smallest = null;
      var attempts = 0;
      for (var round = 0; round < 8; round++) {
        for (var q = 0; q < qualities.length; q++) {
          attempts++;
          if (onProgress) onProgress(message(lang, 'progress', {n: attempts, w: width, h: height}));
          var blob = await encodeJpeg(image, width, height, qualities[q]);
          var candidate = {blob: blob, width: width, height: height, quality: qualities[q]};
          if (!smallest || blob.size < smallest.blob.size) smallest = candidate;
          if (blob.size <= preset.bytes) {
            return {blob: blob, width: width, height: height, already: false, hit: true, attempts: attempts,
              converted: !genuineJpeg, sourceFormat: format || 'unknown'};
          }
        }
        if (width <= 16 || height <= 16) break;
        width = Math.max(1, Math.floor(width * 0.82));
        height = Math.max(1, Math.floor(height * 0.82));
      }
      smallest.hit = false;
      smallest.attempts = attempts;
      smallest.already = false;
      smallest.converted = !genuineJpeg;
      smallest.sourceFormat = format || 'unknown';
      return smallest;
    } finally {
      if (image.close) image.close();
    }
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 1500);
  }

  function safeName(name, preset) {
    var base = String(name || 'compressed.jpg').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'compressed';
    return base.replace(/\s+/g, '-').toLowerCase() + '-' + (PRESETS[preset] || PRESETS['20kb']).label.toLowerCase() + '.jpg';
  }

  function setStatus(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = 'gtool-status' + (kind ? ' gtool-' + kind : '');
  }

  function activeLang() {
    var lang = (document.documentElement.lang || '').toLowerCase();
    return lang.indexOf('zh') === 0 ? 'zh' : 'en';
  }

  function initCompressor(box) {
    var lang = activeLang();
    var input = box.querySelector('[data-file]');
    var preset = box.querySelector('[data-preset]');
    var run = box.querySelector('[data-run]');
    var status = box.querySelector('[data-status]');
    var result = box.querySelector('[data-result]');
    var link = box.querySelector('[data-download]');
    if (!input || !preset || !run) return;
    var lastUrl = '';
    function reset() {
      if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = ''; }
      if (link) link.hidden = true;
      if (result) { result.hidden = true; }
    }
    input.addEventListener('change', function () {
      reset();
      var file = input.files && input.files[0];
      setStatus(status, file ? fmtBytes(file.size) + ' · ' + file.name : '', '');
    });
    run.addEventListener('click', async function () {
      var file = input.files && input.files[0];
      if (!file) { setStatus(status, message(lang, 'type'), 'error'); return; }
      reset();
      run.disabled = true;
      setStatus(status, message(lang, 'working'), '');
      try {
        var out = await compressJpg(file, preset.value, function (progress) { setStatus(status, progress, ''); }, lang);
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = URL.createObjectURL(out.blob);
        var label = out.blob.size > 0 ? fmtBytes(out.blob.size) : fmtBytes(file.size);
        if (link) {
          link.href = lastUrl;
          link.download = safeName(file.name, preset.value);
          link.textContent = message(lang, 'download', {size: label});
          link.hidden = false;
        }
        if (result) result.hidden = false;
        if (out.already) setStatus(status, message(lang, 'already', {target: PRESETS[preset.value].label, size: label}), 'ok');
        else if (out.hit) setStatus(status, message(lang, out.converted ? 'hitConverted' : 'hit', {size: label, w: out.width, h: out.height, format: formatLabel(out.sourceFormat)}), 'ok');
        else setStatus(status, message(lang, 'miss', {size: label, w: out.width, h: out.height, target: PRESETS[preset.value].label}), 'warn');
      } catch (error) {
        var key = error && error.message === 'type' ? 'type' : error && error.message === 'big' ? 'big' : error && error.message === 'encode' ? 'encode' : 'decode';
        setStatus(status, message(lang, key), 'error');
      } finally {
        run.disabled = false;
      }
    });
  }

  function initPrintSize(box) {
    var lang = activeLang();
    var width = box.querySelector('[data-px-w]');
    var height = box.querySelector('[data-px-h]');
    var dpi = box.querySelector('[data-dpi]');
    var run = box.querySelector('[data-run]');
    var output = box.querySelector('[data-output]');
    if (!width || !height || !dpi || !run || !output) return;
    run.addEventListener('click', function () {
      var w = Number(width.value);
      var h = Number(height.value);
      var d = Number(dpi.value);
      if (!(w > 0) || !(h > 0) || !(d >= 1 && d <= 2400)) {
        output.textContent = message(lang, 'dpi');
        output.className = 'gtool-status gtool-error';
        return;
      }
      var wi = printSize(w, d);
      var hi = printSize(h, d);
      var unit = lang === 'zh' ? '英寸' : 'in';
      var cmUnit = lang === 'zh' ? '厘米' : 'cm';
      output.textContent = w + ' × ' + h + ' px @ ' + d + ' DPI = ' +
        wi.inches.toFixed(2) + ' × ' + hi.inches.toFixed(2) + ' ' + unit + ' (' +
        wi.cm.toFixed(1) + ' × ' + hi.cm.toFixed(1) + ' ' + cmUnit + '). ' +
        (lang === 'zh' ? '网页按 CSS 像素显示时仍需另行设置宽度。' : 'A web page still needs its own CSS width; pixels alone do not set display size.');
      output.className = 'gtool-status';
    });
  }

  function initBudget(box) {
    var lang = activeLang();
    var limit = box.querySelector('[data-limit]');
    var files = box.querySelector('[data-files]');
    var overhead = box.querySelector('[data-overhead]');
    var reserved = box.querySelector('[data-reserved]');
    var run = box.querySelector('[data-run]');
    var output = box.querySelector('[data-output]');
    if (!limit || !files || !run || !output) return;
    run.addEventListener('click', function () {
      try {
        var budget = uploadBudget(limit.value, files.value, overhead ? overhead.value : 0, reserved ? reserved.value : 0);
        if (!(budget.perFileKB > 0)) {
          output.textContent = message(lang, budget.usableKB > 0 ? 'budget' : 'overhead');
          output.className = 'gtool-status gtool-error';
          return;
        }
        var kb = budget.perFileKB >= 100 ? budget.perFileKB.toFixed(0) : budget.perFileKB.toFixed(1);
        output.textContent = (lang === 'zh'
          ? '可用空间 ' + budget.usableKB.toFixed(1) + ' KB，平均每个文件 ' + kb + ' KB（' + budget.perFileBytes.toLocaleString('zh-CN') + ' 字节）。请给文件名和表单字段留出余量。'
          : 'Usable space: ' + budget.usableKB.toFixed(1) + ' KB. Average per file: ' + kb + ' KB (' + budget.perFileBytes.toLocaleString('en-US') + ' bytes). Leave headroom for filenames and form fields.');
        output.className = 'gtool-status';
      } catch (error) {
        output.textContent = message(lang, 'budget');
        output.className = 'gtool-status gtool-error';
      }
    });
  }

  function init() {
    var compressors = document.querySelectorAll('[data-tool="compressor"]');
    for (var i = 0; i < compressors.length; i++) initCompressor(compressors[i]);
    var printers = document.querySelectorAll('[data-tool="print-size"]');
    for (var j = 0; j < printers.length; j++) initPrintSize(printers[j]);
    var budgets = document.querySelectorAll('[data-tool="upload-budget"]');
    for (var k = 0; k < budgets.length; k++) initBudget(budgets[k]);
  }

  var api = {
    PRESETS: PRESETS,
    fmtBytes: fmtBytes,
    fitDims: fitDims,
    bitsPerPixel: bitsPerPixel,
    printSize: printSize,
    pixelsForPrint: pixelsForPrint,
    uploadBudget: uploadBudget,
    compressJpg: compressJpg,
    detectImageFormat: detectImageFormat,
    formatLabel: formatLabel,
    message: message,
    init: init
  };
  root.PixelPressGuides = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : this);

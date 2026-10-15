const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function fixture({ privacy = false, trackerFails = false } = {}) {
  const elements = new Map(), events = [], downloads = [], urls = [];
  function element() {
    return {value:'',innerHTML:'',textContent:'',dataset:{},classList:{add(){},remove(){},toggle(){}},handlers:{},
      addEventListener(name,fn){this.handlers[name]=fn;},querySelectorAll(){return [];},appendChild(){},focus(){},remove(){},
      click(){if(this.download) downloads.push(this.download);else return this.handlers.click?.();}};
  }
  const get = id => {if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  const document = {getElementById:get,querySelectorAll:()=>[],addEventListener(){},body:{appendChild(){}},createElement:element};
  const context = vm.createContext({document,navigator:{doNotTrack:privacy===true?'1':'0',globalPrivacyControl:privacy==='gpc'},
    window:{location:{search:'?qa=1'},gtag(...args){if(trackerFails)throw new Error('analytics unavailable');events.push(args);}},
    console:{warn(){}},URL:{createObjectURL(){const url='blob:qa-'+urls.length;urls.push(url);return url;},revokeObjectURL(){}},URLSearchParams,
    Image:class{},Blob,TextEncoder,Uint8Array,DataView,HTMLCanvasElement:{prototype:{toBlob(){}}},setTimeout(){return 1;},clearTimeout(){}});
  const html=readFileSync(join(__dirname,'../index.html'),'utf8');
  const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const presets='));
  vm.runInContext(source,context);
  const api=context.window.__PIXELPRESS_TEST__;
  function add(file={name:'private-photo.jpg',type:'image/jpeg',size:1000}) {
    get('fileInput').handlers.change({target:{files:[file],value:'fake'}});
    return api.state.files.at(-1);
  }
  return {api,add,get,events,downloads,urls,context};
}

test('local selection and successful compression record no file names or image data', async()=>{
  const p=fixture();assert.equal(p.events.length,0);const item=p.add();
  p.context.window.createImageBitmap=true;
  p.context.createImageBitmap=async()=>({width:40,height:30,close(){}});
  await p.api.compressOne(item.id);
  assert.equal(item.status,'done');
  assert.deepEqual(p.events.map(e=>e[1]),['image_selected','compression_start','compression_complete']);
  assert(p.events.every(e=>e[2].qa_internal));
  assert.doesNotMatch(JSON.stringify(p.events),/private-photo|blob:|fake/);
});

test('changing the target during encoding cannot publish the old-size result', async()=>{
  const p=fixture(),item=p.add();let release;
  p.context.window.createImageBitmap=true;
  p.context.createImageBitmap=()=>new Promise(resolve=>{release=()=>resolve({width:40,height:30,close(){}});});
  const pending=p.api.compressOne(item.id);
  p.get('targetSize').handlers.change({target:{value:'10kb'}});
  release();await pending;
  assert.equal(item.status,'ready');assert.equal(item.blob,null);assert.equal(item.url,'');
  assert.equal(p.events.filter(e=>e[1]==='compression_complete').length,0);
});

test('removing a file during encoding cannot create an orphan result URL', async()=>{
  const p=fixture(),item=p.add();let release;
  p.context.window.createImageBitmap=true;
  p.context.createImageBitmap=()=>new Promise(resolve=>{release=()=>resolve({width:40,height:30,close(){}});});
  const pending=p.api.compressOne(item.id);
  p.get('clearBtn').click();release();await pending;
  assert.equal(p.api.state.files.length,0);assert.equal(p.urls.length,1);
  assert.equal(p.events.filter(e=>e[1]==='compression_complete').length,0);
});

test('decoding failure stays visible and cannot emit completion', async()=>{
  const p=fixture(),item=p.add();
  delete p.context.HTMLCanvasElement.prototype.toBlob;
  await p.api.compressAll();
  assert.equal(item.status,'error');assert.match(item.text,/does not support/);
  assert.match(p.get('toast').textContent,/failed|could not/i);
  assert.equal(p.events.filter(e=>e[1]==='compression_complete').length,0);
  assert.equal(p.events.filter(e=>e[1]==='compression_error').length,1);
});

test('privacy signals and tracker exceptions cannot block local processing', async()=>{
  for(const config of [{privacy:true},{privacy:'gpc'},{trackerFails:true}]){
    const p=fixture(config),item=p.add();p.context.window.createImageBitmap=true;
    p.context.createImageBitmap=async()=>({width:40,height:30,close(){}});
    await p.api.compressOne(item.id);
    assert.equal(item.status,'done');assert.equal(p.events.length,0);
  }
});

test('unsupported files and duplicate active clicks do not fabricate success', async()=>{
  const p=fixture();p.add({name:'note.txt',type:'text/plain',size:12});
  assert.equal(p.api.state.files.length,0);assert.equal(p.events.length,0);
  const item=p.add();let release;
  p.context.window.createImageBitmap=true;
  p.context.createImageBitmap=()=>new Promise(resolve=>{release=()=>resolve({width:40,height:30,close(){}});});
  const pending=p.api.compressOne(item.id);await p.api.compressOne(item.id);release();await pending;
  assert.equal(p.events.filter(e=>e[1]==='compression_start').length,1);
  assert.equal(p.events.filter(e=>e[1]==='compression_complete').length,1);
});

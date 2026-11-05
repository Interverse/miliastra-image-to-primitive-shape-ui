/* End-to-end partial exports from real fitting workers. */
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'reference/pause-save');fs.mkdirSync(out,{recursive:true});
const fallback=process.argv.includes('fallback');
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}
 if(!fallback){res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{await new Promise(resolve=>server.listen(8353,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage({acceptDownloads:true,serviceWorkers:fallback?'block':'allow'}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{errors.push(d.message());await d.dismiss();});
 await page.addInitScript(()=>{const Base=Worker;window.__terminated=[];window.Worker=class extends Base{postMessage(msg,...rest){if(msg.cmd==='process')this.jobId=msg.jobId;return super.postMessage(msg,...rest);}terminate(){if(this.jobId)window.__terminated.push(this.jobId);super.terminate();}};});
 const cases=fallback?[['primeval','turbo']]:[['primeval','turbo'],['primeval','fast'],['legacy',null],['gaussian',null]];
 for(const [method,speed] of cases){
  await page.goto('http://127.0.0.1:8353/index.html');
  assert.equal(await page.locator('[data-experiment="groups"]').count(),0);
  await page.selectOption('#fitMethod',method);
  await page.fill('#numPrimsManual',method==='gaussian'?'400':'5000');await page.locator('#numPrimsManual').dispatchEvent('change');
  if(method==='primeval'){await page.selectOption('#primevalSpeed',speed);await page.fill('#primevalResolution','64');if(await page.locator('#focusDetail').isVisible()&&await page.locator('#focusDetail').isChecked())await page.locator('#focusDetail').uncheck();}
  if(method==='gaussian'){await page.fill('#gaussianResolution','64');await page.fill('#gaussianIterations','10000');}
  await page.setInputFiles('#fileInput',path.join(root,'tests/primeval/fixtures/input.png'));
  await page.locator('#btnSubmit').click();
  await page.waitForFunction(()=>!document.getElementById('btnPausePreview').disabled&&!document.getElementById('btnPausePreview').hidden,undefined,{timeout:120000});
  await page.locator('#btnPausePreview').click();await page.locator('#viewResult.active').waitFor({timeout:30000});
  assert.match(await page.locator('#topbarStatus').textContent(),/Paused/);
  assert((await page.evaluate(()=>window.__terminated.length))>0,'Paused worker is terminated');
  const exported={};
  for(const [kind,id] of [['json','btnExportJSON'],['png','btnExportPNG'],['svg','btnExportSVG'],['gia','btnExportClientGIAOverlimit']]){
   const pending=page.waitForEvent('download',{timeout:60000});await page.locator('#'+id).click();const download=await pending;const file=path.join(out,`${method}-${speed||'default'}-${fallback?'fallback':'threaded'}.${kind}`);await download.saveAs(file);exported[kind]=file;assert(fs.statSync(file).size>0);
  }
  const data=JSON.parse(fs.readFileSync(exported.json,'utf8'));assert(data.config.partial&&data.config.paused);assert.equal(data.config.partial_reason,'user-paused');assert(data.elements.length>0);assert.equal(data.config.completed_primitives,Number(await page.locator('#statTotal').textContent()));assert.equal(data.config.requested_num_primitives,method==='gaussian'?400:5000);
  if(method!=='gaussian')assert(data.config.completed_primitives<5000);
  const png=fs.readFileSync(exported.png);assert.equal(png.subarray(1,4).toString(),'PNG');
  await page.fill('#clientLuaTemplateIndex','1');await page.locator('#clientLuaTemplateIndex').dispatchEvent('input');
  const luaPending=page.waitForEvent('download');await page.locator('#btnExportClientLua').click();const lua=await luaPending;const luaFile=path.join(out,`${method}-${speed||'default'}.lua`);await lua.saveAs(luaFile);assert(fs.statSync(luaFile).size>100);
  await page.locator('#btnBackToJobs').click();assert.equal(await page.locator('.job-status.paused').count(),1);assert(await page.locator('#btnDownloadAll').isVisible());
  if(method==='primeval'&&speed==='turbo'){
   const zipPending=page.waitForEvent('download');await page.locator('#btnDownloadAll').click();const download=await zipPending;const zipFile=path.join(out,`paused-${fallback?'fallback':'threaded'}.zip`);await download.saveAs(zipFile);
   const zip=fs.readFileSync(zipFile),entries=[];let pos=0;
   while(zip.readUInt32LE(pos)===0x04034b50){assert.equal(zip.readUInt16LE(pos+8),0);const size=zip.readUInt32LE(pos+18),nameLength=zip.readUInt16LE(pos+26),extra=zip.readUInt16LE(pos+28),name=zip.subarray(pos+30,pos+30+nameLength).toString();const start=pos+30+nameLength+extra;entries.push({name,data:zip.subarray(start,start+size)});pos=start+size;}
   const json=entries.find(e=>e.name.endsWith('.json'));assert(json);const payload=JSON.parse(json.data);assert(payload.config.partial&&payload.config.paused);assert.equal(payload.config.completed_primitives,data.config.completed_primitives);assert.equal(payload.elements.length,data.elements.length);assert(entries.some(e=>e.name.endsWith('.lua')));assert(entries.some(e=>e.name.endsWith('.gia')));
  }
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,`${method}-${speed||'default'}-${width}.png`)});}
  console.log('PASS pause, worker stop, partial metadata, JSON/PNG/SVG/GIA/Lua exports and layout',method,speed||'',data.config.completed_primitives);
 }
 if(!fallback){
  await page.goto('http://127.0.0.1:8353/index.html');
  await page.fill('#numPrimsManual','80');await page.locator('#numPrimsManual').dispatchEvent('change');await page.fill('#primevalResolution','64');await page.locator('#focusDetail').uncheck();
  const file=path.join(root,'tests/primeval/fixtures/input.png');await page.setInputFiles('#fileInput',[file,file]);await page.locator('#btnSubmit').click();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-pause-job]')).some(b=>!b.disabled),undefined,{timeout:120000});
  await page.locator('[data-pause-job]:not([disabled])').first().click();await page.locator('#viewResult.active').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.job-status.done').length===1,undefined,{timeout:120000});
  assert.equal(await page.locator('.job-status.paused').count(),1);assert.equal(await page.locator('.job-status.error').count(),0);
  console.log('PASS pausing one job preserves the other queued/parallel job');
 }
 assert.deepEqual(errors,[]);console.log('PASS no runtime errors; retired option absent; paused ZIP exports retain partial metadata');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});

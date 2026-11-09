/* Automated browser tests; point PLAYWRIGHT_MODULE at the local installation. */
const fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=require('../runtime-root.cjs'),testBase=path.resolve(__dirname,'..');
const isolationOnly=process.argv[2]==='isolation';
const fallbackOnly=process.argv[2]==='fallback';
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
 const file=pathname.startsWith('/tests/')?path.resolve(testBase,'.'+pathname.slice(6)):path.resolve(root,'.'+pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
 if(!isolationOnly&&!fallbackOnly){res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.png':'image/png','.css':'text/css','.gia':'application/octet-stream'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(8350,'127.0.0.1',r));
 const launch={headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']};
 if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;
 else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch);
 const page=await browser.newPage({viewport:{width:Number(process.argv[2])||1440,height:1000},deviceScaleFactor:Number(process.env.TEST_DPR)||1,serviceWorkers:fallbackOnly?'block':'allow'});
 page.on('pageerror',error=>console.error('PAGEERROR',error.message));
 if(fallbackOnly){
  await page.goto('http://127.0.0.1:8350/index.html');
  const records=await page.evaluate(async()=>{
   if(crossOriginIsolated)throw Error('Expected single-thread fallback');
   const worker=new Worker('/js/worker-primeval.js'),records=[];
   for(const shape of ['circle','triangle','rect']){
    const input=await PNGDecode.decode(new Uint8Array(await(await fetch('/tests/primeval/fixtures/input.png')).arrayBuffer()));
    const result=await new Promise((resolve,reject)=>{
     worker.onmessage=({data})=>{if(data.type==='done')resolve(data.result);if(data.type==='error')reject(Error(data.message));};
     worker.postMessage({cmd:'process',jobId:shape,rgba:input.rgba.buffer,width:64,height:64,config:{primeval_speed:"quality",num_primitives:40,allowed_shapes:[shape]}},[input.rgba.buffer]);
    });
    const png=new Uint8Array(result.primeval_png),gold=new Uint8Array(await(await fetch('/tests/primeval/fixtures/'+shape+'.png')).arrayBuffer());
    const svg=await(await fetch('/tests/primeval/fixtures/'+shape+'.svg')).text();
    records.push({shape,exact_png:png.length===gold.length&&png.every((v,i)=>v===gold[i]),exact_svg:result.primeval_svg===svg});
   }
   worker.terminate();return records;
  });
  if(records.some(r=>!r.exact_png||!r.exact_svg))throw Error(JSON.stringify(records));
  console.log('PASS output-equivalent single-thread fallback PNG/SVG for all three shapes');
  await browser.close();server.close();return;
 }
 if(isolationOnly){
  await page.goto('http://127.0.0.1:8350/index.html');
  await page.waitForFunction(()=>crossOriginIsolated,{timeout:15000});
  const count=await page.evaluate(async()=>{
   const input=await PNGDecode.decode(new Uint8Array(await(await fetch('/tests/primeval/fixtures/input.png')).arrayBuffer()));
   const worker=new Worker('/js/worker-primeval.js');
   return await new Promise((resolve,reject)=>{
    worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result.elements.length);}};
    worker.postMessage({cmd:'process',jobId:'isolation',rgba:input.rgba.buffer,width:64,height:64,config:{primeval_speed:"quality",num_primitives:40,allowed_shapes:['triangle']}});
   });
  });
  if(count!==41)throw Error('Static-host worker failed');
  console.log('PASS service-worker isolation and threaded generation on a server without COOP/COEP headers');
  await browser.close();server.close();return;
 }
 await page.goto('http://127.0.0.1:8350/tests/primeval/browser_smoke.html');
 await page.waitForFunction(()=>document.body.dataset.result,undefined,{timeout:180000});
 const report=await page.locator('#report').textContent();
 const output=path.join(root,'reference/research-2026-10');
 fs.writeFileSync(path.join(output,`site-smoke-${process.argv[2]||1440}.txt`),report);
 console.log(report.split('\n').slice(-8).join('\n'));
 const ok=await page.evaluate(()=>document.body.dataset.result==='pass');
 if(ok){
  await page.locator('details').evaluate(e=>e.open=false);await page.locator('#app').scrollIntoViewIfNeeded();
  const app=page.frames().find(f=>f.url().endsWith('/index.html'));
  await app.evaluate(()=>document.querySelector('#numPrims').max='10000');
  await app.fill('#numPrimsManual','2000');
  for(const method of ['primeval','gaussian','legacy']){
   await app.selectOption('#fitMethod',method);
   await app.locator('#fitMethod').scrollIntoViewIfNeeded();
   const layout=await app.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}));
   if(layout.scroll>layout.width+1)throw Error('Horizontal overflow '+method+' '+JSON.stringify(layout));
   await page.locator('#app').screenshot({path:path.join(output,`site-${method}-${process.argv[2]||1440}.png`)});
   if(method==='primeval'){
    await app.selectOption('#primevalSpeed','turbo');await page.locator('#app').screenshot({path:path.join(output,`site-turbo-${process.argv[2]||1440}.png`)});
    await app.locator('#enablePngMode').uncheck();await app.locator('#useBackgroundColor').check();await app.locator('#backgroundColorRow').scrollIntoViewIfNeeded();
    const customLayout=await app.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth}));
    if(customLayout.scroll>customLayout.width+1)throw Error('Horizontal overflow custom background');
    await page.locator('#app').screenshot({path:path.join(output,`site-background-${process.argv[2]||1440}.png`)});
    await app.locator('#useBackgroundColor').uncheck();await app.locator('#enablePngMode').check();
   }
  }
  await app.locator('#homeLink').click();await app.locator('.job-card:has(.job-status.done) .job-actions button').first().click();
  for(const prefix of ['btnExportGIA','btnExportClientGIA','btnExportServerGIA']){
   const beyond=await app.locator('#'+prefix+'Overlimit').boundingBox(),classic=await app.locator('#'+prefix+'Classic').boundingBox();
   if(Math.abs(beyond.y-classic.y)>1||beyond.x+beyond.width>classic.x+1)throw Error('Export buttons must be paired with Beyond first: '+prefix);
  }
  await page.locator('#app').screenshot({path:path.join(output,`site-result-${process.argv[2]||1440}.png`)});
  await app.locator('#mainCanvas').click({position:await app.locator('#mainCanvas').evaluate(e=>({x:e.clientWidth/2,y:e.clientHeight/2}))});
  await page.locator('#app').screenshot({path:path.join(output,`site-gizmos-${process.argv[2]||1440}.png`)});
  await app.click('#btnScreenSizing');await app.locator('#screenSizingDialog').waitFor({state:'visible'});
  const widthField=app.locator('#screenSizingWidth');
  // A real pointer path checks the resize handle and preview-only movement.
  await app.locator('[data-screen-device="0"]').click();
  await app.locator('#screenSizingSnap').check();
  await widthField.fill('1599');await widthField.dispatchEvent('change');
  if(Number(await widthField.inputValue())!==1600)throw Error('Screen border snap');
  await app.locator('#screenSizingSnap').uncheck();
  await widthField.fill('1599');await widthField.dispatchEvent('change');
  if(Number(await widthField.inputValue())!==1599)throw Error('Screen snap toggle');
  await widthField.fill('800');await widthField.dispatchEvent('change');
  const handle=await app.locator('#screenSizingHandle').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+25,handle.y+handle.height/2+25,{steps:4});await page.mouse.up();
  const resized=Number(await widthField.inputValue());if(resized<=800)throw Error('Screen handle resize');
  const image=await app.locator('#screenSizingImage').boundingBox();
  const beforeMove=await app.locator('#screenSizingImage').evaluate(e=>e.style.left);
  await page.mouse.move(image.x+image.width/2,image.y+image.height/2);await page.mouse.down();await page.mouse.move(image.x+image.width/2+20,image.y+image.height/2+10,{steps:4});await page.mouse.up();
  if(Number(await widthField.inputValue())!==resized||beforeMove===await app.locator('#screenSizingImage').evaluate(e=>e.style.left))throw Error('Screen move changed size or failed');
  const dialogBounds=await app.locator('#screenSizingDialog').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));
  if(dialogBounds.scroll>dialogBounds.width+1)throw Error('Screen dialog overflow');
  await page.locator('#app').screenshot({path:path.join(output,`site-screen-sizing-${process.argv[2]||1440}.png`)});
  for(let device=0;device<4;device++){
   await app.locator('[data-screen-device="'+device+'"]').click();
   await page.locator('#app').screenshot({path:path.join(output,`site-screen-sizing-device-${device}-${process.argv[2]||1440}.png`)});
  }
  await app.locator('#screenSizingCancel').click();
  console.log('PASS screen sizing pointer resize, move, snapping and responsive dialog');
  console.log('PASS '+report.split('\n').length+' checks; upload/result screenshots at '+(process.argv[2]||1440));
 }
 await browser.close();server.close();if(!ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1);});

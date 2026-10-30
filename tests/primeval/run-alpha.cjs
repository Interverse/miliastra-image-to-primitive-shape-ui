/* Real WASM alpha regressions, both isolated and single-thread fallback. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=require('../runtime-root.cjs'),fallback=process.argv.includes('fallback');
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname);
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
  if(!fallback){res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');res.end(data);
 });
});
(async()=>{
 await new Promise(r=>server.listen(8359,'127.0.0.1',r));
 const launch={headless:true};if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch);
 try{
  const page=await browser.newPage({serviceWorkers:fallback?'block':'allow'});await page.goto('http://127.0.0.1:8359/index.html');
  const records=await page.evaluate(async()=>{
   const run=(rgba,shape,profile)=>new Promise((resolve,reject)=>{
    const worker=new Worker('/js/worker-primeval.js');worker.onerror=e=>{worker.terminate();reject(Error(e.message));};
    worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result);}};
    worker.postMessage({cmd:'process',jobId:'test',rgba:rgba.buffer,width:32,height:32,config:{num_primitives:32,allowed_shapes:[shape],enable_png_mode:true,primeval_resolution:32,primeval_speed:profile}});
   });
   const records=[];
   for(const profile of ['fast','quality'])for(const shape of ['circle','triangle','rect']){
    const input=new Uint8ClampedArray(32*32*4);
    for(let y=7;y<25;y++)for(let x=7;x<25;x++){const i=(y*32+x)*4;input.set([220,60,90,x===7||x===24?128:255],i);}
    const result=await run(input.slice(),shape,profile);
    const hidden=input.slice();for(let i=0;i<hidden.length;i+=4)if(hidden[i+3]===0)hidden.set([255,127,13,0],i);
    const repeated=await run(hidden,shape,profile);
    const empty=await run(new Uint8ClampedArray(input.length),shape,profile);
    const canvas=new OffscreenCanvas(32,32),ctx=canvas.getContext('2d');PrimevalResult.drawElements(ctx,result.elements);const pixels=ctx.getImageData(0,0,32,32).data;
    const svgImage=await createImageBitmap(new Blob([result.primeval_png],{type:'image/png'}));ctx.clearRect(0,0,32,32);ctx.drawImage(svgImage,0,0);const png=ctx.getImageData(0,0,32,32).data;
    let error=0;for(let i=3;i<pixels.length;i+=4)error+=Math.abs(pixels[i]-png[i]);
    const gia=GiaExport.convertResultToGiaJson(result,{},'alpha.png',16,16);
    records.push({shape,profile,actualProfile:result.config.primeval_speed,count:result.elements.length,background:result.elements.some(e=>e.is_background),alpha:result.config.output_has_transparency,corner:png[3],middle:png[(16*32+16)*4+3],hiddenIdentical:JSON.stringify(result.primeval_drawing)===JSON.stringify(repeated.primeval_drawing),empty:empty.elements.every(e=>e.alpha===0),svg:result.primeval_svg,renderError:error/1024,giaCount:gia.elements.length,giaAlpha:gia.elements.some(e=>e.alpha<1)});
   }
   return records;
  });
  for(const r of records){assert.equal(r.actualProfile,r.profile);assert.equal(r.count,32);assert.equal(r.giaCount,32);assert(r.giaAlpha);assert(!r.background);assert(r.alpha);assert.equal(r.corner,0);assert(r.middle>100);assert(r.hiddenIdentical);assert(r.empty);assert(!r.svg.includes('<rect width='));assert(r.renderError<5,JSON.stringify(r));console.log('PASS',fallback?'single':'threaded',r.shape,r.profile,'RGBA/hidden-RGB/empty/PNG/SVG/GIA/control render',r.renderError.toFixed(3));}
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());

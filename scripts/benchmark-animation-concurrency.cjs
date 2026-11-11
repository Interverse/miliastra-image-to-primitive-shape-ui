/* Real GIF temporal-sequence concurrency benchmark; runtime files are unchanged.
 * node scripts/benchmark-animation-concurrency.cjs <gif> [1,4,8] [total threads=16]
 * All reports and sampled renders go under ignored reference/.
 */
'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const [input,workersText='1,4,8',threadsText='16']=process.argv.slice(2);
const counts=workersText.split(',').map(Number),requestedThreads=Number(threadsText);
if(!input||counts.some(n=>!Number.isSafeInteger(n)||n<1)||!Number.isSafeInteger(requestedThreads)||requestedThreads<1)throw Error('Usage: <gif> [1,4,8] [total threads]');
const source=fs.readFileSync(input),out=path.join(root,'reference/jahoda/concurrency');fs.mkdirSync(out,{recursive:true});
let workerCode=fs.readFileSync(path.join(root,'js/worker-animation.js'),'utf8');
const loop='for(let i=0;i<track.frameCount;i++){',origin=workerCode.includes('origin??=timestamp;')?'origin??=timestamp;':'origin??=msg.sequence?.origin??timestamp;';
if(!workerCode.includes(loop)||!workerCode.includes(origin))throw Error('Benchmark injection no longer matches worker');
workerCode=workerCode.replace(loop,'for(const i of msg.benchmark_indices){').replace(origin,'origin??=0;');
const inputSha256=crypto.createHash('sha256').update(source).digest('hex');
const runtimeHash=crypto.createHash('sha256');for(const name of ['js/worker-animation.js','js/animation-sequences.js','js/animation-motion.js','js/worker-primeval.js','js/vendor/primeval/wasm/threaded/primeval_bg.wasm'])runtimeHash.update(fs.readFileSync(path.join(root,name)));const runtimeSha256=runtimeHash.digest('hex');
const server=http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 const u=new URL(req.url,'http://local').pathname;
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css'})[path.extname(u)]||'application/octet-stream');
 if(u==='/benchmark.gif')return res.end(source);
 if(u==='/js/benchmark-concurrency-worker.js')return res.end(workerCode);
 const file=path.resolve(root,'.'+u);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(file,(error,bytes)=>{if(error)res.writeHead(404);res.end(bytes);});
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const launch={headless:true};if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch);
 try{
  const reports=[];
  for(const workers of counts){
   const savedPath=path.join(out,`workers-${workers}.json`);
   if(fs.existsSync(savedPath)&&process.env.ANIMATION_BENCH_REPEAT!=='1'){const saved=JSON.parse(fs.readFileSync(savedPath));if(saved.inputSha256===inputSha256&&saved.runtimeSha256===runtimeSha256&&saved.budget===requestedThreads){reports.push(saved);console.log(JSON.stringify({event:'saved-result',workers,processingMs:saved.processingMs}));continue;}}
   const page=await browser.newPage();page.on('pageerror',error=>console.error(error));
   await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
   await page.addScriptTag({url:'/js/animation-media.js'});
   await page.exposeFunction('reportBenchmark',data=>console.log(JSON.stringify({workers,...data})));
   const report=await page.evaluate(async({workers,requestedThreads})=>{
    const hardware=navigator.hardwareConcurrency||1,budget=Math.min(hardware,requestedThreads),threads=Math.max(1,Math.floor(budget/workers));
    if(workers>budget)throw Error('More workers than the fixed CPU budget');
    const data=await(await fetch('/benchmark.gif')).arrayBuffer(),decoder=new ImageDecoder({data:data.slice(0),type:'image/gif',preferAnimation:true});
    await decoder.tracks.ready;await decoder.completed;
    const total=decoder.tracks.selectedTrack.frameCount,timing=AnimationMedia.gifTiming(data),fps=15,preserveTiming=timing.frames<=fps*timing.duration+1e-6,selected=[];
    for(let index=0;index<total;index++){
     const {image}=await decoder.decode({frameIndex:index});const timestamp=image.timestamp/1e6,duration=Math.max(.01,(image.duration||0)/1e6),tick=preserveTiming?timestamp:Math.max(0,Math.ceil((timestamp-1e-7)*fps))/fps;
     if(tick<timestamp+duration-1e-7||preserveTiming)selected.push(index);image.close();
    }
    decoder.close();if(workers>selected.length)throw Error('Insufficient frames');
    const chunks=Array.from({length:workers},(_,i)=>selected.slice(Math.floor(i*selected.length/workers),Math.floor((i+1)*selected.length/workers)));
    const config={num_primitives:2000,allowed_shapes:['mixed'],primeval_turbo:true,primeval_speed:'fast',primeval_resolution:512,primeval_threads:threads,primeval_seed:42,image_scale:1,output_alpha:1,focus:{enabled:true,automatic:true,areas:[]},animation_temporal:true,animation_fps:fps};
    const file=new File([data],'jahoda.gif',{type:'image/gif'}),active=new Map(),handles=[],start=performance.now();
    const timer=setInterval(()=>reportBenchmark({elapsedSeconds:Math.round((performance.now()-start)/1000),active:Array.from(active.values())}),30000);
    await reportBenchmark({event:'start',hardware,deviceMemory:navigator.deviceMemory,budget,threadsPerFrame:threads,selected,chunks});
    let results;
    try{results=await Promise.all(chunks.map((indices,id)=>new Promise((resolve,reject)=>{
     const worker=new Worker('/js/benchmark-concurrency-worker.js');handles.push(worker);active.set(id,{id,completed:0,total:indices.length});
     worker.onerror=event=>reject(Error('Worker '+id+': '+event.message));
     worker.onmessage=({data})=>{
      if(data.type==='focus-warning')reject(Error('Focus failed: '+data.detail));
      if(data.type==='error')reject(Error('Worker '+id+': '+data.detail));
      if(data.type==='progress'){const state=active.get(id);if(state){if(data.metrics){state.metrics=data.metrics;state.completed=data.metrics.keyframes+data.metrics.refined+data.metrics.repeated;}}}
      if(data.type==='done'){
       active.delete(id);worker.terminate();const animation=data.result.animation;
       if(animation.frames.length!==indices.length)reject(Error('Selected frame count changed'));
       else if(animation.frames.some(frame=>frame.length!==2001*8))reject(Error('Shape count changed'));
       else{reportBenchmark({event:'sequence-done',id,elapsedSeconds:(performance.now()-start)/1000,metrics:animation.metrics});resolve({id,indices,animation,milliseconds:performance.now()-start});}
      }
     };
     worker.postMessage({cmd:'process',file,config,sequence:{indices,origin:0},benchmark_indices:indices});
    })));}finally{clearInterval(timer);for(const worker of handles)worker.terminate();}
    const processingMs=performance.now()-start,samples=[],frameHashes=[];
    for(const result of results){
     const animation=result.animation;
     for(let index=0;index<animation.frames.length;index++){
      const frame=animation.frames[index],digest=await crypto.subtle.digest('SHA-256',frame);
      frameHashes.push({source:result.indices[index],hash:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')});
     }
     for(const index of [...new Set([0,Math.floor(animation.frames.length/2),animation.frames.length-1])]){
      const canvas=new OffscreenCanvas(animation.width,animation.height);PrimevalResult.drawElements(canvas.getContext('2d'),AnimationCore.elements(animation,index),animation.unit);
      samples.push({source:result.indices[index],png:Array.from(new Uint8Array(await(await canvas.convertToBlob()).arrayBuffer()))});
     }
    }
    return {workers,budget,threadsPerFrame:threads,hardware,deviceMemory:navigator.deviceMemory,config,selected,processingMs,sequences:results.map(({id,indices,animation,milliseconds})=>({id,indices,milliseconds,metrics:animation.metrics})),frameHashes,samples};
   },{workers,requestedThreads});
   for(const sample of report.samples)fs.writeFileSync(path.join(out,`workers-${workers}-frame-${sample.source}.png`),Buffer.from(sample.png));delete report.samples;
   report.input=path.basename(input);report.inputSha256=inputSha256;report.runtimeSha256=runtimeSha256;report.measuredAt=new Date().toISOString();reports.push(report);
   fs.writeFileSync(path.join(out,`workers-${workers}.json`),JSON.stringify(report,null,2));
   console.log(JSON.stringify({event:'complete',workers,processingMs:report.processingMs,sequences:report.sequences.map(s=>({id:s.id,keyframes:s.metrics.keyframes,refined:s.metrics.refined}))}));
   fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(reports,null,2));await page.close();
  }
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});

/* Fit using only the Pages artifact, mounted below a GitHub-style project URL. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=require('../runtime-root.cjs'),site=path.resolve(process.env.PRIMEVAL_DEPLOYMENT_SITE||path.join(root,'.pages-site'));
const prefix='/miliastra-image-to-primitive-shape-ui/';
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
 if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
 const file=path.resolve(site,pathname.slice(prefix.length)||'index.html');
 if(!file.startsWith(site+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(data);
 });
});
(async()=>{
 await new Promise(r=>server.listen(8362,'127.0.0.1',r));
 const launch={headless:true};if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch);
 try{
  {
   const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),failures=[];
   page.on('response',r=>{if(r.status()>=400&&/\/(js|css|assets)\//.test(r.url()))failures.push(r.url());});
   page.on('pageerror',e=>failures.push(e.message));
   await page.goto('http://127.0.0.1:8362'+prefix+'index.html');
   const input=fs.readFileSync(path.join(__dirname,'fixtures/input.png')).toString('base64');
   const {records,focus}=await page.evaluate(async({input})=>{
    const records=[];
    for(const profile of ['quality','fast'])for(const shape of ['circle','triangle','rect']){
     const png=Uint8Array.from(atob(input),c=>c.charCodeAt(0)),decoded=await PNGDecode.decode(png);
     const worker=new Worker(new URL('js/worker-primeval.js',location.href));
     const result=await new Promise((resolve,reject)=>{
      worker.onerror=e=>{worker.terminate();reject(Error(e.message));};
      worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result);}};
      worker.postMessage({cmd:'process',jobId:shape,rgba:decoded.rgba.buffer,width:64,height:64,config:{primeval_speed:profile,num_primitives:40,allowed_shapes:[shape]}});
     });
     records.push({shape,profile,backend:result.config.primeval_backend,count:result.elements.length,png:Array.from(new Uint8Array(result.primeval_png))});
    }
    for(const profile of ['fast','quality']){
     const decoded=await PNGDecode.decode(Uint8Array.from(atob(input),c=>c.charCodeAt(0))),worker=new Worker(new URL('js/worker-primeval.js',location.href));
     const result=await new Promise((resolve,reject)=>{worker.onerror=e=>{worker.terminate();reject(Error(e.message));};worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result);}};worker.postMessage({cmd:'process',rgba:decoded.rgba.buffer,width:64,height:64,config:{allowed_shapes:['mixed'],num_primitives:8,primeval_resolution:64,primeval_speed:profile}});});
     records.push({shape:'mixed',profile,count:result.elements.length,png:Array.from(new Uint8Array(result.primeval_png)),drawing:JSON.stringify(result.primeval_drawing)});
    }
    // Automatic focus: module worker, CPU/WASM runtime and model from the artifact.
    const image=await PNGDecode.decode(Uint8Array.from(atob(input),c=>c.charCodeAt(0)));
    const map=await Focus.analyze({},image.rgba,64,64,{cancelled:false,abort:null});
    return {records,focus:map&&{width:map.width,height:map.height,max:Math.max(...map.values)}};
   },{input});
   assert.deepEqual(failures,[]);
   assert.ok(focus&&focus.width>0&&focus.height>0&&focus.max===1,'automatic focus runs from the artifact');
   const mixed=records.filter(r=>r.shape==='mixed');assert.equal(mixed[0].drawing,mixed[1].drawing);assert.deepEqual(mixed[0].png,mixed[1].png);
   for(const r of records){if(r.shape==='mixed'){assert.equal(r.count,9);continue;}assert.equal(r.backend,"wasm");assert.equal(r.count,41);assert.deepEqual(Buffer.from(r.png),fs.readFileSync(path.join(__dirname,'fixtures',r.shape+'.png')));}
   const gif=fs.readFileSync(path.join(__dirname,'fixtures/animation/moving.gif')).toString('base64');
   const animationFrames=await page.evaluate(async gif=>{
    const file=new File([Uint8Array.from(atob(gif),c=>c.charCodeAt(0))],'moving.gif',{type:'image/gif'});
    const media=await import(new URL('js/vendor/mediabunny/mediabunny.min.js',location.href));
    async function decode(file){const worker=new Worker(new URL('js/worker-animation.js',location.href));
     return await new Promise((resolve,reject)=>{worker.onerror=e=>{worker.terminate();reject(Error(e.message));};worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result.animation.frames.length);}};worker.postMessage({cmd:'process',file,config:{num_primitives:8,allowed_shapes:['triangle'],primeval_speed:'fastest',primeval_resolution:32,primeval_threads:1}});});
    }
    const gifCount=await decode(file),canvas=new OffscreenCanvas(32,16),ctx=canvas.getContext('2d');
    const target=new media.BufferTarget(),output=new media.Output({target,format:new media.WebMOutputFormat()}),source=new media.CanvasSource(canvas,{codec:'vp8',bitrate:100000});output.addVideoTrack(source,{frameRate:10});await output.start();
    for(let i=0;i<2;i++){ctx.fillStyle=i?'blue':'red';ctx.fillRect(0,0,32,16);await source.add(i*.1,.1);}source.close();await output.finalize();
    return {gif:gifCount,video:await decode(new File([target.buffer],'clip.webm',{type:'video/webm'}))};
   },gif);
   assert.deepEqual(animationFrames,{gif:3,video:2},'GIF/video workers and decoder load from a Pages project subpath');
   console.log('PASS deployment artifact: project subpath, all three shapes, WASM, Mixed, exact PNGs and automatic focus');
   await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());

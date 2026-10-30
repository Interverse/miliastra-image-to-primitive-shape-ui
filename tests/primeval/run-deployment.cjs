/* Fit using only the Pages artifact, mounted below a GitHub-style project URL. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=require('../runtime-root.cjs'),site=path.join(root,'.pages-site');
const prefix='/miliastra-image-to-primitive-shape-ui/';
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
 if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
 const file=path.resolve(site,pathname.slice(prefix.length)||'index.html');
 if(!file.startsWith(site+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.png':'image/png'})[path.extname(file)]||'application/octet-stream');res.end(data);
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
   const records=await page.evaluate(async({input})=>{
    const records=[];
    for(const shape of ['circle','triangle','rect']){
     const png=Uint8Array.from(atob(input),c=>c.charCodeAt(0)),decoded=await PNGDecode.decode(png);
     const worker=new Worker(new URL('js/worker-primeval.js',location.href));
     const result=await new Promise((resolve,reject)=>{
      worker.onerror=e=>{worker.terminate();reject(Error(e.message));};
      worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){worker.terminate();resolve(data.result);}};
      worker.postMessage({cmd:'process',jobId:shape,rgba:decoded.rgba.buffer,width:64,height:64,config:{primeval_speed:"quality",num_primitives:40,allowed_shapes:[shape]}});
     });
     records.push({shape,count:result.elements.length,png:Array.from(new Uint8Array(result.primeval_png))});
    }
    return records;
   },{input});
   assert.deepEqual(failures,[]);
   for(const r of records){assert.equal(r.count,41);assert.deepEqual(Buffer.from(r.png),fs.readFileSync(path.join(__dirname,'fixtures',r.shape+'.png')));}
   console.log('PASS deployment artifact: project subpath, all three shapes and exact PNGs');
   await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());

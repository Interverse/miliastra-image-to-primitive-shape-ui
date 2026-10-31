/* Full-source browser profiling; retain outputs and inclusive engine phase markers. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),[input,shape='mixed',countText='400',detailText='512']=process.argv.slice(2);
const count=Number(countText),detail=Number(detailText);
if(!input||!['triangle','circle','rect','mixed'].includes(shape)||!Number.isSafeInteger(count)||count<1||!Number.isInteger(detail)||detail<32||detail>2048){console.error('Usage: node scripts/profile-primeval.cjs <image> [triangle|circle|rect|mixed] [count] [detail]');process.exit(1);}
const output=path.join(root,'reference','primeval-profiles','profile-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});const source=fs.readFileSync(input);fs.writeFileSync(path.join(output,'source'+path.extname(input)),source);
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(error,bytes)=>{if(error){res.writeHead(404);res.end();return;}
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');res.end(bytes);
 });
});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const launch={headless:true};if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch),rows=[];
 try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.evaluate(async({base64,detail})=>{
   const image=await createImageBitmap(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))]));
   const scale=1;const width=Math.max(2,Math.round(image.width*scale)),height=Math.max(2,Math.round(image.height*scale));
   const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,width,height);image.close();
   globalThis.benchmarkInput={width,height,rgba:ctx.getImageData(0,0,width,height).data};
  },{base64:source.toString('base64'),detail});
  for(const [name,profile]of [['exact','fast']]){
   console.log('Fitting',name,shape,count,detail);
   const result=await page.evaluate(({profile,shape,count,detail})=>new Promise((resolve,reject)=>{
    const {width,height,rgba}=globalThis.benchmarkInput,worker=new Worker('/js/worker-primeval.js');
    worker.onerror=e=>{worker.terminate();reject(Error(e.message));};
    worker.onmessage=({data})=>{if(data.type==='error'){worker.terminate();reject(Error(data.message));}if(data.type==='done'){const r=data.result;worker.terminate();resolve({seconds:r.elapsed_seconds,drawing:r.primeval_drawing,png:Array.from(new Uint8Array(r.primeval_png)),svg:r.primeval_svg,config:r.config});}};
    worker.postMessage({cmd:'process',rgba:rgba.slice().buffer,width,height,config:{allowed_shapes:[shape],num_primitives:count,primeval_resolution:detail,primeval_speed:profile,enable_png_mode:true}});
   }),{profile,shape,count,detail});
   const png=Buffer.from(result.png),drawing=JSON.stringify(result.drawing);
   fs.writeFileSync(path.join(output,name+'.png'),png);fs.writeFileSync(path.join(output,name+'.svg'),result.svg);fs.writeFileSync(path.join(output,name+'.drawing.json'),drawing);
   rows.push({name,seconds:result.seconds,drawing:hash(drawing),png:hash(png),config:result.config});
   fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({input:path.resolve(input),shape,count,detail,rows},null,2));
   console.log(name,result.seconds+'s',result.config.primeval_backend);
  }
  console.log('Profile retained (original source dimensions; fit includes native export/startup):',output);
  console.log(JSON.stringify(rows[0].config.primeval_stage_timings,null,2));
  console.log(JSON.stringify(rows[0].config.primeval_timings,null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());

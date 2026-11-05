// Browser CPU/WASM source enhancement, with retained native fitting comparisons.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve('reference/ai-upscale');
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8322/');
  for (const name of ['gold','blue','varka']) {
    const enhanced = await page.evaluate(async name => {
      const blob = await fetch('/reference/ai-upscale/'+name+'.png').then(r=>r.blob());
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap,0,0); const original = ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const {upscale} = await import('/js/ai-upscale.js');
      const result = await upscale(original,canvas.width,canvas.height);
      const out = new OffscreenCanvas(result.width,result.height);
      out.getContext('2d').putImageData(new ImageData(result.rgba,result.width,result.height),0,0);
      const output = await out.convertToBlob({type:'image/png'});
      const bytes = new Uint8Array(await output.arrayBuffer()); let binary='';
      for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return {png:btoa(binary),metadata:result.metadata};
    },name);
    fs.writeFileSync(path.join(root,name+'-ai.png'),Buffer.from(enhanced.png,'base64'));
    fs.writeFileSync(path.join(root,name+'-ai.json'),JSON.stringify(enhanced.metadata,null,2));
    console.log(name,enhanced.metadata);
  }
  await browser.close();
  const tasks=[];
  for(const name of ['gold','blue','varka'])for(const count of [400,1000,2000])for(const variant of ['original','ai'])tasks.push({name,count,variant});
  let next=0;
  async function run(){
    while(next<tasks.length){
      const {name,count,variant}=tasks[next++];
      const dir=path.join(root,`${name}-${variant}-${count}`);fs.mkdirSync(dir,{recursive:true});
      const input=path.join(root,name+(variant==='ai'?'-ai':'')+'.png');
      await new Promise(resolve=>cp.execFile(path.resolve('reference/lines-curves/target/release/examples/turbo_lab.exe'),[input,String(count),'512','42',dir],{timeout:900000,maxBuffer:16*1024*1024,env:{...process.env,RAYON_NUM_THREADS:'4'}},(err,stdout,stderr)=>{
        fs.writeFileSync(path.join(dir,'log.txt'),stdout+stderr);if(err)fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({error:err.message}));console.log(name,variant,count,err?'FAILED':'done');resolve();
      }));
    }
  }
  await Promise.all([run(),run()]);
})().catch(error=>{console.error(error);process.exit(1);});

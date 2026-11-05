/* Run against the repository HTTP server at port 8322. */
const assert = require('assert');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8322/');
  const output = await page.evaluate(() => new Promise((resolve,reject) => {
    const worker = new Worker('/js/worker-primeval.js?v=ai-upscale-1');
    const rgba = new Uint8ClampedArray(16*16*4);
    for(let y=4;y<12;y++)for(let x=4;x<12;x++)rgba.set([200,40,80,128],(y*16+x)*4);
    worker.onerror = error => {worker.terminate();reject(Error(error.message));};
    worker.onmessage = ({data}) => {
      if(data.type==='error'){worker.terminate();reject(Error(data.message));}
      if(data.type==='done'){
        const config=data.result.config;
        worker.terminate();resolve({config,elements:data.result.elements.length});
      }
    };
    worker.postMessage({cmd:'process',jobId:'test',rgba:rgba.buffer,width:16,height:16,config:{ai_upscale:true,primeval_resolution:32,primeval_turbo:true,primeval_threads:1,num_primitives:2,allowed_shapes:['triangle'],enable_png_mode:true}});
  }));
  assert.equal(output.config.ai_upscale.backend,'wasm');
  assert.equal(output.config.ai_upscale.scale,2);
  assert.equal(output.config.source_size.width,16);
  assert.equal(output.config.working_size.width,32);
  assert.equal(output.elements,2);
  const validation = await page.evaluate(async () => {
    const {upscale}=await import('/js/ai-upscale.js');
    try{await upscale(new Uint8ClampedArray(4),5000,5000);return false;}catch{return true;}
  });
  assert(validation);
  await browser.close();console.log('PASS AI WASM worker, original export size, enhanced working size, exact count and explicit resource error');
})().catch(error=>{console.error(error);process.exit(1);});

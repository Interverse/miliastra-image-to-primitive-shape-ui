/* Browser CPU/WASM feasibility pilot; all artifacts remain ignored. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),folder=path.join(root,'reference/automatic-importance');
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.end(data);
  });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,...(!fs.existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  try{
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    if(process.argv[2]==='--contract'){
      const result=await page.evaluate(async()=>{
        const runtime=await import('/js/vendor/primeval/dist/browser-runtime.js');
        const rgba=new Uint8ClampedArray(32*32*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=(i/4)%32*8;rgba[i+1]=180;rgba[i+3]=255;}
        const input=await PrimevalResult.encodeRGBA(rgba,32,32);
        const run=importance=>runtime.approximateInWorker({input,output:'png',render:{shape:'mixed',count:8,turbo:true,seed:42,resizeInput:32,...(importance?{importance}:{})}});
        const baseline=await run(),neutral=await run({width:2,height:1,values:new Float32Array([0,1]),strength:0});
        if(JSON.stringify(baseline.drawing)!==JSON.stringify(neutral.drawing))throw Error('Neutral attention changed output');
        const guided=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5});
        if(guided.drawing.shapes.length!==8)throw Error('Shape count changed');
        let rejected=false;try{await run({width:2,height:1,values:new Float32Array([0,NaN]),strength:.5});}catch(error){rejected=/importance/.test(error.message);}
        if(!rejected)throw Error('Invalid map was not rejected');
        const zeroAdditive=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:0});
        if(JSON.stringify(zeroAdditive.drawing)!==JSON.stringify(guided.drawing))throw Error('Zero additive term changed output');
        const additive=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:.5});
        if(additive.drawing.shapes.length!==8)throw Error('Additive term changed shape count');
        rejected=false;try{await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:5});}catch(error){rejected=/importance/.test(error.message);}
        if(!rejected)throw Error('Invalid additive term was not rejected');
        const fullRefine=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:.5,refine:1});
        if(JSON.stringify(fullRefine.drawing)!==JSON.stringify(additive.drawing))throw Error('Default refine changed output');
        const structuralRefine=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:.5,refine:0});
        if(structuralRefine.drawing.shapes.length!==8)throw Error('Refine term changed shape count');
        rejected=false;try{await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,refine:-1});}catch(error){rejected=/importance/.test(error.message);}
        if(!rejected)throw Error('Invalid refine term was not rejected');
        const proposal=await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,additive:.5,proposalOnly:true});
        if(proposal.drawing.shapes.length!==8)throw Error('Proposal guidance changed count');
        const proposalNeutral=await run({width:2,height:1,values:new Float32Array([0,1]),strength:0,proposalOnly:true});
        if(JSON.stringify(proposalNeutral.drawing)!==JSON.stringify(baseline.drawing))throw Error('Neutral proposals changed output');
        const structural=await run({width:2,height:1,values:new Float32Array([0,1]),strength:0,proposalOnly:true,structuralProposals:true});
        if(structural.drawing.shapes.length!==8)throw Error('Structural proposals changed shape count');
        rejected=false;try{await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,structuralProposals:true});}catch(error){rejected=/structuralProposals/.test(error.message);}
        if(!rejected)throw Error('Structural proposals without proposalOnly were not rejected');
        const redistribute=redistribution=>runtime.approximateInWorker({input,output:'png',render:{shape:'mixed',count:8,turbo:true,seed:42,resizeInput:32,redistribution}});
        if(JSON.stringify((await redistribute('energy')).drawing)!==JSON.stringify(baseline.drawing))throw Error('Explicit energy redistribution changed output');
        if((await redistribute('measured')).drawing.shapes.length!==8)throw Error('Measured redistribution changed shape count');
        rejected=false;try{await redistribute('other');}catch(error){rejected=/redistribution/.test(error.message);}
        if(!rejected)throw Error('Invalid redistribution was not rejected');
        const wide=await runtime.approximateInWorker({input,output:'png',render:{shape:'mixed',count:8,turbo:true,seed:42,resizeInput:32,redistributionTrials:8}});
        if(JSON.stringify(wide.drawing)!==JSON.stringify(baseline.drawing))throw Error('Default trial count changed output');
        rejected=false;try{await runtime.approximateInWorker({input,output:'png',render:{shape:'mixed',count:8,turbo:true,seed:42,resizeInput:32,redistributionTrials:0}});}catch(error){rejected=/redistributionTrials/.test(error.message);}
        if(!rejected)throw Error('Invalid redistribution trial count was not rejected');
        const strong=await run({width:2,height:1,values:new Float32Array([0,1]),strength:1,additive:3});
        if(strong.drawing.shapes.length!==8)throw Error('Additive above 1 changed shape count');
        const aspect=rectAspect=>runtime.approximateInWorker({input,output:'png',render:{shape:'mixed',count:8,turbo:true,seed:42,resizeInput:32,rectAspect}});
        if(JSON.stringify((await aspect(8)).drawing)!==JSON.stringify(baseline.drawing))throw Error('Default rectangle cap changed output');
        if((await aspect(64)).drawing.shapes.length!==8)throw Error('Rectangle cap changed shape count');
        if(JSON.stringify((await run()).drawing)!==JSON.stringify(baseline.drawing))throw Error('Rectangle cap leaked into a later fit');
        rejected=false;try{await aspect(4);}catch(error){rejected=/rectAspect/.test(error.message);}
        if(!rejected)throw Error('Invalid rectangle cap was not rejected');
        rejected=false;try{await run({width:2,height:1,values:new Float32Array([0,1]),strength:.5,proposalOnly:1});}catch(error){rejected=/importance/.test(error.message);}
        if(!rejected)throw Error('Invalid proposal mode was not rejected');

        return 'PASS browser attention map, zero-strength/additive/default-refine/neutral-proposal identity, exact count (incl. structural proposals, measured redistribution, additive above 1, rectangle cap), no cap leak and invalid-option rejection';
      });console.log(result);return;
    }
    if(process.argv[2]){
      // --dump <image> <folder>: also keep tensor/raw output for PyTorch parity checks.
      const dump=process.argv[2]==='--dump',args=dump?process.argv.slice(3):process.argv.slice(2);
      const source=fs.readFileSync(args[0]).toString('base64');
      const map=await page.evaluate(async({source,dump})=>{
        const {prepareAttention,cropAttention,normalizeAttention}=await import('/js/importance-analysis.js');
        const ort=await import('/reference/automatic-importance/package/dist/ort.wasm.min.mjs');
        ort.env.wasm.wasmPaths='/reference/automatic-importance/package/dist/';ort.env.wasm.numThreads=1;
        const image=await createImageBitmap(new Blob([Uint8Array.from(atob(source),c=>c.charCodeAt(0))]));
        const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        const input=prepareAttention(ctx.getImageData(0,0,image.width,image.height).data,image.width,image.height);
        const session=await ort.InferenceSession.create('/reference/automatic-importance/unisal.onnx',{executionProviders:['wasm']});
        const result=(await session.run({image:new ort.Tensor('float32',input.tensor,[1,3,288,384])})).attention.data;
        const cropped=cropAttention(result,input.crop,384);
        const alphaCanvas=new OffscreenCanvas(input.crop.width,input.crop.height),alphaCtx=alphaCanvas.getContext('2d');alphaCtx.drawImage(image,0,0,input.crop.width,input.crop.height);
        const pixels=alphaCtx.getImageData(0,0,input.crop.width,input.crop.height).data,alpha=new Uint8Array(cropped.length);
        for(let i=0;i<alpha.length;i++)alpha[i]=pixels[i*4+3];
        const map=normalizeAttention(cropped,input.crop.width,input.crop.height,alpha);await session.release();
        return {...(map?{...map,values:Array.from(map.values),strength:0.5}:{map:null}),
          ...(dump?{tensor:Array.from(input.tensor),raw:Array.from(result),crop:input.crop,alpha:Array.from(alpha)}:{})};
      },{source,dump});
      if(dump){
        const out=args[1];fs.mkdirSync(out,{recursive:true});
        for(const key of ['tensor','raw','values'])if(map[key])fs.writeFileSync(path.join(out,key+'.f32'),Buffer.from(Float32Array.from(map[key]).buffer));
        fs.writeFileSync(path.join(out,'alpha.u8'),Buffer.from(Uint8Array.from(map.alpha)));
        fs.writeFileSync(path.join(out,'meta.json'),JSON.stringify({crop:map.crop,width:map.width,height:map.height,source:path.resolve(args[0])}));return;
      }
      fs.writeFileSync(args[1]||path.join(folder,'attention-map.json'),JSON.stringify(map.map===null?null:map));return;
    }
    const result=await page.evaluate(async()=>{
      const base='/reference/automatic-importance/';
      const ort=await import(base+'package/dist/ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths=base+'package/dist/';ort.env.wasm.numThreads=1;
      const start=performance.now();const session=await ort.InferenceSession.create(base+'unisal.onnx',{executionProviders:['wasm']});
      const loadMs=performance.now()-start;
      const values=new Float32Array(3*288*384).fill(0.5),tensor=new ort.Tensor('float32',values,[1,3,288,384]);
      const times=[];let output;
      for(let i=0;i<4;i++){const start=performance.now();output=(await session.run({image:tensor})).attention;times.push(performance.now()-start);}
      const valid=output.data.every(Number.isFinite);await session.release();
      return {loadMs,inferenceMs:times,shape:output.dims,finite:valid,userAgent:navigator.userAgent,threads:1};
    });
    fs.writeFileSync(path.join(folder,'browser-feasibility.json'),JSON.stringify(result,null,2));console.log(result);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());

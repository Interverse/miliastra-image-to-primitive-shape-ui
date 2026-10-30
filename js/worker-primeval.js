/* Primeval 0.2.2 SIMD/Rayon engine; original search/refit/joint stages, seed 42. */
"use strict";
importScripts("png-decode.js", "primeval-result.js?v=1");
let runtime;
self.onmessage=async({data:msg})=>{
  if(msg.cmd!=="process")return;
  const started=performance.now(),config=msg.config || {};
  try{
    const count=Number(config.num_primitives??2000),allowed=config.allowed_shapes || ["triangle"];
    if(!Number.isSafeInteger(count)||count<1)throw Error("Invalid shape count");
    if(allowed.length!==1||!["circle","rect","triangle"].includes(allowed[0]))throw Error("Choose one Primeval shape");
    runtime ??= await import("./vendor/primeval/dist/browser-runtime.js");
    const rgba=new Uint8ClampedArray(msg.rgba),rgb=PrimevalResult.matteRGB(rgba);
    const input=await PrimevalResult.encodeRGB(rgb,msg.width,msg.height);
    const shape={circle:"rotated-ellipse",rect:"rotated-rectangle",triangle:"triangle"}[allowed[0]];
    const detail=Number(config.primeval_resolution??512);
    if(!Number.isInteger(detail)||detail<32||detail>2048)throw Error("Invalid fitting detail");
    postMessage({type:"progress",jobId:msg.jobId,step:0,total:count,phase:""});
    const output=await runtime.approximateInWorker({input,output:"png",render:{shape,count,alpha:"auto",seed:config.primeval_seed??42,resizeInput:Math.min(detail,Math.max(msg.width,msg.height)),outputSize:Math.max(msg.width,msg.height)},execution:{onProgress:info=>{
      // Avoid thousands of DOM/structured-clone updates; every engine step runs.
      if(info.step===1||info.step%Math.max(1,Math.floor(count/100))===0||info.step===count)postMessage({type:"progress",jobId:msg.jobId,step:info.step,total:info.total,phase:""});
    }}});
    const png=await PNGDecode.decode(output.data);
    const converted=PrimevalResult.drawingToElements(output.drawing,output.width,output.height,config);
    // A short side can differ by one pixel because the original library rounds
    // its output dimensions. Keep its PNG intact; pad/crop only the source view.
    const source=new Uint8ClampedArray(output.width*output.height*4);
    for(let y=0;y<output.height;y++){
      const p=Math.min(y,msg.height-1)*msg.width*4;
      source.set(rgba.subarray(p,p+Math.min(output.width,msg.width)*4),y*output.width*4);
      for(let x=msg.width;x<output.width;x++)source.set(rgba.subarray(p+(msg.width-1)*4,p+msg.width*4),(y*output.width+x)*4);
    }
    let preview=png.rgba;
    if((config.output_alpha??1)!==1){
      const canvas=new OffscreenCanvas(output.width,output.height),ctx=canvas.getContext("2d");
      PrimevalResult.drawElements(ctx,converted.elements,Number(config.image_scale)||1);preview=ctx.getImageData(0,0,output.width,output.height).data;
    }
    const result={mode:"fill",image_center:converted.origin,image_size:{width:output.width,height:output.height},elements_count:converted.elements.length,elements:converted.elements,
      config:{mode:"fill",fit_method:"primeval",engine:"primeval-browser",primeval_version:"0.2.2",primeval_shape:shape,primeval_seed:config.primeval_seed??42,primeval_resolution:detail,allowed_shapes:[allowed[0]],num_primitives:count,image_scale:Number(config.image_scale)||1,pixel_per_unit:1/(Number(config.image_scale)||1),unit_scale:Number(config.image_scale)||1,output_alpha:config.output_alpha??1,output_has_transparency:false,fill_variant:"mask",source_size:{width:msg.width,height:msg.height},working_size:{width:output.drawing.width,height:output.drawing.height},matte:[240,240,245],wasm_threads:self.crossOriginIsolated===true,primeval_reference:(config.output_alpha??1)===1},
      mask:{enabled:false},mask_gray:null,image_rgba:source.buffer,preview_rgba:preview.buffer,primeval_png:output.data.buffer,primeval_svg:output.svg,primeval_drawing:output.drawing,elapsed_seconds:Math.round((performance.now()-started)/10)/100};
    postMessage({type:"done",jobId:msg.jobId,result},[result.image_rgba,result.preview_rgba,result.primeval_png]);
  }catch(error){postMessage({type:"error",jobId:msg.jobId,message:error?.message || String(error)});}
};

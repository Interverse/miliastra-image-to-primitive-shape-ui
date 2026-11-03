/* Primeval 0.2.2 SIMD/Rayon engine; Fastest, exact Fast and Maximum Detail profiles. */
"use strict";
importScripts("png-decode.js", "primeval-result.js?v=3");
let runtime;
// Experimental Turbo research options by key (see the Experimental settings); all
// off unless chosen. Bits: 1-8 edge proposal kinds, 1<<18 spill reorder,
// 1<<19 merging, 1<<21 merge on composite error.
const EXPERIMENTS={
  features:{labParams:"feature_cap=16,feature_floor=8,feature_gate=1,feature_budget=0.08"},
  featureProposals:{labParams:"feature_proposals=8"},
  edges:{lineVariant:15},
  extraRounds:{extraRounds:8},
  spillReorder:{lineVariant:1<<18},
  merge:{lineVariant:(1<<19)|(1<<21)},
  gaps:{labParams:"gap_target=0.95,gap_excess=0.15"},
  measured:{redistribution:"measured"},
};
function experimentalRender(keys){
  const experimental={},render={},params=[];let variant=0;
  for(const key of Array.isArray(keys)?keys:[]){
    const option=EXPERIMENTS[key];if(!option)throw Error("Unknown experimental option "+key);
    variant|=option.lineVariant||0;if(option.extraRounds)experimental.extraRounds=option.extraRounds;
    if(option.labParams)params.push(option.labParams);if(option.redistribution)render.redistribution=option.redistribution;
  }
  if(variant)experimental.lineVariant=variant>>>0;if(params.length)experimental.labParams=params.join(",");
  if(Object.keys(experimental).length)render.experimental=experimental;
  return render;
}
self.onmessage=async({data:msg})=>{
  if(msg.cmd!=="process")return;
  const started=performance.now(),config=msg.config || {},stages=[];
  let previous=started;
  const mark=phase=>{const now=performance.now();stages.push({phase,ms:now-previous});previous=now;};
  try{
    const profile=config.primeval_speed??"fast";
    if(!["fastest","fast","quality"].includes(profile))throw Error("Invalid optimization profile");
    const count=Number(config.num_primitives??2000),allowed=config.allowed_shapes || ["triangle"];
    if(!Number.isSafeInteger(count)||count<1)throw Error("Invalid shape count");
    if(allowed.length!==1||!["circle","rect","triangle","mixed"].includes(allowed[0]))throw Error("Choose one Primeval shape mode");
    self.PRIMEVAL_THREADS=Number.isInteger(config.primeval_threads)&&config.primeval_threads>0?config.primeval_threads:Math.min(16,navigator.hardwareConcurrency||1);
    runtime ??= await import("./vendor/primeval/dist/browser-runtime.js?v=structure-priority-7");
    const rgba=new Uint8ClampedArray(msg.rgba);
    const transparent=!!config.enable_png_mode&&rgba.some((a,i)=>i%4===3&&a<255);
    const background=!config.enable_png_mode&&config.background_color!=null?String(config.background_color):null;
    if(background!==null&&!/^#[0-9a-f]{6}$/i.test(background))throw Error("Invalid background color");
    const matte=background?[1,3,5].map(i=>parseInt(background.slice(i,i+2),16)):[240,240,245];
    const input=transparent?await PrimevalResult.encodeRGBA(rgba,msg.width,msg.height):await PrimevalResult.encodeRGB(PrimevalResult.matteRGB(rgba,matte),msg.width,msg.height);
    mark("input-prepare");
    const shape={circle:"rotated-ellipse",rect:"rotated-rectangle",triangle:"triangle",mixed:"mixed"}[allowed[0]];
    const detail=Number(config.primeval_resolution??512);
    if(!Number.isInteger(detail)||detail<32||detail>2048)throw Error("Invalid fitting detail");
    postMessage({type:"progress",jobId:msg.jobId,step:0,total:count,phase:""});
    const output=await runtime.approximateInWorker({input,output:"png",render:{shape,count,...(config.primeval_turbo===true&&msg.importance?{importance:msg.importance}:{}),...(config.primeval_turbo===true&&config.primeval_redistribution?{redistribution:config.primeval_redistribution}:{}),...(config.primeval_turbo===true&&config.primeval_redistribution_trials?{redistributionTrials:config.primeval_redistribution_trials}:{}),...(config.primeval_turbo===true&&config.primeval_rect_aspect?{rectAspect:config.primeval_rect_aspect}:{}),...(config.primeval_turbo===true?experimentalRender(config.primeval_experiments):{}),turbo:config.primeval_turbo===true,fast:profile==="fast",fastest:profile==="fastest",alpha:"auto",...(background?{background}:{}),...(transparent?{background:profile==="fastest"?"transparent-fast":config.primeval_alpha_strategy==="greedy"?"transparent":"transparent-reference"}:{}),seed:config.primeval_seed??42,resizeInput:Math.min(detail,Math.max(msg.width,msg.height)),outputSize:Math.max(msg.width,msg.height)},execution:{onProgress:info=>{
      // Avoid thousands of DOM/structured-clone updates; every engine step runs.
      if(info.shape||info.previewSvg||info.step===1||info.step%Math.max(1,Math.floor(count/100))===0||info.step===count)postMessage({type:"progress",jobId:msg.jobId,step:info.step,total:info.total,refinementStep:info.refinementStep,refinementTotal:info.refinementTotal,previewOnly:!!info.refinementTotal,previewSvg:info.previewSvg,shapeSvg:info.shape,previewIndex:info.previewIndex,phase:info.refinementTotal?"refine":transparent&&info.step===count?"refine":""});
    }}});
    mark("fit-and-native-export-with-startup");
    const png=await PNGDecode.decode(output.data);
    mark("output-decode");
    const converted=PrimevalResult.drawingToElements(output.drawing,output.width,output.height,config);
    mark("control-conversion");
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
    mark("source-and-preview");
    const result={mode:"fill",image_center:converted.origin,image_size:{width:output.width,height:output.height},elements_count:converted.elements.length,elements:converted.elements,
      config:{mode:"fill",fit_method:"primeval",engine:"primeval-browser",primeval_version:"0.2.2",primeval_exact:profile!=="fastest"&&config.primeval_turbo!==true,primeval_backend:"wasm",primeval_timings:output.timings||[],primeval_speed:profile,primeval_shape:shape,primeval_mixed_strategy:config.primeval_turbo===true?"direct-rgba-structured-proposals":shape==="mixed"?"guarded-family-reconsideration":null,primeval_shape_counts:converted.elements.filter(e=>!e.is_background).reduce((counts,e)=>{counts[e.type]=(counts[e.type]||0)+1;return counts;},{}),primeval_seed:config.primeval_seed??42,primeval_resolution:detail,allowed_shapes:[allowed[0]],num_primitives:count,image_scale:Number(config.image_scale)||1,pixel_per_unit:1/(Number(config.image_scale)||1),unit_scale:Number(config.image_scale)||1,output_alpha:config.output_alpha??1,output_has_transparency:transparent,enable_png_mode:!!config.enable_png_mode,primeval_alpha_aware:transparent,primeval_alpha_strategy:transparent?(config.primeval_turbo===true?"direct-source":profile==="fastest"?"fast":config.primeval_alpha_strategy==="greedy"?"greedy":"reference"):null,fill_variant:transparent?"png":"mask",source_size:{width:msg.width,height:msg.height},working_size:{width:output.drawing.width,height:output.drawing.height},matte,background_color:background,wasm_threads:self.crossOriginIsolated===true,primeval_reference:(profile!=="fastest"||shape==="mixed")&&(config.output_alpha??1)===1},
      mask:{enabled:false},mask_gray:null,image_rgba:source.buffer,preview_rgba:preview.buffer,primeval_png:output.data.buffer,primeval_svg:output.svg,primeval_drawing:output.drawing,elapsed_seconds:Math.round((performance.now()-started)/10)/100};
    result.config.primeval_stage_timings=stages;
    result.config.primeval_turbo=config.primeval_turbo===true;
    if(config.primeval_turbo===true&&config.primeval_experiments?.length)result.config.primeval_experiments=config.primeval_experiments.slice();
    postMessage({type:"done",jobId:msg.jobId,result},[result.image_rgba,result.preview_rgba,result.primeval_png]);
  }catch(error){postMessage({type:"error",jobId:msg.jobId,message:error?.message || String(error)});}
};

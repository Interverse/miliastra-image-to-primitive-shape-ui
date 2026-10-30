/* Quality-validated compression with a user-selected control budget.
 * Native rectangle reference -> exact rectangle compression -> budgeted
 * native merges/partitions/overdraw -> boundary/reallocation -> quality report.
 */
"use strict";
if (typeof importScripts === "function") importScripts("rectangle-compression.js?v=2", "rectangle-optimize.js?v=3", "compression-quality.js?v=1");
const CompressionWorker = (() => {
  const Rect = typeof RectangleCompression !== "undefined" ? RectangleCompression : require("./rectangle-compression.js");
  const Quality = typeof CompressionQuality !== "undefined" ? CompressionQuality : require("./compression-quality.js");
  const Optimizer = typeof RectangleOptimizer !== "undefined" ? RectangleOptimizer : require("./rectangle-optimize.js");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const roundEven = v => { const n = Math.floor(v), f = v-n; return Math.abs(f-0.5)<1e-8 ? n+(n%2) : Math.round(v); };
  function bytes(pixels) {
    const out = new Uint8ClampedArray(pixels.length);
    for (let p = 0; p < pixels.length; p += 4) {
      const a = clamp(pixels[p+3],0,1); out[p+3] = roundEven(a*255);
      for (let c = 0; c < 3; c++) out[p+c] = a > 1e-9 ? roundEven(clamp(pixels[p+c]/a,0,1)*255) : 0;
    }
    return out;
  }
  function rectangle(shape, color, opacity = 1) {
    if(shape[4]!==0)throw Error("Deep Compression only supports axis-aligned rectangles");
    const rgb = color.map(v => roundEven(clamp(v,0,1)*255));
    return {type:"rectangle", primitive_type:"rect", image_type:"basic", image_asset_ref:100001,
      center:{x:shape[0],y:-shape[1]}, size:{width:2*shape[2],height:2*shape[3]}, rotation:{z:-shape[4]*180/Math.PI},
      color:"#"+rgb.map(v=>v.toString(16).padStart(2,"0")).join(""), alpha:roundEven(opacity*255)/255,
      packed_color:((roundEven(opacity*255)<<24)|(rgb[0]<<16)|(rgb[1]<<8)|rgb[2])>>>0};
  }
  function rectangles(nodes) {
    return nodes.map(n => {
      const a = n.color[3];
      return rectangle([n.x+n.w/2,n.y+n.h/2,n.w/2,n.h/2,0],n.color.slice(0,3).map(v=>a>1e-9?v/a:0),a);
    });
  }
  function render(elements, width, height, transparent) {
    const pixels=new Float64Array(width*height*4);if(!transparent)pixels.fill(1);
    for(const e of elements){
      if(e.type!=="rectangle"||(e.primitive_type!=null&&e.primitive_type!=="rect")||["x","y","z"].some(axis=>(e.rotation?.[axis]||0)!==0)||(e.image_asset_ref!=null&&e.image_asset_ref!==100001))throw Error("Deep Compression only supports solid axis-aligned rectangles");
      const x0=Math.max(0,Math.ceil(e.center.x-e.size.width/2-0.5)),x1=Math.min(width,Math.ceil(e.center.x+e.size.width/2-0.5));
      const cy=-e.center.y,y0=Math.max(0,Math.ceil(cy-e.size.height/2-0.5)),y1=Math.min(height,Math.ceil(cy+e.size.height/2-0.5));
      const color=[1,3,5].map(at=>parseInt(e.color.slice(at,at+2),16)/255),a=e.alpha??1;
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const p=(y*width+x)*4;
        for(let c=0;c<3;c++)pixels[p+c]+=a*(color[c]-pixels[p+c]);
        pixels[p+3]+=a*(1-pixels[p+3]);
      }
    }
    return bytes(pixels);
  }
  function thresholds(config) {
    const mode=config.compression_quality || "high", base=Quality.PRESETS[mode];
    if(!base)throw Error("Unknown compression quality policy");
    if(mode==="exact")return {...base};
    const out={...base};
    for(const key of Object.keys(out)) if(config.quality_thresholds?.[key]!=null) {
      const value=Number(config.quality_thresholds[key]);
      if(!Number.isFinite(value)||value<0||(key==="ssim"&&value>1))throw Error("Invalid quality threshold: "+key);
      out[key]=value;
    }
    return out;
  }
  async function process(rgba,width,height,config={},hooks={}) {
    if(!(width>0&&height>0)||rgba.length!==width*height*4)throw Error("Invalid compression dimensions");
    const budget=Number(config.num_primitives??2000), steps=Number(config.compression_iterations??1200);
    if(!Number.isSafeInteger(budget)||budget<2||!Number.isSafeInteger(steps)||steps<1)throw Error("Control budget must be an integer of at least 2; steps must be a positive integer");
    // Every supported GIA format requires one parent. Reserve its slot rather
    // than silently adding it on top of the user's chosen GIA budget.
    const count=budget-1;
    const started=Date.now(),limits=thresholds(config),transparent=!!config.enable_png_mode&&rgba.some((v,i)=>i%4===3&&v<255);
    const alphaScale=clamp(config.output_alpha==null?1:Number(config.output_alpha),0,1);
    const source=Rect.prepare(rgba,width,height,transparent),sourceBytes=bytes(source);
    const std=Number(config.native_std??1);
    if(!Number.isFinite(std)||std<0)throw Error("Invalid native STD");
    const report=(phase,step,total)=>hooks.progress?.(step,total,phase);
    report("native",0,height);
    const native=await Rect.merge(source,width,height,std,true,{...hooks,progress:(s,t)=>report("native",s,t)});
    if(!native)return null;
    const nativeElements=rectangles(native),reference=render(nativeElements,width,height,transparent);
    const target=Rect.prepare(reference,width,height,transparent);
    report("lossless",0,height);
    const exactHooks={...hooks,progress:(s,t)=>report("lossless",s,t)};
    let exact=await Rect.lossless(reference,width,height,exactHooks);
    if(!exact)return null;
    const transposed=await Rect.lossless(reference,width,height,exactHooks,true);
    if(!transposed)return null;
    if(transposed.length<exact.length)exact=transposed;
    const palette=new Map();let opaque=true;
    for(let p=0;p<reference.length;p+=4){
      if(reference[p+3]!==255)opaque=false;
      const color=((reference[p+3]<<24)|(reference[p]<<16)|(reference[p+1]<<8)|reference[p+2])>>>0;
      palette.set(color,(palette.get(color)||0)+1);
    }
    if(opaque&&alphaScale===1){
      // Safe overdraw: one exact background color, then only the other native
      // regions. Opaque foreground controls cannot contaminate the background.
      const backgrounds=Array.from(palette).sort((a,b)=>b[1]-a[1]).slice(0,2);
      for(const [color] of backgrounds)for(const transpose of [false,true]){
        const remaining=await Rect.lossless(reference,width,height,{...exactHooks,skipColor:color},transpose);
        if(!remaining)return null;
        const base={x:0,y:0,w:width,h:height,color:[(color>>>16&255)/255,(color>>>8&255)/255,(color&255)/255,1]};
        if(remaining.length+1<exact.length)exact=[base,...remaining];
      }
    }
    let elements=rectangles(exact),strategy="exact-rectangle-merge",optimizationSteps=0,changes=0,constructionMerges=0;
    let preview=render(elements,width,height,transparent);
    let validation=Quality.measure(reference,preview,width,height,limits);
    if(validation.classification!=="pixel-perfect"||elements.length>nativeElements.length){elements=rectangles(native);preview=reference.slice();validation=Quality.measure(reference,preview,width,height,limits);}
    const exactCount=elements.length;
    if(elements.length>count) {
      if(config.compression_quality==="exact")throw Error("COMPRESSION_EXACT_BUDGET");
      // The hard budget wins over fallback size: failed quality stays visible
      // as a failed target, never silently returned as near-lossless.
      report("partition",0,count);
      let state=null,layered=null;
      // Cost heuristic, not a count limit: near-native budgets benefit from
      // merging the exact tiling instead of growing an overdraw fit from zero.
      if(opaque&&alphaScale===1&&count>1&&native.length<=count*8){
        const merged=await Optimizer.mergeNative(native,target,width,height,count-1,{...hooks,progress:(s,t)=>report("partition",s,t)});
        if(!merged)return null;
        constructionMerges=merged.merges;
        if(merged.reached)layered=[merged.background,...merged.nodes];
      }
      if(!layered){
        state=await Optimizer.partition(target,width,height,count,{...hooks,progress:(s,t)=>report("partition",s,t)});
        if(!state)return null;
      }
      elements=rectangles(layered||state.nodes);preview=render(elements,width,height,transparent);
      validation=Quality.measure(reference,preview,width,height,limits);strategy=layered?"native-rectangle-merge":"native-rectangle-partition";
      const rank=v=>v.classification==="pixel-perfect"?0:v.classification==="near-lossless"?1:2;
      const severity=v=>Object.keys(limits).map(key=>key==="ssim"?(1-v.metrics[key])/Math.max(1e-6,1-limits[key]):limits[key]>0?v.metrics[key]/limits[key]:v.metrics[key]===0?0:1e6+v.metrics[key]);
      const score=v=>{const ratios=severity(v);return [rank(v),Math.max(...ratios),ratios.reduce((a,b)=>a+b,0)];};
      async function consider(nodes,method){
        if(hooks.cancelled?.())return;
        const candidate=rectangles(nodes),pixels=render(candidate,width,height,transparent),quality=Quality.measure(reference,pixels,width,height,limits);
        const a=score(quality),b=score(validation);let better=false;
        for(let i=0;i<a.length;i++)if(Math.abs(a[i]-b[i])>1e-10){better=a[i]<b[i];break;}
        if(a.every((v,i)=>Math.abs(v-b[i])<=1e-10)&&candidate.length<elements.length)better=true;
        if(better){elements=candidate;preview=pixels;validation=quality;strategy=method;}
      }
      if(!layered&&opaque&&alphaScale===1){
        report("refine",0,count);
        layered=await Optimizer.layered(target,width,height,count,{...hooks,progress:(s,t)=>report("refine",s,t)});
        if(!layered)return null;
        await consider(layered,"native-rectangle-overdraw");
      }
      report("fit",0,steps);
      const treeSteps=state?(layered?Math.floor(steps/2):steps):0;
      if(state){
        const fitted=await Optimizer.refine(state,treeSteps,{...hooks,progress:(s)=>report("fit",s,steps),candidate:(nodes)=>consider(nodes,"native-rectangle-reallocation")});
        if(!fitted)return null;
        optimizationSteps=fitted.steps;changes=fitted.changes;
      }
      if(layered){
        const last=await Optimizer.refineLayered(layered,target,width,height,steps-treeSteps,{...hooks,progress:(s)=>report("fit",treeSteps+s,steps),candidate:(nodes)=>consider(nodes,"native-rectangle-overdraw-refined")});
        if(!last)return null;
        optimizationSteps+=last.steps;changes+=last.changes;
      }
    }
    if(hooks.cancelled?.())return null;
    if(elements.length+1>budget)throw Error("Compression exceeded control budget");
    // Validation describes reconstruction at full opacity; requested global
    // opacity is applied equally to the reference and final controls.
    if(alphaScale!==1) {
      for(const e of elements){e.alpha=roundEven(e.alpha*alphaScale*255)/255;e.packed_color=((roundEven(e.alpha*255)<<24)|(e.packed_color&0xffffff))>>>0;}
      preview=render(elements,width,height,transparent);
      for(const e of nativeElements)e.alpha=roundEven(e.alpha*alphaScale*255)/255;
      reference.set(render(nativeElements,width,height,transparent));
      validation=Quality.measure(reference,preview,width,height,limits);
    }
    const scale=clamp(Number(config.image_scale)||1,0.1,100),origin=config.origin||{};
    const center={x:origin.type==="top_left"?0:origin.type==="custom"?Number(origin.x)||0:width/2,
      y:origin.type==="top_left"?0:origin.type==="custom"?Number(origin.y)||0:height/2};
    for(const e of elements) {
      e.center.x*=scale;e.center.y*=scale;
      for(const k of Object.keys(e.size))e.size[k]*=scale;
      e.relative={x:e.center.x-center.x*scale,y:e.center.y+center.y*scale};
    }
    const {heatmap,...quality}=validation;
    const savedConfig={...config};
    for(const key of ["gaussian_algorithm","gaussian_iterations","gaussian_resolution","compression_resolution"])delete savedConfig[key];
    savedConfig.primitives=[{shape:"rect",color:"#ffffff"}];
    return {mode:"fill",image_center:center,image_size:{width,height},elements_count:elements.length,elements,
      config:{...savedConfig,mode:"fill",engine:"compression-browser",compression_strategy:strategy,compression_shape_policy:"native-axis-aligned-rectangles",
        pixel_per_unit:1/scale,unit_scale:scale,image_scale:scale,num_primitives:budget,container_controls:1,total_controls:elements.length+1,lua_total_controls:elements.length+2,
        allowed_shapes:["rect"],output_has_transparency:transparent,fill_variant:transparent?"png":"mask",
        native_std:std,native_controls:native.length,lossless_controls:exactCount,control_reduction:1-elements.length/native.length,
        native_unique_colors:palette.size,exact_palette_lower_bound:opaque?palette.size:null,
        compression_iterations:steps,optimization_steps_run:optimizationSteps,rectangle_refinements:changes,construction_merges:constructionMerges,quality,source_quality:Quality.measure(sourceBytes,preview,width,height,limits).metrics,
        training_size:{width,height},quality_version:3},
      mask:{enabled:false},image_rgba:sourceBytes.buffer,preview_rgba:preview.buffer,
      native_rgba:reference.buffer,difference_rgba:heatmap.buffer,mask_gray:null,elapsed_seconds:(Date.now()-started)/1000};
  }
  return {process,render,rectangles,bytes,thresholds};
})();
if(typeof self!=="undefined"&&typeof importScripts==="function") {
  let stopped=false;
  self.onmessage=async({data:msg})=>{
    if(msg.cmd==="cancel"){stopped=true;return;}
    if(msg.cmd!=="process")return;
    stopped=false;
    try {
      const result=await CompressionWorker.process(new Uint8ClampedArray(msg.rgba),msg.width,msg.height,msg.config||{},
        {cancelled:()=>stopped,progress:(step,total,phase)=>postMessage({type:"progress",jobId:msg.jobId,step,total,phase})});
      if(!result)postMessage({type:"cancelled",jobId:msg.jobId});
      else postMessage({type:"done",jobId:msg.jobId,result},[result.image_rgba,result.preview_rgba,result.native_rgba,result.difference_rgba]);
    }catch(error){postMessage({type:"error",jobId:msg.jobId,message:String(error.message||error),detail:String(error.stack||"")});}
  };
}
if(typeof module!=="undefined")module.exports=CompressionWorker;

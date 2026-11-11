"use strict";
importScripts('animation-progress.js?v=1','worker-primeval.js?v=animation-detail-2');
self.onmessage=async({data})=>{
 try{
  const started=performance.now(),stream=data.livePreview?new AnimationProgress.Stream(message=>self.postMessage(message),{sourceFrame:data.sourceFrame,totalSource:data.totalSource,shapeCount:data.config.num_primitives}):null;let failure;const result=await processPrimeval({...data,cmd:'process'},message=>{if(message.type==='progress'){stream?.push(message);self.postMessage({type:'progress',step:message.step,total:message.total,phase:message.phase});}else if(message.type==='error')failure=message.message;});
  stream?.flush();if(!result)throw Error(failure||'Primeval frame fitting failed');
  // Source and preview pixels/SVG are unnecessary for independent frame packing.
  result.animation_fit_ms=performance.now()-started;
  delete result.image_rgba;delete result.preview_rgba;delete result.primeval_svg;
  if(!data.poster)delete result.primeval_png;
  self.postMessage({type:'done',result},result.primeval_png?[result.primeval_png]:[]);
 }catch(error){self.postMessage({type:'error',message:error.message});}
};

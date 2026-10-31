/* Geometry-only rendering: no fitting, no source-alpha mask. */
let ready;
self.onmessage=async({data})=>{
  try{
    ready??=import('./vendor/primeval/wasm/single/primeval.js?v=cpu-runtime-3').then(async glue=>{await glue.default({module_or_path:new URL('./vendor/primeval/wasm/single/primeval_bg.wasm?v=cpu-runtime-3',self.location.href)});return glue;});
    const glue=await ready,result=glue.renderRetained(data.drawing,data.outputSize);
    self.postMessage({id:data.id,result},[result.data.buffer]);
  }catch(error){self.postMessage({id:data.id,error:String(error.message||error)});}
};

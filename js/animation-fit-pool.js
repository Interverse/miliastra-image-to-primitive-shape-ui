/* Independent animation fits share a bounded CPU budget, not prior drawings. */
"use strict";
const AnimationFitPool=(()=>{
 function plan(config,width,height,hardware=navigator.hardwareConcurrency||1,memory=navigator.deviceMemory||4){
  const count=Number(config.num_primitives??2000),detail=Number(config.primeval_resolution??512);
  if(!Number.isSafeInteger(count)||count<1)throw Error('Invalid shape count');
  if(!Number.isInteger(detail)||detail<32||detail>2048)throw Error('Invalid fitting detail');
  const budget=Number.isInteger(config.primeval_threads)&&config.primeval_threads>0?Math.min(config.primeval_threads,hardware):Math.max(1,Math.min(16,hardware));
  const side=Math.min(detail,Math.max(width,height)),pixels=side*side*Math.min(width,height)/Math.max(width,height);
  const estimated=256*1024*1024+pixels*128+count*1024;
  const allowance=Math.min(1024,memory*128)*1024*1024;
  const workers=(config.animation_parallel===false||budget<4)?1:Math.max(1,Math.min(2,Math.floor(budget/2),Math.floor(allowance/estimated)));
  return {workers,threads:Math.max(1,Math.floor(budget/workers)),budget};
 }
 class Pool{
  constructor(options){this.options=options;this.slots=[];this.queue=[];this.closed=false;}
  run(task,onProgress){if(this.closed)return Promise.reject(Error('Frame pool closed'));return new Promise((resolve,reject)=>{this.queue.push({task,onProgress,resolve,reject});this.pump();});}
  pump(){if(this.closed)return;while(this.queue.length){let slot=this.slots.find(s=>!s.job);if(!slot){if(this.slots.length>=this.options.workers)return;slot={worker:new Worker('worker-animation-frame.js?v=3'),job:null};this.slots.push(slot);slot.worker.onmessage=({data})=>{const job=slot.job;if(!job)return;if(data.type==='progress'||data.type==='animation-frame-progress'){job.onProgress?.(data);return;}slot.job=null;if(data.type==='done')job.resolve(data.result);else job.reject(Error(data.message||data.detail||'Frame fitting failed'));this.pump();};slot.worker.onerror=e=>this.close(Error(e.message||'Frame worker failed'));}
    slot.job=this.queue.shift();const task=slot.job.task;slot.worker.postMessage({...task,config:{...task.config,primeval_threads:this.options.threads}},[task.rgba]);
   }}
  close(error=Error('Frame pool closed')){this.closed=true;for(const slot of this.slots){slot.worker.terminate();slot.job?.reject(error);slot.job=null;}for(const job of this.queue)job.reject(error);this.queue=[];}
 }
 return {plan,Pool};
})();
if(typeof module!=='undefined')module.exports=AnimationFitPool;

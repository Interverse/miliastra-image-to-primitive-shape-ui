/* Live fitting states and a virtual filmstrip; every completed frame stays seekable. */
"use strict";
const AnimationGenerationUI=(()=>{
 function create({getJob,update,refresh}){
  const $=id=>document.getElementById(id),cache=[];let selectedJob=null,displayedRecord=null;
  function raster(record,size){const scale=Math.min(1,size/Math.max(record.width,record.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(record.width*scale));canvas.height=Math.max(1,Math.round(record.height*scale));const elements=AnimationCore.elements({width:record.width,height:record.height,frames:[record.frame]},0,record.unit);PrimevalResult.drawElements(canvas.getContext('2d'),elements,record.unit/scale,{width:canvas.width,height:canvas.height});return canvas.toDataURL();}
  function completed(job,index){const record=job.generationFrames?.[index];if(!record)return null;if(displayedRecord!==record){if(displayedRecord)displayedRecord.view=null;displayedRecord=record;}if(!record.view)record.view={config:job.config,previewUrl:raster(record,768),sourceFrame:record.sourceFrame,totalSource:record.totalSource,step:job.config.num_primitives,shapeCount:job.config.num_primitives,completed:true};return record.view;}
  function view(job){if(!job?.generationFrames)return null;const live=job.generationLive;
   if(job.generationFollow!==false&&live.size)return live.get(Math.min(...live.keys()));
   if(job.generationManualSource!=null){const state=live.get(job.generationManualSource);if(state)return state;const index=job.generationSourceMap.get(job.generationManualSource);if(index!=null)return completed(job,index);}
   return completed(job,job.generationFollow!==false?job.generationFrames.length-1:job.generationCursor);
  }
  function handle(job,data){job.generationFrames??=[];job.generationLive??=new Map();job.generationSourceMap??=new Map();job.generationFollow??=true;
   if(data.type==='animation-frame'){
    job.generationFrames[data.index]=data;job.generationSourceMap.set(data.sourceFrame,data.index);job.generationLive.delete(data.sourceFrame);if(job.generationFollow)job.generationCursor=data.index;
   }else{
    let state=job.generationLive.get(data.sourceFrame);if(!state){state={config:job.config,sourceFrame:data.sourceFrame,totalSource:data.totalSource,shapeCount:data.shapeCount,step:0};job.generationLive.set(data.sourceFrame,state);}
    if(data.type==='animation-frame-progress'){Object.assign(state,{step:data.step,total:data.total,phase:data.phase,refinementStep:data.refinementStep,refinementTotal:data.refinementTotal});update(state,data);}
   }
   refresh();
  }
  function finish(job){if(!job.generationFrames)return;job.generationLive.clear();for(let i=0;i<job.generationFrames.length;i++)job.generationFrames[i].frame=job.result.animation.frames[i];refresh();}
  function seek(index){const job=getJob();if(!job?.generationFrames?.length)return;const available=job.generationFrames.map((record,i)=>record?i:null).filter(i=>i!==null);if(!available.length)return;job.generationFollow=false;job.generationManualSource=null;job.generationCursor=available.reduce((best,i)=>Math.abs(i-index)<Math.abs(best-index)?i:best,available[0]);refresh();}
  $('animationGenerationFrame').addEventListener('input',e=>seek(Number(e.target.value)));
  $('animationGenerationFollow').addEventListener('change',e=>{const job=getJob();if(job){job.generationFollow=e.target.checked;job.generationManualSource=null;refresh();}});
  $('animationGenerationStrip').addEventListener('scroll',()=>refresh(),{passive:true});
  function status(job){const state=view(job);if(!state)return '';const phase=job.status!=='processing'?I18N.t('batch.status.'+job.status):state.completed?I18N.t('batch.status.done'):state.phase==='refine'?I18N.t('compression.phase.refine'):I18N.t('animation.fitting');return I18N.t('animation.generating',{frame:state.sourceFrame,total:state.totalSource,step:Math.min(state.shapeCount||0,Math.round(state.step||0)),shapes:state.shapeCount||0})+' · '+phase;}
  function render(job){const box=$('animationGenerationControls');box.hidden=!job?.generationFrames;if(box.hidden){for(const record of cache)record.thumbnail=null;cache.length=0;if(displayedRecord)displayedRecord.view=null;displayedRecord=null;selectedJob=null;return;}
   if(selectedJob!==job){for(const record of cache)record.thumbnail=null;cache.length=0;selectedJob=job;$('animationGenerationStrip').dataset.key='';}
   const frames=job.generationFrames,count=frames.length,cursor=job.generationFollow!==false?count-1:job.generationCursor||0;
   $('animationGenerationFollow').checked=job.generationFollow!==false;$('animationGenerationReady').textContent=I18N.t('animation.framesReady',{count:frames.reduce((n,record)=>n+!!record,0)});const slider=$('animationGenerationFrame');slider.max=Math.max(0,count-1);slider.value=Math.max(0,cursor);slider.disabled=!count;
   const active=$('animationGenerationActive'),keys=[...job.generationLive.keys()].sort((a,b)=>a-b),activeKey=keys.join(',')+'|'+I18N.t('animation.frame');if(active.dataset.key!==activeKey){active.dataset.key=activeKey;active.replaceChildren();for(const source of keys){const button=document.createElement('button');button.type='button';button.className='btn-sm';button.textContent=I18N.t('animation.frame')+' '+source;button.onclick=()=>{job.generationFollow=false;job.generationManualSource=source;refresh();};active.append(button);}}
   const strip=$('animationGenerationStrip');strip.hidden=!count;slider.hidden=!count;const track=$('animationGenerationTrack');track.style.width=count*76+'px';if(job.generationFollow!==false&&Number(strip.dataset.count)!==count)strip.scrollLeft=Math.max(0,count*76-strip.clientWidth);strip.dataset.count=count;
   const start=Math.max(0,Math.floor(strip.scrollLeft/76)-1),end=Math.min(count,start+Math.ceil((strip.clientWidth||600)/76)+3),key=[start,end,cursor,I18N.t('animation.frame')].join('|');if(strip.dataset.key===key)return;strip.dataset.key=key;track.replaceChildren();
   for(let i=start;i<end;i++){const record=frames[i];if(!record)continue;if(!record.thumbnail){record.thumbnail=raster(record,64);cache.push(record);if(cache.length>32)cache.shift().thumbnail=null;}
    const button=document.createElement('button');button.type='button';button.className='animation-generation-thumb';button.style.left=i*76+'px';button.setAttribute('aria-label',I18N.t('animation.frame')+' '+record.sourceFrame);button.setAttribute('aria-pressed',String(i===cursor));button.onclick=()=>seek(i);const img=document.createElement('img');img.src=record.thumbnail;img.alt='';img.width=64;img.height=64;const label=document.createElement('span');label.textContent=record.sourceFrame;button.append(img,label);track.append(button);
   }
  }
  return {handle,finish,view,status,render};
 }
 return {create};
})();

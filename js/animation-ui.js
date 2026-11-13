"use strict";
const AnimationUI=(()=>{
 const isFile=file=>file?.type==='image/gif'||file?.type?.startsWith('video/')||/\.(gif|mp4|m4v|mov|webm|mkv|ogv|ts)$/i.test(file?.name||'');
 const poster='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#303346"/><path d="M66 25L105 45L66 65Z" fill="#bbc4ff"/></svg>');
 function settings(){return {mode:'fill',animation_fps:Number(document.getElementById('animationFps').value),animation_loop:document.getElementById('animationLoop').checked,animation_temporal:document.getElementById('animationTemporal').checked};}
 function paint(state,ctx){PrimevalResult.drawElements(ctx,state.data.elements,Number(state.data.config.image_scale)||1,state.data.image_size);}
 function createSource(){
  const $=id=>document.getElementById(id);let file=null,worker=null,frames=[],ends=[],timer=0,handle=0,playing=false,time=0,last=0,token=0,video=null,videoURL=null,videoHandle=0,lastVideoFrame=-1;
  const label=()=>{const key=playing?'animation.pause':'animation.play';$('animationSourcePlay').dataset.i18n=key;$('animationSourcePlay').textContent=I18N.t(key);};
  function stop(){playing=false;video?.pause();cancelAnimationFrame(handle);label();}
  function clear(){token++;stop();if(video){video.cancelVideoFrameCallback?.(videoHandle);video.removeAttribute('src');video.load();video=null;}if(videoURL)URL.revokeObjectURL(videoURL);videoURL=null;videoHandle=0;lastVideoFrame=-1;worker?.terminate();worker=null;frames.forEach(f=>f.bitmap.close());frames=[];ends=[];time=0;}
  function paint(i){const canvas=$('animationSourceCanvas'),bitmap=frames[i]?.bitmap;if(!bitmap)return;canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);}
  function tick(now){if(!playing||!$('viewUpload').classList.contains('active')){stop();return;}time+=(now-last)/1000;last=now;const duration=ends.at(-1);if($('animationLoop').checked)time%=duration;else if(time>=duration){time=duration;stop();}let low=0,high=ends.length-1;while(low<high){const mid=(low+high)>>1;if(time<ends[mid])high=mid;else low=mid+1;}paint(low);if(playing)handle=requestAnimationFrame(tick);}
  function start(){if(video){const current=video;current.loop=$('animationLoop').checked;current.play().then(()=>{if(video!==current)return;playing=true;label();}).catch(()=>{if(video===current){playing=false;label();}});return;}if(!frames.length||!ends.length)return;if(time>=ends.at(-1))time=0;playing=true;last=performance.now();label();handle=requestAnimationFrame(tick);}
  function streamVideo(current,fps){
   video=document.createElement('video');const media=video;media.muted=true;media.playsInline=true;media.preload='auto';media.loop=$('animationLoop').checked;
   videoURL=URL.createObjectURL(file);media.src=videoURL;
   function draw(timestamp,metadata){
    if(current!==token||video!==media)return;
    const frame=fps?Math.floor((metadata?.mediaTime??media.currentTime)*fps):timestamp;
    if(frame!==lastVideoFrame&&media.readyState>=2){lastVideoFrame=frame;const canvas=$('animationSourceCanvas'),scale=Math.min(1,320/Math.max(media.videoWidth,media.videoHeight));canvas.width=Math.max(1,Math.round(media.videoWidth*scale));canvas.height=Math.max(1,Math.round(media.videoHeight*scale));canvas.getContext('2d').drawImage(media,0,0,canvas.width,canvas.height);}
    if(media.requestVideoFrameCallback)videoHandle=media.requestVideoFrameCallback(draw);else if(!media.paused)handle=requestAnimationFrame(draw);
   }
   media.onloadeddata=()=>{if(current!==token)return;$('animationSourceStatus').textContent=I18N.t('animation.videoSummary',{duration:media.duration.toFixed(2)});$('animationSourcePlay').disabled=false;draw(0);start();};
   media.onended=()=>{if(current===token){playing=false;label();}};
   media.onplay=()=>{if(!media.requestVideoFrameCallback)handle=requestAnimationFrame(draw);};
   media.onerror=()=>{if(current===token){$('animationSourceStatus').textContent=I18N.t('animation.codec');$('animationSourcePlay').disabled=true;}};
  }
  function decode(){
   clear();const current=++token,fps=Number($('animationFps').value);$('animationSource').hidden=!file;if(!file)return;
   $('animationSourcePlay').disabled=true;$('animationSourceStatus').textContent=I18N.t('animation.previewLoading');
   if(!Number.isSafeInteger(fps)||fps<0){$('animationSourceStatus').textContent=I18N.t('animation.fpsInvalid');return;}
   if(!(/\.gif$/i.test(file.name)||file.type==='image/gif')){streamVideo(current,fps);return;}
   worker=new Worker('js/worker-animation.js?v=pixel-perfect-3');
   const fail=key=>{clear();$('animationSourcePlay').disabled=true;$('animationSourceStatus').textContent=I18N.t(key);};
   worker.onerror=()=>fail('animation.codec');worker.onmessage=({data})=>{
    if(current!==token){data.bitmap?.close();return;}
    if(data.type==='previewFrame'){frames.push(data);if(frames.length===1)paint(0);}
    else if(data.type==='previewDone'){worker.terminate();worker=null;ends=frames.map((f,i)=>frames[i+1]?.timestamp??data.duration);$('animationSourceStatus').textContent=I18N.t('animation.sourceSummary',{frames:frames.length,duration:data.duration.toFixed(2)});$('animationSourcePlay').disabled=false;start();}
    else if(data.type==='error')fail(data.message?.startsWith('animation.')?data.message:'animation.codec');
   };worker.postMessage({cmd:'preview',file,config:{animation_fps:fps}});
  }
  function update(next){if(file===next)return;file=next;clearTimeout(timer);decode();}
  $('animationFps').addEventListener('input',()=>{$('animationFps').setCustomValidity('');clearTimeout(timer);clear();timer=setTimeout(decode,180);});
  $('animationSourcePlay').addEventListener('click',()=>playing?stop():start());
  $('animationLoop').addEventListener('change',()=>{if(video)video.loop=$('animationLoop').checked;});
  return {update,stop};
 }
 function create({getState,draw}){
  const $=id=>document.getElementById(id);let playing=false,last=0,time=0,handle=0;
  function label(){const key=playing?'animation.pause':'animation.play';$('animationPlay').dataset.i18n=key;$('animationPlay').textContent=I18N.t(key);}
  function stop(){playing=false;cancelAnimationFrame(handle);label();}
  function show(){stop();const state=getState(),a=state?.data.animation;$('animationPreview').hidden=!a;if(!a)return;
   state.job.animationFrame??=0;
   if(!state.job.animationEnds){let sum=0;state.job.animationEnds=Float64Array.from(a.durations,d=>(sum+=d));}
   time=state.job.animationFrame?state.job.animationEnds[state.job.animationFrame-1]:0;
   $('animationFrame').max=a.frames.length-1;$('animationFrame').value=state.job.animationFrame;
   $('animationSummary').textContent=I18N.t('animation.summary',{frames:a.frames.length,controls:a.controls,duration:a.durations.reduce((s,d)=>s+d,0).toFixed(2)});
   start();
  }
  function frame(index){const state=getState();state.job.animationFrame=index;$('animationFrame').value=index;
   state.data.elements=AnimationCore.elements(state.data.animation,index,Number(state.data.config.image_scale)||1);draw();}
  function tick(now){
   const state=getState(),a=state?.data.animation;if(!playing||!a||!$('viewResult').classList.contains('active')){stop();return;}
   time+=(now-last)/1000;last=now;const ends=state.job.animationEnds,duration=ends[ends.length-1];
   if(a.loop)time%=duration;else if(time>=duration){time=duration;stop();}
   let low=0,high=ends.length-1;while(low<high){const mid=Math.floor((low+high)/2);if(time<ends[mid])high=mid;else low=mid+1;}const index=low;
   if(index!==state.job.animationFrame)frame(index);if(playing)handle=requestAnimationFrame(tick);
  }
  function start(){const a=getState()?.data.animation;if(!a)return;const duration=a.durations.reduce((s,d)=>s+d,0);if(time>=duration)time=0;playing=true;last=performance.now();label();handle=requestAnimationFrame(tick);}
  $('animationPlay').addEventListener('click',()=>{if(playing)stop();else start();});
  $('animationFrame').addEventListener('input',()=>{stop();const index=Number($('animationFrame').value);time=index?getState().job.animationEnds[index-1]:0;frame(index);});
  return {show,stop};
 }
 return {isFile,poster,settings,create,createSource,paint};
})();

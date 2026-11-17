'use strict';
/* Pixel-perfect animation Lua (CODEC 3): poses are coded directly. The saved
 * script must rebuild exactly the poses the channel coder gives, play them
 * identically, and be smaller. Runs the saved Lua when lua/texlua exists. */
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');global.AnimationCodec=require('../../js/animation-codec.js');
global.AnimationOrder=require('../../js/animation-order.js');global.AnimationPlayerRuntime=require('../../js/animation-player-runtime.js');
const Player=require('../../js/animation-lua.js'),Payload=require('../../scripts/animation-payload.cjs'),Core=require('../../js/animation-core.js'),PixelPerfect=require('../../js/pixel-perfect.js');
const {upgrade}=require('../../scripts/upgrade-animation-player.cjs');

/* A walking sprite: outline, body, a blinking eye, a translucent shadow, a
 * colour cycle and one frame that repeats, as Pixel-perfect GIF frames are packed. */
function clip(width,height,count,unit=1){
 const frames=[];let previous;
 for(let f=0;f<count;f++){
  const rgba=new Uint8ClampedArray(width*height*4),step=f===3?2:f,dx=step%6,blink=step%4===2;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const sx=x-dx-3,sy=y-2,inBody=sx>=0&&sx<14&&sy>=0&&sy<12,edge=inBody&&(sx===0||sy===0||sx===13||sy===11);
   const eye=!blink&&sx>=9&&sx<11&&sy>=3&&sy<5,shadow=y===height-2&&sx>=1&&sx<13;
   const rgba4=edge?[30,20,10,255]:eye?[250,250,250,255]:inBody?[90+(step%3)*40,160,(sx*13+sy*7)%5===0?60:90,255]:shadow?[0,0,0,96]:(x+y+f)%23===0?[200,40,40,255]:[0,0,0,0];
   rgba.set(rgba4,(y*width+x)*4);
  }
  const elements=PixelPerfect.process(rgba,width,height,{image_scale:unit}).elements;
  previous=Core.packFrame(elements,previous,width,height,unit,false);frames.push(previous);
 }
 const controls=Math.max(...frames.map(frame=>frame.length/8));
 return {width,height,unit,controls,frames,durations:frames.map((_,i)=>i%3?.08:.12),loop:true,fps:0,kind:'pixel'};
}
function painter(frame,N,meta){
 // Visible entries in painter order, as the player shows them.
 const [width,W,H]=meta.dimensions,out=[];
 for(let id=0;id<N;id++){const a=id*8;if(!frame[a]||Math.floor(frame[a+6]/16777216)===0)continue;out.push([frame[a+7],frame[a],frame[a+1],frame[a+2],frame[a+3],frame[a+4],frame[a+5],frame[a+6]]);}
 return out.sort((a,b)=>a[0]-b[0]).map(e=>e.slice(1));
}

const lua=['lua','texlua'].find(c=>{const p=spawnSync(c,['-v'],{encoding:'utf8'});return !p.error&&p.status===0;});
for(const [label,animation] of [['sprite',clip(30,18,9)],['scaled sprite',clip(23,15,5,3)]]){
 const pixel=Player.build(animation,{imageTemplateIndex:7,loadSpeed:10}),channel=Player.build(animation,{imageTemplateIndex:7,loadSpeed:10,pixelStream:false});
 assert.match(pixel,/^local CODEC=3$/m,label+': pixel clip uses the pixel stream');
 assert.match(channel,/^local CODEC=1$/m,label+': channel coder still available');
 assert.ok(!channel.includes('Invalid pixel run'),label+': other clips carry no pixel decoder');
 const a=Payload.decode(pixel),b=Payload.decode(channel),N=animation.controls;
 assert.equal(a.frames.length,animation.frames.length);
 a.frames.forEach((frame,f)=>assert.deepEqual(painter(frame,N,a.meta),painter(b.frames[f],N,b.meta),`${label}: frame ${f+1} pose matches the channel coder`));
 const data=s=>s.match(/^local DATA="([^"]*)"/m)[1].length;
 assert.ok(data(pixel)<data(channel),`${label}: pixel stream is smaller (${data(pixel)} vs ${data(channel)} chars)`);
 console.log(`PASS ${label}: ${animation.frames.length} poses rebuilt exactly; data ${data(channel)} -> ${data(pixel)} chars`);
 const upgraded=upgrade(pixel).code;
 assert.match(upgraded,/^local PIXEL=\{/m,label+': upgrade keeps the pixel header');assert.ok(upgraded.includes('Invalid pixel run'),label+': upgrade keeps the pixel decoder');
 if(!lua){console.log('SKIP Lua playback oracle (install lua or texlua)');continue;}
 const {capture}=require('../../scripts/preview-lua-player.cjs');
 const run=source=>{const r=capture(source);assert.equal(r.mismatchCount,0,label+': '+JSON.stringify(r.mismatches.slice(0,3)));return r;};
 const p=run(pixel),c=run(channel);run(upgraded);
 assert.deepEqual(p.timeline.map(t=>[t.frame,p.poses[t.pose]]),c.timeline.map(t=>[t.frame,c.poses[t.pose]]),label+': saved Lua shows identical poses');
 const playback=r=>r.timeline.map((t,i)=>i?t.writes-r.timeline[i-1].writes:0);
 assert.deepEqual(playback(p),playback(c),label+': playback makes the same control writes');
 console.log(`PASS ${label}: saved Lua plays ${p.timeline.length} samples identically (startup callbacks ${c.summary.startupCallbacks} -> ${p.summary.startupCallbacks})`);
}
{
 // Not Pixel-perfect: any rotation or non-rectangle keeps the channel coder.
 const animation=clip(20,12,3);animation.frames=animation.frames.map(frame=>{const copy=frame.slice();copy[5]=10;return copy;});
 assert.match(Player.build(animation,{}),/^local CODEC=1$/m,'rotated rectangles keep the channel coder');
 assert.equal(Player.pixelPoses([Float64Array.from([1,0,0,10,10,0,0xff000000,0])],1,10,10),null,'ellipses are not pixel poses');
 console.log('PASS other clips keep the channel coder');
}

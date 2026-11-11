"use strict";
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const Motion=require('../../js/animation-motion.js');
const A=require('../../js/animation-core.js');global.LuaExport=require('../../js/lua-export.js');const L=require('../../js/animation-lua.js');
function shape(type,x,color='#112233'){return {type,center:{x,y:-10},size:type==='ellipse'?{rx:4,ry:3}:{width:8,height:6},rotation:{z:12},color,alpha:1,packed_color:parseInt('ff'+color.slice(1),16)};}
const initial=A.packFrame([shape('ellipse',10),shape('triangle',50)],null,64,32);
const moved=A.packFrame([shape('triangle',51),shape('ellipse',11)],initial,64,32);
assert.equal(initial[0],moved[0]);assert.equal(initial[8],moved[8]);
assert.equal(moved[7],1);assert.equal(moved[15],0);
const inherited=A.packFrame([shape('ellipse',11),shape('triangle',51)],initial,64,32,1,true);assert.equal(inherited[0],initial[0]);assert.equal(inherited[8],initial[8]);assert.equal(inherited[7],initial[7]);assert.equal(inherited[15],initial[15]); // matched IDs, exact painter order
const recovered=A.elements({width:64,height:32,frames:[moved]},0);assert.equal(recovered[0].type,'triangle');assert.equal(recovered[0].center.x,51);assert.equal(recovered[0].triangle_pivot,'box');
const animation={kind:'primeval',width:64,height:32,controls:3,frames:[],durations:Array(40).fill(.05),loop:true};
for(let f=0;f<40;f++)animation.frames.push(new Float64Array([1,-200+f,20,80,60,f*5,0xff112233,f%2?1:0,3,100,0,80+f,100,-120, f%3?0xffaabbcc:0x80ffffff,f%2?0:1,f%4?2:0,0,0,640,320,0,0xff010203,2]));
const encoded=L.encode(animation);assert.equal(encoded.patches[0].length,48);assert.ok(encoded.patches.slice(1).every(p=>p.length<48));
const repeated={...animation,frames:[animation.frames[0],animation.frames[0]],durations:[.05,.05]};assert.equal(L.encode(repeated).patches[1].length,0);
const lua=['lua','texlua'].find(c=>{const p=spawnSync(c,['--version'],{encoding:'utf8'});return !p.error&&p.status===0;});
if(lua){const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'primeval-animation-'));try{
 const expected='{'+animation.frames.map(f=>'{'+[...f].join(',')+'}').join(',')+'}';
 const stub=`local nodes={} local creations=0 local colorCreates=0 local writes=0 local siblingWrites=0 local enabled=false local destroyed=0
local Control={}
function Control:SetActive(v) self.active=v writes=writes+1 end
function Control:SetVisible(v) self.visible=v writes=writes+1 end
function Control:SetImage(source,asset) self.asset=asset writes=writes+1 end
function Control:SetAnchorMin() end function Control:SetAnchorMax() end function Control:SetPivot() end
function Control:SetAnchoredPosition(x,y) self.x=x self.y=y writes=writes+1 end
function Control:SetSizeDelta(w,h) self.w=w self.h=h writes=writes+1 end
function Control:SetLocalScale(x,y,z) self.sx=x self.sy=y self.sz=z writes=writes+1 end
function Control:SetLocalRotation(x,y,z) self.r=z writes=writes+1 end
function Control:SetSiblingIndex(i)
 siblingWrites=siblingWrites+1
 assert(math.type(i)=="integer","SetSiblingIndex requires a Lua integer")
 local hook,mask,count=debug.gethook() debug.sethook()
 local siblings=self.parent.children for at,c in ipairs(siblings) do if c==self then table.remove(siblings,at) break end end table.insert(siblings,i+1,self) writes=writes+1
 if hook then debug.sethook(hook,mask,count) end
end
local parent={children={}}
game={InstantiateClientUIControl=function(index,p) assert(index==123) creations=creations+1 local c=setmetatable({children={},parent=p,alive=true,properties={}},{__index=function(t,k) return Control[k] or t.properties[k] end,__newindex=function(t,k,v) if k=='imageColor' then t.properties[k]=v writes=writes+1 else rawset(t,k,v) end end}) p.children[#p.children+1]=c nodes[#nodes+1]=c return c end,DestroyClientUIControl=function() destroyed=destroyed+1 end}
Color={FromRGBA=function(r,g,b,a) colorCreates=colorCreates+1 return a*16777216+r*65536+g*256+b end}
Enum={ImageSource={StaticReference=1},ImageType={Stretch=1}}
script={object=parent,EnableUpdate=function(self,v) enabled=v end}
local expected=${expected}
local EXPECTED_CONTROLS=3
local function checkFrame(f)
 local state=expected[f] local assets={100002,100001,100003} local group=nil local activeGroups=0
 for _,child in ipairs(nodes[1].children) do if child.active then activeGroups=activeGroups+1 group=child end end
 assert(activeGroups==1,"one complete buffer must be active")
 local byOrder={}
 for id=1,EXPECTED_CONTROLS do local a=(id-1)*8 local kind=state[a+1]
  if kind~=0 and math.floor(state[a+7]/16777216)>0 then
   local angle=state[a+6]*.1*math.pi/180 local co,si=math.abs(math.cos(angle)),math.abs(math.sin(angle))
   local rx=(state[a+4]*co+state[a+5]*si)*.05 local ry=(state[a+4]*si+state[a+5]*co)*.05
   local x,y=state[a+2]*.1,state[a+3]*.1
   if x+rx>=-34 and x-rx<=34 and y+ry>=-18 and y-ry<=18 then byOrder[state[a+8]+1]=id end
  end
 end
 for slot=1,EXPECTED_CONTROLS do local c=group.children[slot] local id=byOrder[slot]
  if not id then assert(not c.visible,"unused draw slot must be hidden") else local a=(id-1)*8 local kind=state[a+1]
   assert(c.visible and c.asset==assets[kind],"kind/visibility "..f)
   assert(math.abs(c.x-state[a+2]*0.1)<0.00001 and math.abs(c.y-state[a+3]*0.1)<0.00001,"position "..f)
   assert(math.abs(c.w-state[a+4]*0.1)<0.00001 and math.abs(c.h-state[a+5]*0.1)<0.00001,"size "..f)
   assert(math.abs(c.r-state[a+6]*0.1)<0.00001,"rotation "..f)
   assert(c.imageColor==state[a+7],"color "..f)
  end
 end
end
`;
 const settle=`
local callbacks=0 local peakInstructions=0 local peakWrites=0
local function tick(dt)
 local instructions=0 local before=creations local previousWrites=writes local wasLoading=loading debug.sethook(function() instructions=instructions+100 assert(instructions<1000000,"callback instruction budget exceeded") end,"",100)
 OnUpdate(dt) debug.sethook() assert(creations-before<=10,"too many creations per callback") callbacks=callbacks+1 if ready then checkFrame(current) end peakInstructions=math.max(peakInstructions,instructions) if not wasLoading then local used=writes-previousWrites peakWrites=math.max(peakWrites,used) assert(used<=MAX_UI_CALLS,"unbounded playback UI work") end
end
local function settle(dt)
 tick(dt) for i=1,100000 do if not loading and ready and not job then return end tick(0) end error("loading did not complete")
end
`;
 const code=L.buildLegacy(animation,{imageTemplateIndex:123,compact:false})+settle;
 let elapsed=0;const steps=[];for(let f=2;f<=40;f++){elapsed+=.05;steps.push(`settle(.05) checkFrame(${f})`);}
 for(const dt of [.1,5000.231,.0001,.7]){elapsed=(elapsed+dt)%2;const target=Math.min(40,Math.floor(elapsed/.05)+1);steps.push(`settle(${dt}) checkFrame(${target})`);}
 const file=path.join(tmp,'playback.lua');
 fs.writeFileSync(file,stub+code+`
OnStart() settle(0) checkFrame(1) local initialCreates,initialColors=creations,colorCreates
${steps.join('\n')}
assert(creations==initialCreates and colorCreates==initialColors,"transition allocation")
local before=writes OnUpdate(0) assert(writes==before,"duplicate frame writes")
OnDestroy() assert(not enabled and destroyed==1) OnUpdate(1)
`);
 let run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 fs.writeFileSync(file,stub+L.buildLegacy({...animation,loop:false},{imageTemplateIndex:123,compact:false})+settle+'\nOnStart() settle(0) settle(10000) checkFrame(40) assert(not enabled) OnDestroy()');run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 // The FPS player must stay live and present a complete retained frame each update.
 fs.writeFileSync(file,stub+L.buildLegacy(animation,{imageTemplateIndex:123,compact:false,fps:15})+settle+`
OnStart() settle(0) local changes=0 local last=current
for i=1,150 do tick(1/60) checkFrame(current) if current~=last then changes=changes+1 last=current end end
assert(changes>=30 and changes<=38,"FPS cap or timeline stalled")
OnDestroy()
`);run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 assert.throws(()=>L.buildLegacy(animation,{fps:-1}),/animation.fpsInvalid/);
 assert.throws(()=>L.buildLegacy(animation,{fps:1.5}),/animation.fpsInvalid/);
 // Stored GIF timing already obeys the selected rate; do not cap it twice.
 const variable={...animation,fps:15,durations:animation.frames.map((_,i)=>i%3===2?.06:.07)};
 fs.writeFileSync(file,stub+L.buildLegacy(variable,{imageTemplateIndex:123,compact:false})+settle+`
OnStart() settle(0) local seen={}
for i=1,180 do tick(1/60) checkFrame(current) seen[current]=true end
local count=0 for _ in pairs(seen) do count=count+1 end assert(count==40,"double FPS cap dropped stored GIF poses") OnDestroy()
`);run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 // Dense and compact fixtures exercise chunk boundaries and watchdog-sized work.
 for(const compact of [false,true]){
  const count=compact?3:2000,frames=compact?animation.frames:Array.from({length:8},(_,f)=>Float64Array.from({length:count*8},(_,i)=>{const id=Math.floor(i/8),field=i%8;return [id%3+1,(id*17+f*3)%5000-2500,(id*11-f*5)%3000-1500,1+(id*7+f)%1200,1+(id*3+f)%900,(id*13+f)%3600-1800,(0xff000000+((id*7919+f*997)%0x1000000)),(id+f*100)%count][field];}));
  const data={...animation,controls:count,frames,durations:Array(frames.length).fill(.05)};
  const expectedFrames=compact?L.compactAnimation(data).frames.map(frame=>Float64Array.from(frame,(v,i)=>{const c=i%8;if(c>=1&&c<=4)return v*5;if(c===5)return v*10;if(c===6)return (v>>>24)*16777216+Math.round(((v>>>16)&255)*255/31)*65536+Math.round(((v>>>8)&255)*255/63)*256+Math.round((v&255)*255/31);return v;})):frames;
  const denseExpected='{'+expectedFrames.map(f=>'{'+Array.from(f).join(',')+'}').join(',')+'}';
  const denseStub=stub.replace(expected,denseExpected).replace('local EXPECTED_CONTROLS=3','local EXPECTED_CONTROLS='+count);
  const ticks=settle.replace('instructions<100000','instructions<1000000');
  fs.writeFileSync(file,denseStub+L.buildLegacy(data,{imageTemplateIndex:123,compact})+ticks+`
OnStart() assert(creations==0 and colorCreates==0,"OnStart must only schedule work") settle(0) checkFrame(1)
local nativeCreates,nativeColors,nativeSibling=creations,colorCreates,siblingWrites
for f=2,#expected do settle(.05) checkFrame(f) end
settle(.05) checkFrame(1)
assert(creations==nativeCreates and colorCreates==nativeColors,"playback allocations") assert(siblingWrites==nativeSibling,"playback must never reorder siblings")
print("PASS bounded Lua load/playback: ${count} controls, compact=${compact}, callbacks="..callbacks..", peak instructions="..peakInstructions..", peak UI writes="..peakWrites)
OnDestroy()
`);
  run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);process.stdout.write(run.stdout);
 }
 const fullFrames=Array.from({length:6},(_,f)=>Float64Array.from({length:2000*8},(_,i)=>{const id=Math.floor(i/8),field=i%8;return [id%3+1,(id*17+f*3)%500-250,(id*11-f*5)%240-120,10+(id+f)%20,10+(id*3+f)%20,(id*13+f)%3600-1800,0xff000000+((id*7919+f*997)%0x1000000),(id+f*100)%2000][field];}));
 const fullExpected='{'+fullFrames.map(f=>'{'+Array.from(f).join(',')+'}').join(',')+'}',fullStub=stub.replace(expected,fullExpected).replace('local EXPECTED_CONTROLS=3','local EXPECTED_CONTROLS=2000');
 fs.writeFileSync(file,fullStub+L.buildLegacy({...animation,controls:2000,frames:fullFrames,durations:Array(6).fill(.05)},{imageTemplateIndex:123,uiBudget:128})+settle+`
OnStart() settle(0) local initialSiblings=siblingWrites local initialCreates,initialColors=creations,colorCreates
for f=2,6 do settle(.05) checkFrame(f) end
assert(peakWrites<=128,"dense frame exceeded the native budget") assert(siblingWrites==initialSiblings,"steady playback sorting")
local seen={} for i=1,360 do tick(1/60) seen[current]=true end local visits=0 for _ in pairs(seen) do visits=visits+1 end assert(visits>=2,"budgeted timeline stalled")
assert(creations==initialCreates and colorCreates==initialColors,"steady allocation")
print("PASS all-on-screen 2,000-control buffering: peak UI writes="..peakWrites..", callbacks="..callbacks) OnDestroy()
`);
 run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);process.stdout.write(run.stdout);
 // Normal game-frame jitter must not collapse throughput to a 128-write budget.
 // All transitions use positive wall time; zero-delta draining would hide stalls.
 for(const [name,intervals] of [['jitter',[1/75,1/50]],['hitch',[1/60,1/60,1/60,1/30]]]){
  fs.writeFileSync(file,fullStub+L.buildLegacy({...animation,controls:2000,frames:fullFrames,durations:Array(6).fill(1/15),fps:15},{imageTemplateIndex:123})+settle+`
OnStart() settle(0) local nativeCreates,nativeColors,nativeSiblings=creations,colorCreates,siblingWrites
local intervals={${intervals.join(',')}} local elapsed=0 local i=0 local changes=0
while elapsed<6 do i=i+1 local dt=intervals[(i-1)%#intervals+1] elapsed=elapsed+dt local last=current tick(dt) if current~=last then changes=changes+1 end end
assert(changes>=${name==='jitter'?65:50},"${name} starved animation: "..changes) assert(uiBudget==MAX_UI_CALLS,"frame jitter throttled UI work")
assert(creations==nativeCreates and colorCreates==nativeColors and siblingWrites==nativeSiblings,"steady allocations/order")
print("PASS 2,000-control ${name} playback: 6s simulated swaps="..changes..", peak UI writes="..peakWrites) OnDestroy()
`);
  run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);process.stdout.write(run.stdout);
 }
 fs.writeFileSync(file,stub+L.buildLegacy(animation,{imageTemplateIndex:123}).replace('local FREEZE_FRAME=0','local FREEZE_FRAME=1')+settle+`
OnStart() settle(0) tick(1/60) assert(not enabled,"frozen diagnostic must stop updates") checkFrame(1) OnDestroy()
`);
 run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 console.log('PASS native Lua: changing Primeval geometry, colors, assets, visibility, exact painter order, looping/catch-up, pooled controls and cleanup');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}}
else console.log('SKIP native animation Lua (lua/texlua unavailable)');
console.log('PASS Primeval shape matching, coordinate roundtrip, painter order and sparse property patches');

const motionWidth=64,motionHeight=64,oldPixels=new Uint8ClampedArray(64*64*4),newPixels=new Uint8ClampedArray(64*64*4);let random=12345;
for(let i=0;i<64*64;i++){random=(Math.imul(random,1664525)+1013904223)>>>0;const value=30+random%160;oldPixels.set([value,value,value,255],i*4);}
for(let y=0;y<64;y++)for(let x=0;x<64;x++){const p=(y*64+x)*4,q=(Math.max(0,y-3)*64+Math.max(0,x-4))*4;for(let c=0;c<3;c++)newPixels[p+c]=oldPixels[q+c]+15;newPixels[p+3]=255;}
const flow=Motion.estimate(oldPixels,newPixels,64,64),v=Motion.sample(flow,32,32);assert.ok(Math.abs(v[0]-4)<.5&&Math.abs(v[1]-3)<.5,'motion prediction follows translation through brightness changes');
const drawing={width:64,height:64,background:[0,0,0,0],shapes:[{kind:'ellipse',geometry:[32,32,3,4,20],color:[1,2,3,255]},{kind:'polygon',geometry:[30,25,25,35,35,35],color:[4,5,6,255]}]};
const predicted=Motion.predict(drawing,flow);assert.equal(predicted.shapes[0].kind,'ellipse');assert.ok(Math.abs(predicted.shapes[0].geometry[2]-3)<.1);assert.equal(predicted.shapes[1].geometry.length,6);assert.ok(Math.abs(predicted.shapes[0].geometry[0]-36)<.5);assert.equal(drawing.shapes[0].geometry[0],32,'prediction leaves original drawing untouched');
const importance={width:16,height:16,values:Float32Array.from({length:256},(_,i)=>i%16/15)},warped=Motion.warpImportance(importance,flow);assert.ok(warped.values.every(v=>Number.isFinite(v)&&v>=0&&v<=1));
const quality=Motion.quality(oldPixels,64,64,oldPixels,64,64,importance);assert.equal(quality.global,0);assert.equal(quality.focus,0);
console.log('PASS motion prediction, brightness invariance, asset-family preservation and Focus quality metrics');

let permutationSeed=7;for(let trial=0;trial<100;trial++){const source=Array.from({length:30},(_,i)=>i),target=source.slice();for(let i=target.length-1;i>0;i--){permutationSeed=(Math.imul(permutationSeed,1664525)+1013904223)>>>0;const j=permutationSeed%(i+1);[target[i],target[j]]=[target[j],target[i]];}const moves=L.planOrder(source,target),actual=source.slice();for(let i=0;i<moves.length;i+=2){const id=moves[i]-1;actual.splice(actual.indexOf(id),1);actual.splice(moves[i+1],0,id);}assert.deepEqual(actual,target);}
const many=Array.from({length:2000},(_,i)=>i),rotated=many.slice(100).concat(many.slice(0,100));assert.equal(L.planOrder(many,rotated).length/2,100,'2,000 controls require only 100 moves when recycling 100 layers');
console.log('PASS minimal painter-order moves for random permutations and 2,000-control recycling');

const recycled=A.packFrame([shape('triangle',51),shape('ellipse',11)],initial,64,32,1,[1,0]);assert.equal(recycled[0],initial[0]);assert.equal(recycled[8],initial[8]);assert.equal(recycled[7],1);assert.equal(recycled[15],0);
const flat=new Uint8ClampedArray(oldPixels.length).fill(255),flatQuality=Motion.quality(flat,64,64,flat,64,64,importance);assert.ok(flatQuality.complexity<quality.complexity*.1,'quality budget responds to current-frame content');
console.log('PASS native identity remapping and content-sensitive quality budgets');

const separated={width:64,height:32,w:16,h:8,cols:2,rows:1,step:6,vectors:new Float32Array([0,0,20,0]),colors:new Float32Array(16*8*3)};for(let y=0;y<8;y++)for(let x=0;x<16;x++)for(let c=0;c<3;c++)separated.colors[(y*16+x)*3+c]=x<8?100:220;
assert.ok(Math.abs(Motion.sample(separated,28,8)[0])<.01,'particle motion does not drag a differently coloured face');
const Primeval=require('../../js/primeval-result.js');assert.doesNotThrow(()=>Primeval.triangle(predicted.shapes[1].geometry));
console.log('PASS edge-aware motion separation and single-asset triangle compatibility');

const thousands=Array.from({length:5000},(_,i)=>shape(i%2?'triangle':'ellipse',i%64));const largeState=A.packFrame(thousands,null,64,32);assert.equal(largeState.length,5000*8);assert.equal(A.elements({width:64,height:32,frames:[largeState]},0).length,5000);console.log('PASS 5,000-shape animation states without truncation');

// Dither-resistant detail checks: preserve outlines without chasing GIF noise.
const dw=64,dh=64,clean=new Uint8ClampedArray(dw*dh*4),dithered=new Uint8ClampedArray(clean.length),opposite=new Uint8ClampedArray(clean.length),smeared=new Uint8ClampedArray(clean.length);
for(let y=0;y<dh;y++)for(let x=0;x<dw;x++){const p=(y*dw+x)*4,v=(Math.floor(x/8)%2)?200:50;for(let c=0;c<3;c++){clean[p+c]=v;dithered[p+c]=v+((x+y)%2?20:-20);opposite[p+c]=v+((x+y)%2?-20:20);}clean[p+3]=dithered[p+3]=opposite[p+3]=smeared[p+3]=255;}
for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)for(let c=0;c<3;c++){let v=0;for(let dx=-5;dx<=5;dx++)v+=clean[(y*dw+Math.max(0,Math.min(dw-1,x+dx)))*4+c]/11;smeared[(y*dw+x)*4+c]=Math.round(v);}
const detailReference=Motion.detailQuality(dithered,dw,dh,clean,dw,dh,null),sameEdges=Motion.detailQuality(opposite,dw,dh,clean,dw,dh,null),blurredEdges=Motion.detailQuality(opposite,dw,dh,smeared,dw,dh,null);
assert.ok(Motion.detailAccepts(detailReference,sameEdges),'GIF dither phase does not reject preserved edges');assert.ok(!Motion.detailAccepts(detailReference,blurredEdges),'smudged outlines fail reuse quality');assert.ok(!Motion.detailAccepts(detailReference,blurredEdges,true),'hopeless warm starts can bypass native refinement');
const PoolPlan=require('../../js/animation-fit-pool.js');const parallelPlan=PoolPlan.plan({num_primitives:1000,primeval_resolution:512,primeval_threads:8},240,240,8,8);assert.equal(parallelPlan.workers,2);assert.ok(parallelPlan.workers*parallelPlan.threads<=8);assert.equal(PoolPlan.plan({primeval_threads:1},240,240,8,8).workers,1);assert.equal(PoolPlan.plan({primeval_threads:16},2048,2048,16,2).workers,1);
console.log('PASS dither-resistant detail rejection and bounded independent fitting CPU/memory planning');

const Media=require('../../js/animation-media.js');const timing=Media.gifTiming(fs.readFileSync(path.join(__dirname,'fixtures/animation/moving.gif')));assert.equal(timing.frames,3);assert.ok(Math.abs(timing.duration-.26)<1e-6);assert.equal(Media.gifTiming(new Uint8Array([1,2,3])),null);
const cutA=new Uint8ClampedArray(64*64*4),cutB=new Uint8ClampedArray(cutA.length);for(let i=0;i<cutA.length;i+=4){cutA.set([70,80,90,255],i);cutB.set([110,120,130,255],i);}assert.ok(Motion.sceneChange(cutA,cutB,64,64).cut,'moderate jump cuts below the old threshold are detected');assert.ok(!Motion.sceneChange(dithered,opposite,dw,dh).cut,'GIF dither does not create a scene cut');
console.log('PASS GIF timing preservation and moderate jump-cut/dither discrimination');

assert.throws(()=>PoolPlan.plan({num_primitives:'invalid'},240,240,8,8),/Invalid shape count/);assert.throws(()=>PoolPlan.plan({primeval_resolution:8},240,240,8,8),/Invalid fitting detail/);

// A moving foreground must not inherit the median stationary background vector.
const movingSize=256,movingBefore=new Uint8ClampedArray(movingSize*movingSize*4),movingAfter=new Uint8ClampedArray(movingBefore.length);
for(let y=0;y<movingSize;y++)for(let x=0;x<movingSize;x++){
 const p=(y*movingSize+x)*4,v=30+((Math.floor(x/7)*17+Math.floor(y/9)*31)%35);
 movingBefore.set([v,v,v,255],p);movingAfter.set([v,v,v,255],p);
}
for(let y=65;y<165;y++)for(let x=50;x<150;x++){
 const hash=(Math.imul(Math.floor((x-50)/8)+1,73856093)^Math.imul(Math.floor((y-65)/8)+1,19349663))>>>0;
 const color=[170+hash%60,100+(hash>>>8)%40,80+(hash>>>16)%40,255];movingBefore.set(color,(y*movingSize+x)*4);movingAfter.set(color,(y*movingSize+x+36)*4);
}
const movingFlow=Motion.estimate(movingBefore,movingAfter,movingSize,movingSize),movingVector=Motion.sample(movingFlow,100,112);
assert.ok(Math.abs(movingVector[0]-36)<2&&Math.abs(movingVector[1])<2,'coarse-to-fine flow follows a 36 px displacement');
assert.ok(Math.hypot(...movingFlow.global)<1,'stationary textured background keeps global motion stationary');
const movingDrawing={width:256,height:256,shapes:[{kind:'ellipse',geometry:[100,112,60,60,0],color:[200,120,100,255]}]},movingPrediction=Motion.predict(movingDrawing,movingFlow);
assert.ok(Math.abs(movingPrediction.shapes[0].geometry[0]-136)<3,'large foreground shape follows local motion');
assert.ok(Math.abs(movingPrediction.shapes[0].geometry[2]-60)<3,'motion boundary does not stretch the shape');
console.log('PASS large foreground displacement against a stationary textured background');

const Progress=require('../../js/animation-progress.js'),progressMessages=[],progressStream=new Progress.Stream(m=>progressMessages.push(m),{sourceFrame:3,totalSource:8,shapeCount:2000});
progressStream.last=performance.now();
progressStream.push({shapeSvg:'layer 2',previewIndex:2,step:3,phase:'fit'});
progressStream.push({shapeSvg:'layer 3',previewIndex:3,step:4,phase:'fit'});
progressStream.push({shapeSvg:'updated layer 2',previewIndex:2,step:5,phase:'fit'});
progressStream.flush();
assert.deepEqual(progressMessages.flatMap(m=>m.previewShapes),[{previewIndex:2,shapeSvg:'updated layer 2'},{previewIndex:3,shapeSvg:'layer 3'}],'coalescing preserves each changed layer and its latest value');
assert.equal(progressMessages.at(-1).sourceFrame,3);assert.equal(progressMessages.at(-1).step,5);
progressStream.last=performance.now();progressStream.push({previewSvg:'native snapshot',directSvg:true,step:2000,phase:'refine'});progressStream.flush();
assert.equal(progressMessages.at(-1).directSvg,true);assert.equal(progressMessages.at(-1).previewSvg,'native snapshot');
assert.deepEqual(progressMessages.at(-1).previewShapes,[],'snapshot resets pending layers');
console.log('PASS bounded live progress coalescing without losing shape layers');

const Sequences=require('../../js/animation-sequences.js');
const sequenceConfig={num_primitives:2000,primeval_resolution:512,primeval_threads:16};
assert.deepEqual(Sequences.plan(sequenceConfig,498,498,28,16,32),{workers:8,budget:16,threads:2,prefix:8,latencyThreads:4});
assert.equal(Sequences.plan(sequenceConfig,498,498,28,16,8).workers,4,'smaller memory budget bounds concurrent fits');
assert.equal(Sequences.plan(sequenceConfig,498,498,28,16,2).workers,1);
assert.equal(Sequences.plan(sequenceConfig,498,498,8,16,32).workers,4,'short clips share a first fit across concurrent warm starts');
assert.equal(Sequences.plan({...sequenceConfig,animation_parallel:false},498,498,28,16,32).workers,1);
assert.equal(Sequences.plan(sequenceConfig,498,498,28,16,32,4).workers,4);
const splitFrames=Sequences.split(Array.from({length:20},(_,i)=>i+8),8);assert.deepEqual(splitFrames.flat(),Array.from({length:20},(_,i)=>i+8));assert.ok(splitFrames.every(chunk=>chunk.length>=2&&chunk.length<=3));
const localFirst=A.packFrame([shape('ellipse',53),shape('triangle',13)],null,64,32),localNext=localFirst.slice();localNext[1]+=30;localNext[6]=0xff8090a0;
const stitched=Sequences.stitch([localFirst,localNext],initial,64,32,1,A);
const comparable=frame=>A.elements({width:64,height:32,frames:[frame]},0).map(({id,...element})=>element);
assert.deepEqual(comparable(stitched[0]),comparable(localFirst));assert.deepEqual(comparable(stitched[1]),comparable(localNext));
const localChangedSlot=0,globalChangedSlot=stitched[0].findIndex((value,i)=>i%8===7&&value===localFirst[7])-7;
assert.equal(stitched[1][globalChangedSlot+1]-stitched[0][globalChangedSlot+1],30,'sequence-local identities retain one mapping across all later frames');
assert.equal(stitched[1][globalChangedSlot+6],0xff8090a0);
assert.deepEqual(localFirst,A.packFrame([shape('ellipse',53),shape('triangle',13)],null,64,32),'stitching leaves child frames intact');
console.log('PASS bounded sequence planning, ordered partitions and stable cross-sequence control identities');

const cutRows=Array.from({length:20},(_,i)=>({source:i,cut:i===4})),cutChunks=Sequences.split(cutRows,8);assert.deepEqual(cutChunks.flat(),cutRows);assert.ok(cutChunks.some(chunk=>chunk[0].source===4),'hard cuts start a new sequence instead of overloading one worker');assert.ok(cutChunks.every(chunk=>chunk.length));console.log('PASS cut-aware partitions preserve every frame without empty jobs');

// A pooled representation must fit globally, even if each sequence fits alone.
(async()=>{
 const savedWorker=global.Worker,savedCore=global.AnimationCore,workers=[];let childError=false;
 class LimitWorker{constructor(){workers.push(this);}terminate(){this.terminated=true;}postMessage(message){queueMicrotask(()=>{if(childError){this.onmessage({data:{type:'error',message:'animation.limit',detail:'private engine detail'}});return;}const controls=message.sequence.indices[0]===0?2:3;this.onmessage({data:{type:'done',poster:new ArrayBuffer(0),result:{config:{},animation:{width:32,height:16,unit:1,controls,frames:[new Float64Array(controls*8)],metrics:{keyframes:1,refined:0,repeated:0}}}}});});}}
 global.Worker=LimitWorker;global.AnimationCore={MEMORY:320};
 const msg={file:{},config:{}},prepared={rows:[{index:0,source:0},{index:1,source:1}],total:2,origin:0,width:32,height:16,endTime:.2},options={workers:2,threads:1,prefix:0,latencyThreads:1};
 try{await assert.rejects(Sequences.run(msg,prepared,options,performance.now(),()=>{}),/animation\.limit/);assert.ok(workers.every(worker=>worker.terminated),'resource failure terminates every child');childError=true;await assert.rejects(Sequences.run(msg,prepared,options,performance.now(),()=>{}),/animation\.limit/,'nested failures retain the localized resource error code');console.log('PASS global pooled-memory limit, nested error propagation and child cleanup');}
 finally{if(savedWorker===undefined)delete global.Worker;else global.Worker=savedWorker;if(savedCore===undefined)delete global.AnimationCore;else global.AnimationCore=savedCore;}
})().catch(error=>{console.error(error);process.exitCode=1;});

assert.deepEqual(Sequences.timing([{timestamp:0,duration:.0005},{timestamp:.0005,duration:.0005}],.001),[.0005,.001],'intermediate high-rate frames retain their native duration');assert.deepEqual(Sequences.timing([{timestamp:0,duration:.07},{timestamp:0,duration:.11},{timestamp:.1,duration:.08}],.18),[.07,.1,.07999999999999999],'duplicate timestamps keep source durations and ordinary boundaries use the next presentation time');console.log('PASS native timing semantics for high-rate and duplicate presentation timestamps');

// Upgrading a saved export must preserve its payload, quantization and scale.
{
 const Upgrader=require('../../scripts/upgrade-animation-player.cjs');
 const source=global.AnimationLua ? global.AnimationLua : require('../../js/animation-lua.js');
 const original=source.build({width:32,height:16,controls:1,frames:[new Float64Array(8)],durations:[.1],fps:15},{imageTemplateIndex:1073775004,width:123.45,compact:true});
 const before=Upgrader.extract(original),after=Upgrader.extract(Upgrader.upgrade(original).code);
 assert.deepEqual(after.lines,before.lines,'all saved header literals survive player replacement');
 assert.throws(()=>Upgrader.upgrade(original.replace(/^local DATA=.*$/m,'local DATA=execute()')),/Invalid encoded data/);
 assert.throws(()=>Upgrader.upgrade(original.replace(/^local books=.*$/m,'local books={execute()}')),/Invalid literal/);
 assert.doesNotThrow(()=>Upgrader.extract(original.replace(/^local DATA=.*$/m,'local DATA=""')),'zero-bit Huffman streams are valid');
 console.log('PASS saved-player upgrades preserve payload and reject executable headers');
}

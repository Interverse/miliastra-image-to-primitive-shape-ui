/* Native-Lua player validation against decoded export data; no game FPS claim. */
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');const {extract}=require('./upgrade-animation-player.cjs');
const [input,output]=process.argv.slice(2);const source=fs.readFileSync(input,'utf8'),meta=extract(source),[displayWidth,width,height,count]=meta.dimensions;
const player=fs.readFileSync(output,'utf8'),mode=player.match(/^local VARIANT="(fast|preloaded|pipeline)"$/m)?.[1]||'buffered';
const profile=process.argv[4]||'steady';
const minTransitions=Number(process.argv[5]||0);if(!Number.isSafeInteger(minTransitions)||minTransitions<0)throw Error('Invalid minimum transition count');
const intervals={steady:[1/60],controls:[1/60],jitter:[1/75,1/50],slow:[1/30],hitch:[1/60,1/60,1/60,1/60,1/60,1/30],cancel:[1/60],cancel_native:[1/60],seek:[1/60],vm:[1/60]}[profile];
if(!intervals)throw Error('Unknown playback profile');
const {decode,expand}=require('./animation-payload.cjs');
if(player.includes('local LOSSLESS_DRAW_ORDER=true')){const proof=require('./verify-animation-order.cjs').verify(source,player);console.log('PASS offline order proof '+JSON.stringify(proof));}
const decoded=decode(player.includes('local LOSSLESS_DRAW_ORDER=true')?player:source),frames=decoded.frames.map(frame=>expand(frame,meta.compact));
const lua=['lua','texlua'].find(c=>{const p=spawnSync(c,['--version'],{encoding:'utf8'});return !p.error&&p.status===0;});if(!lua)throw Error('Native Lua unavailable');
const expected='{'+frames.map(f=>'{'+Array.from(f).join(',')+'}').join(',')+'}',scale=displayWidth/width*.1;
const nativeHost='local BOUND_SEQUENCE_METHODS='+(process.env.BIND_METHODS==='1'?'true':'false')+'\n'+fs.readFileSync(path.join(__dirname,'lua/animation-native-mock.lua'),'utf8')+(process.env.NO_NATIVE_SEQUENCE==='1'?'\ngame.TweenSequence=nil game.Tween=nil\n':'');
const stub=`local nodes={} local writes=0 local creates=0 local siblings=0 local colorCreates=0 local enabled=false local destroys=0 local methodReads=0 local resizeWrites=0 local scaleWrites=0 local imageWrites=0
local Control={}
function Control:SetActive(v) self.active=v writes=writes+1 end function Control:SetVisible(v) self.visible=v writes=writes+1 end
function Control:SetAnchorMin(x,y) self.ax=x self.ay=y end function Control:SetAnchorMax(x,y) self.amx=x self.amy=y end function Control:SetPivot(x,y) self.pvx=x self.pvy=y end
function Control:GetAnchorMin() return self.ax,self.ay end function Control:GetAnchorMax() return self.amx,self.amy end function Control:GetPivot() return self.pvx,self.pvy end
function Control:SetSizeDelta(w,h) self.w=w self.h=h writes=writes+1 resizeWrites=resizeWrites+1 end function Control:SetAnchoredPosition(x,y) self.x=x self.y=y writes=writes+1 end
function Control:SetLocalRotation(x,y,z) self.r=z writes=writes+1 end function Control:SetLocalScale(x,y,z) self.sx=x self.sy=y self.sz=z writes=writes+1 scaleWrites=scaleWrites+1 end
function Control:SetImage(source,asset) self.asset=asset writes=writes+1 imageWrites=imageWrites+1 end
function Control:GetAnchoredPosition() return self.x or 0,self.y or 0 end
function Control:GetSizeDelta() return self.w or 0,self.h or 0 end
function Control:GetLocalScale() return self.sx or 1,self.sy or 1,self.sz or 1 end
function Control:GetLocalRotation() return 0,0,self.r or 0 end
function Control:SetSiblingIndex(i) assert(math.type(i)=="integer") local hook,mask,count=debug.gethook() debug.sethook() local children=self.parent.children for j,c in ipairs(children) do if c==self then table.remove(children,j) break end end table.insert(children,i+1,self) siblings=siblings+1 writes=writes+1 if hook then debug.sethook(hook,mask,count) end end
local function destroy(c) c.alive=false for _,child in ipairs(c.children) do destroy(child) end end
local owner={children={}} game={InstantiateClientUIControl=function(index,parent) assert(index==${meta.templateIndex}) creates=creates+1 local c=setmetatable({children={},parent=parent,alive=true,properties={}},{__index=function(t,k) if k=="imageId" then return rawget(t,"asset") end local method=Control[k] if method then methodReads=methodReads+1 if ${process.env.BIND_METHODS==='1'?'true':'false'} then return function(receiver,...) assert(receiver==t,"cached method receiver changed") return method(receiver,...) end end return method end return t.properties[k] end,__newindex=function(t,k,v) if k=="imageColor" then t.properties[k]=v writes=writes+1 elseif k=="localRotationZ" then rawset(t,"r",v) writes=writes+1 else rawset(t,k,v) end end}) parent.children[#parent.children+1]=c nodes[#nodes+1]=c return c end,DestroyClientUIControl=function(c) destroys=destroys+1 destroy(c) end}
Color={FromRGBA=function(r,g,b,a) colorCreates=colorCreates+1 return a*16777216+r*65536+g*256+b end} Enum={ImageSource={StaticReference=1},ImageType={Stretch=1}} script={object=owner,EnableUpdate=function(self,v) enabled=v end}
Color.ToRGBA=function(c)return math.floor(c/65536)%256,math.floor(c/256)%256,c%256,math.floor(c/16777216) end
local expected=${expected}
local function verify(f)
 local group=nil local active=0 if "${mode}"=="fast" then group=nodes[1] else for _,g in ipairs(nodes[1].children) do if g.active and g.visible then group=g active=active+1 end end assert(active==1,"torn visibility") end
 local state=expected[f] local byOrder={} local assets={100002,100001,100003,106057}
 for id=1,${count} do local a=(id-1)*8 if state[a+1]~=0 and math.floor(state[a+7]/16777216)>0 then local co,si=math.abs(math.cos(state[a+6]*.1*math.pi/180)),math.abs(math.sin(state[a+6]*.1*math.pi/180));local rx,ry=(state[a+4]*co+state[a+5]*si)*.05,(state[a+4]*si+state[a+5]*co)*.05;local x,y=state[a+2]*.1,state[a+3]*.1;if x+rx>=${-width/2-2} and x-rx<=${width/2+2} and y+ry>=${-height/2-2} and y-ry<=${height/2+2} then byOrder[state[a+8]+1]=id end end end
 local dense=0 for slot=1,${count} do local id=byOrder[slot] if id then dense=dense+1 end local index="${mode}"=="preloaded" and dense or slot local c=group.children[index] if not id then if "${mode}"~="preloaded" then assert(not c.visible,"visible empty slot") end else local a=(id-1)*8 assert(c and c.visible and c.asset==assets[state[a+1]],"asset") assert(math.abs(c.x-state[a+2]*${scale})<.00001 and math.abs(c.y-state[a+3]*${scale})<.00001,"position") assert(math.abs(c.w*(c.sx or 1)-state[a+4]*${scale})<.00001 and math.abs(c.h*(c.sy or 1)-state[a+5]*${scale})<.00001,"size") assert(math.abs(c.r-state[a+6]*.1)<.00001,"rotation") assert(c.imageColor==state[a+7],"colour") end end
 if "${mode}"=="preloaded" then assert(#group.children==dense,"extra cached primitives") end
end
`;
const playerStartLine=(stub+nativeHost).split('\n').length,playerEndLine=playerStartLine+player.split('\n').length-1;
const durations=meta.durations.map(n=>n/1e6),steps=durations.slice(0,-1).map((dt,i)=>`settle(${dt}+.00000001) assert(current==${i+2}) verify(current)`).join('\n');
let seekClock=0,seekDisplay=0,seekFrame=0;
const seekTotal=meta.durations.reduce((a,b)=>a+b,0),seekLoop=meta.lines.LOOP.trim()==='true',seekFPS=Number(meta.lines.PLAYBACK_FPS.split('--')[0]),encodedFPS=Number(meta.lines.ENCODED_FPS);
const seekSteps=[0,-.25,...Array(24).fill(1/60),.3,2,5.231,10000.125,.00001,.04,...Array(20).fill(.09)].map(dt=>{
 seekClock+=Math.max(0,dt)*1e6;seekDisplay+=Math.max(0,dt);if(!seekLoop&&seekClock>=seekTotal)seekClock=seekTotal-.001;
 const limited=seekFPS>0&&seekFPS!==encodedFPS,terminal=!seekLoop&&seekClock>=seekTotal-.001;
 if(!limited||seekDisplay>=1/seekFPS||terminal){const phase=seekLoop?seekClock%seekTotal:seekClock;let end=0,target=0;for(;target<meta.durations.length-1;target++){end+=meta.durations[target];if(phase<end)break;}
  if(target!==seekFrame){seekFrame=target;if(limited)seekDisplay%=1/seekFPS;else seekDisplay=0;}}
 return `tick(${dt}) assert(current==${seekFrame+1},"timeline seek/cap mismatch")`;
}).join('\n');
const checks=profile==='controls'?`
function script:Invoke(name)
 if name=="Play" then return Play() elseif name=="Stop" then return Stop() elseif name=="Restart" then return Restart() end error("Unknown method")
end
assert(script:Invoke("Stop") and not enabled,"safe before OnStart") assert(script:Invoke("Play") and not enabled)
OnStart() assert(enabled) script:Invoke("Stop") assert(enabled,"stopping playback must not abandon loading")
OnUpdate(0) script:Invoke("Restart") script:Invoke("Stop")
for i=1,100000 do if ready then break end OnUpdate(0) end assert(ready and current==1 and not enabled,"paused startup") verify(1)
local initialCreates,initialColors,initialSiblings=creates,colorCreates,siblings
script:Invoke("Play") assert(enabled) OnUpdate(${durations[0]}+.0000001) assert(current==2) verify(2)
script:Invoke("Stop") local paused,pausedClock,pausedWrites=current,clock,writes+nativeCalls
OnUpdate(10000) script:Invoke("Stop") assert(current==paused and clock==pausedClock and writes+nativeCalls==pausedWrites and not enabled,"Stop freezes the pose and timeline")
script:Invoke("Play") OnUpdate(.001) verify(current)
script:Invoke("Restart") assert(current==1 and clock==0 and displayClock==0 and enabled) verify(1)
OnUpdate(${durations[0]}+.0000001) assert(current==2,"restart resets cached deadlines") verify(2)
OnUpdate(total/1000000*5+.02) verify(current)
if not LOOP then assert(not enabled and current==#ends) script:Invoke("Play") assert(current==1 and enabled,"Play replays a completed clip") else script:Invoke("Restart") end
verify(1) OnUpdate(${durations[0]}+.0000001) assert(current==2) verify(2)
assert(creates==initialCreates and colorCreates==initialColors and siblings==initialSiblings,"controls allocated native resources")
OnDestroy() local deadWrites=writes+nativeCalls
assert(not script:Invoke("Play") and not script:Invoke("Stop") and not script:Invoke("Restart") and not enabled,"destroyed player cannot restart")
OnUpdate(1) assert(writes+nativeCalls==deadWrites) for _,c in ipairs(nodes) do assert(not c.alive) end
print("PASS ${mode}: invoked Play/Stop/Restart before/during/after loading, pause/resume, rewind, completed replay, loop deadlines and destruction")
`:profile==='cancel'||profile==='cancel_native'?`
OnStart() for i=1,100000 do OnUpdate(0) if ${profile==='cancel_native'?'tweenCreates>0':'root and #root.children>0 and ("'+mode+'"=="fast" or #root.children[1].children>0)'} then break end end
assert(root and not ready,"must cancel a partial hierarchy during startup") OnDestroy()
assert(not enabled and destroys==1,"cancel cleanup") for _,c in ipairs(nodes) do assert(not c.alive,"leaked startup control") end OnDestroy() OnUpdate(1) assert(destroys==1) assert(liveTweens==0 and liveSequences==0,"leaked partial native cache")
print("PASS ${mode}: cancelled partial startup with "..creates.." owned controls; no leaks")
`:profile==='seek'?`
local function tick(dt) OnUpdate(dt) if ready then verify(current) end end
OnStart() for i=1,100000 do if ready then break end tick(0) end assert(ready,"startup stalled")
local nativeCreates,nativeColors,nativeSiblings=creates,colorCreates,siblings local startReads=methodReads local startResizes=resizeWrites
${seekSteps}
assert(creates==nativeCreates and colorCreates==nativeColors and siblings==nativeSiblings,"seek allocated/reordered controls")
${player.includes('local TRANSFORM_GEOMETRY=')?'assert(methodReads==startReads,"seek must use cached methods")':''}
${player.includes('local TRANSFORM_GEOMETRY=true')?'assert(resizeWrites==startResizes,"seek must use transform geometry")':''}
OnDestroy() assert(not enabled and destroys==1) for _,c in ipairs(nodes) do assert(not c.alive) end assert(liveTweens==0 and liveSequences==0,"leaked snapshots after seeks")
print("PASS ${mode}: deadline seeks, negative deltas, long stalls, loops and explicit FPS cap")
`:profile==='vm'?`
OnStart() for i=1,100000 do if ready then break end OnUpdate(0) end assert(ready,"startup stalled") verify(current)
local totalScript,peakScript,swaps=0,0,0 local beforeWrites=writes local initialCreates,initialColors=creates,colorCreates
for i=1,180 do
 local count=0 local previous=current
 debug.sethook(function() local info=debug.getinfo(2,"l") if info.currentline>=${playerStartLine} and info.currentline<=${playerEndLine} then count=count+1 end end,"",1)
 OnUpdate(1/60) debug.sethook() totalScript=totalScript+count peakScript=math.max(peakScript,count)
 if current~=previous then swaps=swaps+1 end verify(PROFILE_LUA_ONLY and startFrame() or current)
end
assert(creates==initialCreates and colorCreates==initialColors,"playback allocated UI/colors")
if PROFILE_LUA_ONLY then assert(writes==beforeWrites and swaps>1,"Lua-only diagnostic must execute frames without native writes") end
print("PASS script-only VM: transitions="..swaps..", total="..totalScript..", peak="..peakScript..", instructions per transition="..math.floor(totalScript/math.max(1,swaps))..", UI writes="..(writes-beforeWrites))
OnDestroy() for _,c in ipairs(nodes) do assert(not c.alive) end
`:`
local callbacks=0 local peak=0 local transitions=0 local instructions=0 local peakInstructions=0 local peakLoad=0
local startupCallbacks,firstVisible,peakSpawns,peakColors,startupInstructions=0,0,0,0,0 local phases={decode=0,preview=0,prepare=0}
local function tick(dt)
 local before=writes local beforeNative=nativeCalls local beforeCreates,beforeColors=creates,colorCreates local init=loading local count=0
 if init then local phase=previewLoading and "preview" or (type(stage)=="number" and stage<=7 and "decode" or "prepare") phases[phase]=phases[phase]+1 end
 debug.sethook(function() count=count+100 assert(count<1000000,"callback instruction budget exceeded") end,"",100) OnUpdate(dt) debug.sethook()
 if not init then local used=writes-before+nativeCalls-beforeNative instructions=instructions+count peakInstructions=math.max(peakInstructions,count) peak=math.max(peak,used) assert(used<=(MAX_FRAME_CALLS or MAX_UI_CALLS),"UI budget exceeded")
 else
  startupCallbacks=startupCallbacks+1 startupInstructions=startupInstructions+count peakLoad=math.max(peakLoad,count) peakSpawns=math.max(peakSpawns,creates-beforeCreates) peakColors=math.max(peakColors,colorCreates-beforeColors)
  if COLOR_BATCH then assert(colorCreates-beforeColors<=COLOR_BATCH+1,"startup color budget exceeded") end
  if SPAWN_BATCH then assert(creates-beforeCreates<=SPAWN_BATCH+1,"startup spawn budget exceeded") end
  if root and root.visible then if firstVisible==0 then firstVisible=startupCallbacks end if not ready then verify(type(startFrame)=="function" and startFrame() or 1) end end
 end
 callbacks=callbacks+1 if ready then verify(current) end
end
local function settle(dt) tick(dt) for i=1,100000 do if not loading and ready and not job then return end tick(0) end error("stalled") end
OnStart() settle(0) verify(1) local initialCreates,initialColors,initialSiblings=creates,colorCreates,siblings local initialTweens,initialSequences=tweenCreates,sequenceCreates
print("PASS startup: callbacks="..startupCallbacks..", first visible="..firstVisible..", decoding="..phases.decode..", first-pose setup="..phases.preview..", final preparation="..phases.prepare..", peak controls created/update="..peakSpawns..", peak colors created/update="..peakColors..", Lua instructions="..startupInstructions)
if FREEZE_FRAME==0 then ${steps} end
assert(creates==initialCreates and colorCreates==initialColors,"playback allocation") assert(siblings==initialSiblings,"playback hierarchy change")
instructions=0 peakInstructions=0 peak=0 local profileStartWrites=writes+nativeCalls local startInternal=internalWrites local startReads=methodReads local startResizes=resizeWrites local startScales=scaleWrites local startImages=imageWrites local intervals={${intervals.join(',')}} local elapsed=0 local i=0 local seen={}
if LOOP and #ends>1 and FREEZE_FRAME==0 then
 while elapsed<6 do i=i+1 local dt=intervals[(i-1)%#intervals+1] elapsed=elapsed+dt local last=current tick(dt) if current~=last then transitions=transitions+1 end seen[current]=true end local distinct=0 for _ in pairs(seen) do distinct=distinct+1 end assert(distinct>1,"clock stalled")
else tick(100) verify(current) assert(not enabled,"static/final pose must disable updates") end
assert(transitions>=${minTransitions},"playback throughput regression: "..transitions)
assert(creates==initialCreates and colorCreates==initialColors and siblings==initialSiblings,"steady native allocation/order")
assert(tweenCreates==initialTweens and sequenceCreates==initialSequences,"steady native snapshot allocation")
${player.includes('local TRANSFORM_GEOMETRY=')?'assert(methodReads==startReads,"playback must use cached native methods")':''}
${player.includes('local TRANSFORM_GEOMETRY=true')?'assert(resizeWrites==startResizes,"playback must not resize quad meshes")':''}
print("PASS original export (${mode}/${profile}): ${count} controls, ${frames.length} frames; peak Lua/native submissions="..peak..", creations="..creates..", cached tweens="..tweenCreates..", cached sequences="..sequenceCreates..", steady sibling writes="..(siblings-initialSiblings)..", callbacks="..callbacks..", 6s simulated swaps="..transitions..", peak load instructions="..peakLoad..", peak playback instructions="..peakInstructions..", instructions per transition="..math.floor(instructions/math.max(1,transitions))..", Lua/native submissions per transition="..math.floor((writes+nativeCalls-profileStartWrites)/math.max(1,transitions))..", internal endpoint writes per transition="..math.floor((internalWrites-startInternal)/math.max(1,transitions))..", method reads per transition="..math.floor((methodReads-startReads)/math.max(1,transitions))..", resizes per transition="..math.floor((resizeWrites-startResizes)/math.max(1,transitions))..", scales per transition="..math.floor((scaleWrites-startScales)/math.max(1,transitions))..", image changes per transition="..math.floor((imageWrites-startImages)/math.max(1,transitions))) OnDestroy()
assert(not enabled and destroys==1,"cleanup") for _,c in ipairs(nodes) do assert(not c.alive,"leaked child") end
OnDestroy() OnUpdate(1) assert(destroys==1 and creates==initialCreates,"cleanup must be idempotent") assert(liveTweens==0 and liveSequences==0,"leaked native snapshots")
`;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mililua-playback-'));try{const file=path.join(tmp,'test.lua');fs.writeFileSync(file,stub+nativeHost+player+checks);const result=spawnSync(lua,[file],{encoding:'utf8',maxBuffer:1024*1024});if(result.status)throw Error(result.stdout+result.stderr);process.stdout.write(result.stdout);}finally{fs.rmSync(tmp,{recursive:true,force:true});}

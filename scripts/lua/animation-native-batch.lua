-- Same standalone player and UI hierarchy. Native snapshots replace scalar Lua calls.
local TRANSFORM_GEOMETRY=true
local TWEEN_BATCH=24 -- bounded startup work; all snapshots exist before playback.
local controlsState,assetOps,visibilityOps,frameBatches,uniqueBatches,frameCache
local initStage,initFrame,initSlot,initial,nextDue,cycleStart
local SHARED_METHODS,signature
local STATIC=Enum.ImageSource.StaticReference
local MAX_FRAME_CALLS=2*N+2
local function configureInitial(s,frame,a)
 local kind=frame[a+1] if not kind then return end local control=s[1]
 s[2](control,STATIC,assets[kind]) s[4](control,frame[a+2],frame[a+3])
 if TRANSFORM_GEOMETRY then s[5](control,frame[a+4],frame[a+5],1) else s[5](control,frame[a+4],frame[a+5]) end
 s[6](control,0,0,frame[a+6]) control.imageColor=frame[a+7] s[3](control,true)
end
variantStart=function()
 controlsState={} assetOps={} visibilityOps={} frameBatches={} uniqueBatches={} frameCache={}
 SHARED_METHODS=true initStage=1 initFrame=1 initSlot=1 initial=startFrame() nextDue=ends[initial] cycleStart=0
end
variantLoad=function()
 if initStage==1 then
  local stop=math.min(N,initSlot+SPAWN_BATCH-1) for id=initSlot,stop do
   local control=image(root) controls[id]=control local s={control,control.SetImage,control.SetVisible,control.SetAnchoredPosition,TRANSFORM_GEOMETRY and control.SetLocalScale or control.SetSizeDelta,control.SetLocalRotation} controlsState[id]=s
   control:SetLocalScale(1,1,1) control:SetLocalRotation(0,0,0)
   if not signature then signature=s end for field=2,6 do if type(s[field])~="function" or s[field]~=signature[field] then SHARED_METHODS=false break end end
   if TRANSFORM_GEOMETRY then control:SetSizeDelta(1,1) end configureInitial(s,keys[initial],(id-1)*8)
  end initSlot=stop+1 if initSlot>N then initStage=2 initSlot=1 end
 elseif initStage==2 then
  local stop=math.min(N,initSlot+ORDER_BATCH-1) for id=initSlot,stop do controls[id]:SetSiblingIndex(math.floor(id-1)) end initSlot=stop+1 if initSlot>N then root:SetVisible(true) initStage=3 initSlot=1 end
 elseif initStage==3 then
  if FREEZE_FRAME>0 or #ends==1 then initStage=4 return end
  local frame=keys[initFrame] local prior=keys[initFrame==1 and #keys or initFrame-1]
  local batch=frameBatches[initFrame]
  if not batch then
   batch=frameCache[frame] if batch then frameBatches[initFrame]=batch else batch={started=false,children={}} frameCache[frame]=batch frameBatches[initFrame]=batch end
   assetOps[initFrame]={} visibilityOps[initFrame]={}
  end
  local firstForFrame=not batch.built local stop=math.min(N,initSlot+TWEEN_BATCH-1)
  for id=initSlot,stop do
   local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1] local receiver=SHARED_METHODS and controls[id] or controlsState[id]
   if kind and kind~=old then local t=assetOps[initFrame] t[#t+1]=receiver t[#t+1]=assets[kind] end
   if (kind~=nil)~=(old~=nil) then local t=visibilityOps[initFrame] t[#t+1]=receiver t[#t+1]=kind~=nil end
   if firstForFrame and kind then
    local target={anchoredPositionX=frame[a+2],anchoredPositionY=frame[a+3],localRotationZ=frame[a+6],imageColor=frame[a+7]}
    if TRANSFORM_GEOMETRY then target.localScaleX=frame[a+4] target.localScaleY=frame[a+5] else target.sizeDeltaX=frame[a+4] target.sizeDeltaY=frame[a+5] end
    if not batch.object then
     local sequence=game.TweenSequence() assert(sequence,"Native snapshot sequence creation failed") batch.object=sequence batch.play=sequence.Play batch.restart=sequence.Restart batch.complete=sequence.Complete batch.kill=sequence.Kill uniqueBatches[#uniqueBatches+1]=batch
    end
    local tween=game.Tween(controls[id],target,1) assert(tween,"Native snapshot Tween creation failed")
    if #batch.children==0 then batch.object:Append(tween) else batch.object:Join(tween) end
    batch.children[#batch.children+1]=tween
   end
  end
  initSlot=stop+1 if initSlot>N then batch.built=true initSlot=1 initFrame=initFrame+1 if initFrame>#keys then initStage=4 end end
 else
  if SHARED_METHODS then controlsState=nil end colors=nil frameCache=nil finishLoading()
 end
end
local function imageChanges(target)
 local frame,prior=keys[target],keys[current]
 for id=1,N do local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1] local control=controls[id] local s=SHARED_METHODS and signature or controlsState[id]
  if kind and kind~=old then s[2](control,STATIC,assets[kind]) end
  if (kind~=nil)~=(old~=nil) then s[3](control,kind~=nil) end
 end
end
variantUpdate=function(target)
 if keys[target]==keys[current] then return end
 if target==current%#ends+1 then
  local t=assetOps[target]
  if SHARED_METHODS then local set=signature[2] for i=1,#t,2 do set(t[i],STATIC,t[i+1]) end else for i=1,#t,2 do local s=t[i] s[2](s[1],STATIC,t[i+1]) end end
  t=visibilityOps[target]
  if SHARED_METHODS then local set=signature[3] for i=1,#t,2 do set(t[i],t[i+1]) end else for i=1,#t,2 do local s=t[i] s[3](s[1],t[i+1]) end end
 else imageChanges(target) end
 local batch=frameBatches[target]
 if batch.object then
  if batch.started then batch.restart(batch.object) else batch.play(batch.object) batch.started=true end
  batch.complete(batch.object)
 end
end
variantReset=function(target)
 if target~=current then variantUpdate(target) end current=target cycleStart=0 nextDue=ends[target]
end
variantTick=function(dt)
 clock=clock+dt*1000000 local finished=not LOOP and clock>=total-.001 if finished then clock=total-.001 end
 local limited=PLAYBACK_FPS>0 and PLAYBACK_FPS~=ENCODED_FPS if limited then displayClock=displayClock+dt end
 if clock<nextDue and not finished then return end if limited and displayClock<1/PLAYBACK_FPS and not finished then return end
 local target=current%#ends+1 local start=cycleStart if current==#ends then start=start+total end
 if finished then target=#ends start=0 elseif clock<start+(ends[target-1] or 0) or clock>=start+ends[target] then target=frameAt(clock) start=LOOP and math.floor(clock/total)*total or 0 end
 if target~=current then variantUpdate(target) current=target if limited then displayClock=displayClock%(1/PLAYBACK_FPS) end end
 cycleStart=start nextDue=start+ends[target] if finished then script:EnableUpdate(false) end
end
variantBeforeDestroy=function()
 if uniqueBatches then for i=1,#uniqueBatches do local batch=uniqueBatches[i] batch.kill(batch.object,false) end end
 uniqueBatches=nil
end
variantDestroy=function()
 controlsState=nil signature=nil assetOps=nil visibilityOps=nil frameBatches=nil frameCache=nil
end

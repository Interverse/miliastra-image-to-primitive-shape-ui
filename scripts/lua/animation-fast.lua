-- One persistent pool; grouped commands and native methods are cached at startup.
-- Fixed unit-size quads express geometry through transforms, without layout resizing.
local TRANSFORM_GEOMETRY=true -- false restores size-delta updates for comparison.
local PROFILE_LUA_ONLY=false -- Diagnostic: animate Lua shadow controls; keep the real first pose frozen.
local NATIVE_TRANSACTION_MODE=0 -- 0=direct, 1=inactive, 2=hidden, 3=zero-scale edits.
local AUTO_NATIVE_UPDATES=false -- Research-only: live trials can cause visible hitches.
local NATIVE_TEST_SECONDS=6 -- Each phase; calibration usually takes 24-36 seconds.
local commands,skipCommands,slots,groups,commonSlot,initStage,initFrame,initSlot,initDistance,initial,nextDue,cycleStart
local SHARED_METHODS,SET_IMAGE,SET_VISIBLE,SET_POSITION,SET_DIMENSIONS,SET_ROTATION
local MAX_FRAME_CALLS=6*N+2
local STATIC=Enum.ImageSource.StaticReference
local function profileNoop() end
-- @NATIVE_TRANSACTION@
-- @FAST_DISPATCH@
local function compile(frame,prior,buckets,id)
 local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1]
 local asset=kind and kind~=old
 local visible=(kind~=nil)~=(old~=nil)
 local position=kind and (not old or frame[a+2]~=prior[a+2] or frame[a+3]~=prior[a+3])
 local size=kind and (not old or frame[a+4]~=prior[a+4] or frame[a+5]~=prior[a+5])
 local rotation=kind and (not old or frame[a+6]~=prior[a+6])
 local color=kind and (not old or frame[a+7]~=prior[a+7])
 local mask=(asset and 1 or 0)+(visible and 2 or 0)+(position and 4 or 0)+(size and 8 or 0)+(rotation and 16 or 0)+(color and 32 or 0)
 if mask==0 then return end
-- @APPEND_COMMAND@
end
local function configureFast(s,frame,a)
 local kind=frame[a+1] if not kind then return end local control=s[1]
 s[2](control,STATIC,assets[kind]) s[4](control,frame[a+2],frame[a+3])
 if TRANSFORM_GEOMETRY then s[5](control,frame[a+4],frame[a+5],1) else s[5](control,frame[a+4],frame[a+5]) end
 s[6](control,0,0,frame[a+6]) control.imageColor=frame[a+7] s[3](control,true)
end
variantStart=function()
 commands={} skipCommands={} slots={} groups={} commonSlot=nil SHARED_METHODS=true initStage=1 initFrame=1 initSlot=1 initDistance=1 initial=startFrame() cycleStart=0 nextDue=ends[initial]
end
variantPreview=function() return initStage<=2 or initStage==21 end
variantLoad=function()
 if initStage==1 then
  local stop=math.min(N,initSlot+SPAWN_BATCH-1) for id=initSlot,stop do
   local control=image(root) controls[id]=control
   local s={control,control.SetImage,control.SetVisible,control.SetAnchoredPosition,TRANSFORM_GEOMETRY and control.SetLocalScale or control.SetSizeDelta,control.SetLocalRotation} slots[id]=s
   for field=2,6 do if type(s[field])~="function" or s[field]~=slots[1][field] then SHARED_METHODS=false break end end
   if id==1 then SET_IMAGE=s[2] SET_VISIBLE=s[3] SET_POSITION=s[4] SET_DIMENSIONS=s[5] SET_ROTATION=s[6] end
   if TRANSFORM_GEOMETRY then control:SetSizeDelta(1,1) end configureFast(s,keys[initial],(id-1)*8)
  end
  initSlot=stop+1 if initSlot>N then initStage=2 initSlot=1 end
 elseif initStage==2 then
  local stop=math.min(N,initSlot+ORDER_BATCH-1)
  for id=initSlot,stop do
   controls[id]:SetSiblingIndex(math.floor(id-1))
   if PROFILE_LUA_ONLY then local shadow={imageColor=transparent} controls[id]=shadow slots[id]={shadow,profileNoop,profileNoop,profileNoop,profileNoop,profileNoop} end
  end
  initSlot=stop+1 if initSlot>N then
   if PROFILE_LUA_ONLY then SHARED_METHODS=true SET_IMAGE=profileNoop SET_VISIBLE=profileNoop SET_POSITION=profileNoop SET_DIMENSIONS=profileNoop SET_ROTATION=profileNoop print("GIF: Lua-only profile; native frame updates are disabled.") end
   local repair=initNativePolicy(keys[initial],configureFast)
   initStage=repair and 21 or 3 initSlot=1
  end
 elseif initStage==21 then
  local stop=math.min(N,initSlot+SPAWN_BATCH-1)
  for id=initSlot,stop do
   local control=controls[id] control:SetActive(true) control:SetVisible(false) control:SetAnchorMin(.5,.5) control:SetAnchorMax(.5,.5) control:SetPivot(.5,.5)
   control.imageType=Enum.ImageType.Stretch control.enableMask=false if TRANSFORM_GEOMETRY then control:SetSizeDelta(1,1) end
   configureFast(slots[id],keys[initial],(id-1)*8)
  end
  initSlot=stop+1 if initSlot>N then initStage=3 initSlot=1 end
 elseif initStage==3 then
  -- Cache bypasses of unusually short frames; ordinary jumps retain exact scans.
  -- This avoids doubling all command memory on uniform-rate clips.
  if initDistance==2 then
   local skipped=0
   while initFrame<=#keys do
    local previous=(initFrame-2)%#ends+1 local duration=ends[previous]-(ends[previous-1] or 0)
    if duration<total/#ends then break end
    initFrame=initFrame+1 skipped=skipped+1 if skipped==64 then return end
   end
   if initFrame>#keys then initStage=4 return end
  end
  local frame,prior=keys[initFrame],keys[(initFrame-1-initDistance)%#keys+1]
  local stop=math.min(N,initSlot+COMPILE_BATCH-1) for id=initSlot,stop do compile(frame,prior,groups,id) end
  initSlot=stop+1 if initSlot>N then
   local list={} for mask=1,63 do if groups[mask] then assert(dispatch[mask],"Unsupported changed-field mask") list[#list+1]=dispatch[mask] list[#list+1]=groups[mask] end end
   if initDistance==1 then commands[initFrame]=list else skipCommands[initFrame]=list end groups={}
   initFrame=initFrame+1 initSlot=1 if initFrame>#keys then if initDistance==1 then initDistance=2 initFrame=1 else initStage=4 end end
  end
 else if SHARED_METHODS then commonSlot=slots[1] slots=nil end groups=nil colors=nil finishLoading() end
end
local function direct(target)
 local frame,prior=keys[target],keys[current]
 for id=1,N do local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1] local s=commonSlot or slots[id] local control=controls[id]
  if not kind then if old then s[3](control,false) end
  else
   if kind~=old then s[2](control,STATIC,assets[kind]) end
   if not old then s[3](control,true) end
   if not old or frame[a+2]~=prior[a+2] or frame[a+3]~=prior[a+3] then s[4](control,frame[a+2],frame[a+3]) end
   if not old or frame[a+4]~=prior[a+4] or frame[a+5]~=prior[a+5] then if TRANSFORM_GEOMETRY then s[5](control,frame[a+4],frame[a+5],1) else s[5](control,frame[a+4],frame[a+5]) end end
   if not old or frame[a+6]~=prior[a+6] then s[6](control,0,0,frame[a+6]) end
   if not old or frame[a+7]~=prior[a+7] then control.imageColor=frame[a+7] end
  end
 end
end
local function applyTarget(target)
 local list
 if target==current%#ends+1 then list=commands[target]
 elseif target==(current+1)%#ends+1 and skipCommands[target] then list=skipCommands[target]
 else direct(target) return end
 for i=1,#list,2 do list[i](list[i+1]) end
end
variantUpdate=function(target)
 if keys[target]==keys[current] then return end
 nativeTransaction(applyTarget,target)
end
variantReset=function(target)
 if target~=current then variantUpdate(target) end current=target cycleStart=0 nextDue=ends[target]
end
variantTick=function(dt)
 clock=clock+dt*1000000
 local finished=not LOOP and clock>=total-0.001 if finished then clock=total-0.001 end
 local limited=PLAYBACK_FPS>0 and PLAYBACK_FPS~=ENCODED_FPS if limited then displayClock=displayClock+dt end
 if clock<nextDue and not finished then return end
 if limited and displayClock<1/PLAYBACK_FPS and not finished then return end
 local target=current%#ends+1 local start=cycleStart if current==#ends then start=start+total end
 if finished then target=#ends start=0
 elseif clock<start+(ends[target-1] or 0) or clock>=start+ends[target] then target=frameAt(clock) start=LOOP and math.floor(clock/total)*total or 0 end
 if target~=current then variantUpdate(target) current=target if limited then displayClock=displayClock%(1/PLAYBACK_FPS) end end
 cycleStart=start nextDue=start+ends[target]
 if finished then script:EnableUpdate(false) end
end
variantDestroy=function() destroyNativePolicy() commands=nil skipCommands=nil slots=nil commonSlot=nil groups=nil dispatch=nil SET_IMAGE=nil SET_VISIBLE=nil SET_POSITION=nil SET_DIMENSIONS=nil SET_ROTATION=nil end

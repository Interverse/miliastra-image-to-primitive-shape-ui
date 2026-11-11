-- Three rolling pools, not one pool per frame. Hidden preparation has deadlines.
-- Fitted geometry/color, display times and exact catch-up remain unchanged.
local TRANSFORM_GEOMETRY=true
local BUFFER_COUNT=3 -- Two frames of lookahead absorb short frames and loop seams.
local MAX_FRAME_CALLS=12*N+8
local STATIC=Enum.ImageSource.StaticReference
local commands,buffers,parents,parentVisible,poses,jobs,active,poolCount
local initStage,initBuffer,initSlot,initFrame,groups,nextDue
local SHARED_METHODS,SET_IMAGE,SET_VISIBLE,SET_POSITION,SET_DIMENSIONS,SET_ROTATION
-- @FAST_DISPATCH@
local function configureSlot(s,frame,a)
 local control=s[1] local kind=frame[a+1] s[7]=frame
 if not kind then s[3](control,false) return end
 s[2](control,STATIC,assets[kind]) s[4](control,frame[a+2],frame[a+3])
 if TRANSFORM_GEOMETRY then s[5](control,frame[a+4],frame[a+5],1) else s[5](control,frame[a+4],frame[a+5]) end
 s[6](control,0,0,frame[a+6]) control.imageColor=frame[a+7] s[3](control,true)
end
local function compile(frame,prior,id)
 local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1]
 local asset=kind and kind~=old local visible=(kind~=nil)~=(old~=nil)
 local position=kind and (not old or frame[a+2]~=prior[a+2] or frame[a+3]~=prior[a+3])
 local size=kind and (not old or frame[a+4]~=prior[a+4] or frame[a+5]~=prior[a+5])
 local rotation=kind and (not old or frame[a+6]~=prior[a+6])
 local color=kind and (not old or frame[a+7]~=prior[a+7])
 local mask=(asset and 1 or 0)+(visible and 2 or 0)+(position and 4 or 0)+(size and 8 or 0)+(rotation and 16 or 0)+(color and 32 or 0)
 if mask==0 then return end
 local t=groups[mask] if not t then t={} groups[mask]=t end local n=#t t[n+1]=id n=n+1
 if asset then t[n+1]=assets[kind] n=n+1 end
 if visible then t[n+1]=kind~=nil n=n+1 end
 if position then t[n+1]=frame[a+2] t[n+2]=frame[a+3] n=n+2 end
 if size then t[n+1]=frame[a+4] t[n+2]=frame[a+5] n=n+2 end
 if rotation then t[n+1]=frame[a+6] n=n+1 end
 if color then t[n+1]=frame[a+7] end
end
local function prepare(index,budget)
 local job=jobs[index] if not job or job.left==0 or budget<=0 then return end
 local frame=keys[job.target] local pool=buffers[index]
 if job.reset then
  local count=math.min(N-job.reset+1,math.max(1,math.floor(budget/6))) local stop=job.reset+count-1
  for id=job.reset,stop do configureSlot(pool[id],frame,(id-1)*8) end
  job.reset=stop+1 job.left=job.left-count*6
 else
  local list=commands[job.target]
  while budget>0 and job.left>0 do
   local group=list[job.part] local t,stride,weight=group[2],group[3],group[4]
   local records=math.min(math.floor((#t-job.cursor)/stride)+1,math.max(1,math.floor(budget/weight)))
   local stop=job.cursor+(records-1)*stride group[1](t,job.cursor,stop,pool,frame)
   local used=records*weight budget=budget-used job.left=job.left-used job.cursor=stop+stride
   if job.cursor>#t then job.part=job.part+1 job.cursor=1 end
  end
 end
 if job.left==0 then poses[index]=job.target end
end
local function resetExact(index,target)
 -- Only unusual jumps use this scan; compare against each slot's actual shadow.
 local pool=buffers[index] local frame=keys[target]
 for id=1,N do
  local s=pool[id] local control=s[1] local prior=s[7] local a=(id-1)*8 local kind,old=frame[a+1],prior[a+1]
  if not kind then if old then s[3](control,false) end
  else
   if kind~=old then s[2](control,STATIC,assets[kind]) end
   if not old then s[3](control,true) end
   if not old or frame[a+2]~=prior[a+2] or frame[a+3]~=prior[a+3] then s[4](control,frame[a+2],frame[a+3]) end
   if not old or frame[a+4]~=prior[a+4] or frame[a+5]~=prior[a+5] then if TRANSFORM_GEOMETRY then s[5](control,frame[a+4],frame[a+5],1) else s[5](control,frame[a+4],frame[a+5]) end end
   if not old or frame[a+6]~=prior[a+6] then s[6](control,0,0,frame[a+6]) end
   if not old or frame[a+7]~=prior[a+7] then control.imageColor=frame[a+7] end
  end s[7]=frame
 end poses[index]=target jobs[index].target=0 jobs[index].left=0 jobs[index].reset=nil
end
local function schedule()
 local deadline=nextDue
 for offset=1,poolCount-1 do
  local index=(active+offset-1)%poolCount+1 local target=(current+offset-1)%#ends+1 local job=jobs[index]
  if not LOOP and current+offset>#ends then job.target=0 job.left=0 job.reset=nil
  else
   if job.target~=target then
    local clean=job.left==0
    job.target=target job.part=1 job.cursor=1 job.left=0 job.reset=nil
    if not (clean and poses[index]==target) then
     if clean and poses[index]==(target-1-BUFFER_COUNT)%#ends+1 then job.left=commands[target].work
     else job.left=6*N job.reset=1 end
    end
    if job.left==0 then poses[index]=target end
   end
   job.due=deadline deadline=deadline+ends[target]-(ends[target-1] or 0)
  end
 end
end
variantStart=function()
 poolCount=(FREEZE_FRAME>0 or #ends==1) and 1 or BUFFER_COUNT
 commands={} buffers={} parents={} parentVisible={} poses={} jobs={} active=1
 for index=1,poolCount do buffers[index]={} poses[index]=(startFrame()+index-2)%#ends+1 jobs[index]={target=0,left=0} end
 initStage=1 initBuffer=1 initSlot=1 initFrame=1 groups={} SHARED_METHODS=true
end
variantPreview=function() return initBuffer==1 end
variantLoad=function()
 if initStage==1 then
  local parent=image(root) parent.imageColor=transparent parent:SetSizeDelta(WIDTH,WIDTH*H/W) parent:SetAnchoredPosition(0,0) parent:SetLocalScale(1,1,1) parent:SetLocalRotation(0,0,0)
  parents[initBuffer]=parent parentVisible[initBuffer]=parent.SetVisible initStage=2 initSlot=1
 elseif initStage==2 then
  local stop=math.min(N,initSlot+SPAWN_BATCH-1) local pool=buffers[initBuffer] local frame=keys[poses[initBuffer]]
  for id=initSlot,stop do
   local control=image(parents[initBuffer]) local s={control,control.SetImage,control.SetVisible,control.SetAnchoredPosition,TRANSFORM_GEOMETRY and control.SetLocalScale or control.SetSizeDelta,control.SetLocalRotation} pool[id]=s
   if initBuffer==1 and id==1 then SET_IMAGE=s[2] SET_VISIBLE=s[3] SET_POSITION=s[4] SET_DIMENSIONS=s[5] SET_ROTATION=s[6] end
   for field=2,6 do if type(s[field])~="function" or s[field]~=buffers[1][1][field] then SHARED_METHODS=false break end end
   if TRANSFORM_GEOMETRY then control:SetSizeDelta(1,1) end configureSlot(s,frame,(id-1)*8)
  end
  initSlot=stop+1 if initSlot>N then initStage=3 initSlot=1 end
 elseif initStage==3 then
  local stop=math.min(N,initSlot+ORDER_BATCH-1) for id=initSlot,stop do buffers[initBuffer][id][1]:SetSiblingIndex(math.floor(id-1)) end
  initSlot=stop+1 if initSlot>N then parents[initBuffer]:SetVisible(initBuffer==1) initBuffer=initBuffer+1 if initBuffer<=poolCount then initStage=1 else initStage=4 initSlot=1 end end
 elseif initStage==4 then
  local stop=math.min(N,initSlot+COMPILE_BATCH-1) local prior=keys[(initFrame-1-BUFFER_COUNT)%#keys+1]
  for id=initSlot,stop do compile(keys[initFrame],prior,id) end initSlot=stop+1
  if initSlot>N then
   local list={work=0}
   for mask=1,63 do local t=groups[mask] if t then
    local stride,weight=1,0 local flag=mask
    for bit=1,6 do if flag%2==1 then weight=weight+1 stride=stride+((bit==3 or bit==4) and 2 or 1) end flag=math.floor(flag/2) end
    assert(dispatch[mask],"Unsupported pipeline mask") list[#list+1]={dispatch[mask],t,stride,weight} list.work=list.work+#t/stride*weight
   end end
   commands[initFrame]=list groups={} initFrame=initFrame+1 initSlot=1 if initFrame>#keys then initStage=5 end
  end
 else
  controls={} for id=1,N do controls[id]=buffers[active][id][1] end
  groups=nil colors=nil finishLoading() nextDue=ends[current] schedule()
 end
end
variantReset=function(target)
 resetExact(active,target) current=target nextDue=ends[target] schedule()
end
variantTick=function(dt)
 clock=clock+dt*1000000 local finished=not LOOP and clock>=total-0.001 if finished then clock=total-0.001 end
 local limited=PLAYBACK_FPS>0 and PLAYBACK_FPS~=ENCODED_FPS if limited then displayClock=displayClock+dt end
 local forced=false
 if clock>=nextDue and (not limited or displayClock>=1/PLAYBACK_FPS or finished) then
  local target=frameAt(clock)
  if target~=current then
   local chosen=active%poolCount+1
   for offset=1,poolCount-1 do local index=(active+offset-1)%poolCount+1 if jobs[index] and jobs[index].target==target then chosen=index break end end
   local job=jobs[chosen]
   if job and job.target==target then if job.left>0 then prepare(chosen,job.left) forced=true end
   else resetExact(chosen,target) forced=true end
   parentVisible[active](parents[active],false) active=chosen parentVisible[active](parents[active],true) current=target jobs[active].target=0 jobs[active].left=0 jobs[active].reset=nil
   if limited then displayClock=displayClock%(1/PLAYBACK_FPS) end
   nextDue=(LOOP and math.floor(clock/total)*total or 0)+ends[current] schedule()
  else nextDue=(LOOP and math.floor(clock/total)*total or 0)+ends[current] end
 end
 if finished then script:EnableUpdate(false) return end
 if dt>0 and not forced then
  for offset=1,poolCount-1 do
   local index=(active+offset-1)%poolCount+1 local job=jobs[index]
   if job and job.left>0 then local timeLeft=math.max(dt*1000000,job.due-clock) prepare(index,math.ceil(job.left*math.min(1,dt*1000000/timeLeft))) end
  end
 end
end
variantDestroy=function()
 commands=nil buffers=nil parents=nil parentVisible=nil poses=nil jobs=nil groups=nil dispatch=nil SET_IMAGE=nil SET_VISIBLE=nil SET_POSITION=nil SET_DIMENSIONS=nil SET_ROTATION=nil
end

-- Attach to the same UI parent; use the original plain Image Control template.
-- Only startup is batched. Playback uses predecoded native coordinates/colors.
-- LOAD_BATCH is one update's loading work; the other batches are the most
-- items of each kind that fit in it. LOAD_SPEED (script header) scales it.
local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=6144,128,256
local SCAN_BATCH,COMPILE_BATCH,COLOR_BATCH=1024,2048,512
local LOAD_SCALE=math.max(0.01,tonumber(LOAD_SPEED) or 1)
local FREEZE_FRAME=0 -- 1 displays one pose and disables playback updates.
local root,controls,colors,keys,ends,transparent
local total,current,clock,displayClock,loading,ready
local digits,prefixes,prefixBits,powers,at,buffer,bits,state,components
local stage,bookAt,slot,f,c,run,remaining,fixed,changed
-- touched[id]: last frame that changed it; touched[-id]: visible. dirty: ids with changed colors, dirty[-id] flags, dirty.n count.
local touched,dirty
local variantStart,variantLoad,variantUpdate,variantDestroy,variantTick,variantBeforeDestroy,variantPreview,variantReset
local previewLoading,colorRemaining
local playbackRequested=true
local playbackStarted,playbackDestroyed=false,false
local assets={100002,100001,100003,106057}
local function take(count)
 while bits<count do local d=digits[string.byte(DATA,at)] assert(d,"Invalid animation data") buffer=buffer+d*powers[bits] bits=bits+6 at=at+1 end
 local power=powers[count] local v=buffer%power buffer=(buffer-v)/power bits=bits-count return v
end
local function symbol(channel)
 local book=books[channel] local node=book[1] if node<0 then return -node-1 end
 while bits<8 do local d=digits[string.byte(DATA,at)] if d==nil then d=0 end buffer=buffer+d*powers[bits] bits=bits+6 at=at+1 end
 local index=buffer%256+1 node=prefixes[channel][index] local count=prefixBits[channel][index]
 local power=powers[count] buffer=(buffer-buffer%power)/power bits=bits-count
 local tree=book[2] while node>0 do node=tree[node*2-1+take(1)] end return -node-1
end
local function value(channel)
 if run>0 then run=run-1 return 0 end
 local s=symbol(channel) if s==1 then return 0 elseif s>1 then return powers[s-2]+take(s-2) end
 local count=0 while take(1)==0 do count=count+1 assert(count<53,"Invalid animation run") end
 run=powers[count]+take(count)-1 return 0
end
local function signed(v) if v%2==1 then return -math.floor((v+1)/2) end return math.floor(v/2) end
local function image(parent)
 local control=game.InstantiateClientUIControl(IMAGE_TEMPLATE_INDEX,parent) assert(control,"Image Control Template failed")
 control:SetActive(true) control:SetVisible(false) control:SetAnchorMin(0.5,0.5) control:SetAnchorMax(0.5,0.5) control:SetPivot(0.5,0.5)
 control.imageType=Enum.ImageType.Stretch control.enableMask=false return control
end
local function configure(control,frame,a)
 local kind=frame[a+1] if not kind then return end
 control:SetImage(Enum.ImageSource.StaticReference,assets[kind])
 control:SetAnchoredPosition(frame[a+2],frame[a+3]) control:SetSizeDelta(frame[a+4],frame[a+5])
 control:SetLocalRotation(0,0,frame[a+6]) control.imageColor=frame[a+7] control:SetVisible(true)
end
local function renderable(a)
 if math.floor((state[a+7] or 0)/16777216)==0 then return false end
 local w,h=state[a+4]*GEOMETRY,state[a+5]*GEOMETRY if w<=0 or h<=0 then return false end
 local angle=state[a+6]*ROTATION*math.pi/180 local co,si=math.abs(math.cos(angle)),math.abs(math.sin(angle))
 local rx,ry=(w*co+h*si)*0.5,(w*si+h*co)*0.5 local x,y=state[a+2]*GEOMETRY,state[a+3]*GEOMETRY
 return x+rx>=-W*0.5-2 and x-rx<=W*0.5+2 and y+ry>=-H*0.5-2 and y-ry<=H*0.5+2
end
local function releaseCodec()
 DATA=nil books=nil digits=nil prefixes=nil prefixBits=nil powers=nil state=nil components=nil moveCounts=nil durations=nil fixed=nil
 touched=nil dirty=nil
end
local function createRoot()
 root=image(script.object) transparent=Color.FromRGBA(255,255,255,0) root:SetImage(Enum.ImageSource.StaticReference,100001) root.imageColor=transparent
 root.enableMask=true root.enableSoftEdge=false root.reverseMaskArea=false root:SetSizeDelta(WIDTH,WIDTH*H/W) root:SetAnchoredPosition(0,0)
end
local function load()
 if stage==1 then
  local alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for i=1,64 do digits[string.byte(alphabet,i)]=i-1 end stage=2 remaining=remaining-64
 elseif stage==2 then
  local book=books[bookAt] local tree=book[2] local entries,lengths={},{}
  for v=0,255 do local node=book[1] local length=0 local n=v while node>0 and length<8 do node=tree[node*2-1+n%2] n=math.floor(n/2) length=length+1 end entries[v+1]=node lengths[v+1]=length end
  prefixes[bookAt]=entries prefixBits[bookAt]=lengths bookAt=bookAt+1 if bookAt>#books then stage=3 end remaining=remaining-256
 elseif stage==3 then
  for i=1,#durations do total=total+durations[i] ends[i]=total end slot=1 stage=31 remaining=remaining-1
 elseif stage==31 then
  -- Fields start at zero; frames then apply only their nonzero deltas in place.
  local stop=math.min(N,slot+math.max(1,math.floor(remaining/2))-1) remaining=remaining-math.max(1,(stop-slot+1)*2)
  for id=slot,stop do local a,b=(id-1)*8,(id-1)*4 for k=1,8 do state[a+k]=0 end for k=1,4 do components[b+k]=0 end touched[id]=0 touched[-id]=false end
  slot=stop+1 if slot>N then slot=1 stage=4 end
 elseif stage==4 then
  -- Zero runs are skipped whole: unchanged fields need no work.
  local last=c<=11 and N or moveCounts[f] local id=slot
  while id<=last and remaining>0 do
   if run>0 then local skip=last-id+1 if run<skip then skip=run end run=run-skip id=id+skip remaining=remaining-1
   else
    local v=value(c) remaining=remaining-1
    if v~=0 and c<=11 then local delta=signed(v) changed=true touched[id]=f
     if c<=6 then local key=(id-1)*8+c state[key]=state[key]+delta
     elseif c<=10 then local key=(id-1)*4+c-6 components[key]=(components[key]+delta)%256
      if not dirty[-id] then dirty[-id]=true dirty.n=dirty.n+1 dirty[dirty.n]=id end
     else local key=(id-1)*8+8 state[key]=state[key]+delta end
    end -- Old order plans (channel 12) are consumed; fixed painter slots need no playback sorting.
    id=id+1
   end
  end
  slot=id if slot>last then assert(run==0,"Invalid animation run length") slot=1 c=c+1
   if c==11 and dirty.n>0 then stage=41 elseif c==13 then if f>1 and not changed then keys[f]=keys[f-1] stage=6 else fixed={} stage=5 end end
  end
 elseif stage==41 then
  -- Colors of controls whose color channels changed this frame.
  local i=slot
  while i<=dirty.n and remaining>0 and colorRemaining>0 do local id=dirty[i] dirty[-id]=nil
   local a=(id-1)*4 local p=components[a+4]*16777216+components[a+3]*65536+components[a+2]*256+components[a+1] state[(id-1)*8+7]=p
   if colors[p]==nil then local r,g,b=components[a+3],components[a+2],components[a+1] if COMPACT then r=math.floor(r*255/31+0.5) g=math.floor(g*255/63+0.5) b=math.floor(b*255/31+0.5) end colors[p]=Color.FromRGBA(r,g,b,components[a+4]) colorRemaining=colorRemaining-1 end
   remaining=remaining-4 i=i+1
  end
  slot=i if i>dirty.n then dirty={n=0} slot=1 stage=4 elseif colorRemaining<=0 then remaining=0 end
 elseif stage==5 then
  -- Unchanged controls keep their previous pose; only changed ones are rebuilt.
  local prior=f>1 and keys[f-1] or nil local scale=WIDTH/W*GEOMETRY local id=slot
  while id<=N and remaining>0 do local a=(id-1)*8
   if prior and touched[id]~=f then
    if touched[-id] then local dst=state[a+8]*8 assert(fixed[dst+1]==nil,"Duplicate animation order") for k=1,7 do fixed[dst+k]=prior[dst+k] end end
    remaining=remaining-2
   else
    touched[-id]=state[a+1]~=0 and renderable(a)
    if touched[-id] then
     local rank=state[a+8] assert(rank>=0 and rank<N and rank==math.floor(rank),"Invalid animation order") local dst=rank*8 assert(fixed[dst+1]==nil,"Duplicate animation order")
     fixed[dst+1]=state[a+1] fixed[dst+2]=state[a+2]*scale fixed[dst+3]=state[a+3]*scale fixed[dst+4]=state[a+4]*scale fixed[dst+5]=state[a+5]*scale fixed[dst+6]=state[a+6]*ROTATION fixed[dst+7]=colors[state[a+7]]
    end
    remaining=remaining-8
   end
   id=id+1
  end
  slot=id if slot>N then keys[f]=fixed fixed=nil slot=1 stage=6 end
 elseif stage==6 then
  if variantPreview and not root and f==math.min(#ends,math.max(1,math.floor(FREEZE_FRAME))) then
   createRoot() variantStart() previewLoading=true remaining=0 return
  end
  remaining=remaining-1 f=f+1 c=1 slot=1 changed=false if f<=#durations then stage=4 else stage=7 end
 elseif stage==7 then
  local stop=math.min(moveCounts[f],slot+remaining-1) remaining=remaining-math.max(1,stop-slot+1) for i=slot,stop do value(12) end slot=stop+1 if slot>moveCounts[f] then assert(run==0,"Invalid loop order") stage=8 end
 elseif stage==8 then
  remaining=0 if not root then createRoot() variantStart() end
  releaseCodec() stage=9
 else local before=remaining variantLoad() if remaining>=before then remaining=0 end
 end
end
local function startFrame()
 if FREEZE_FRAME>0 then return math.min(#ends,math.max(1,math.floor(FREEZE_FRAME))) end return 1
end
local function frameAt(t)
 local phase=LOOP and t%total or math.min(t,total-0.001)
 local low,high=1,#ends while low<high do local mid=math.floor((low+high)/2) if phase<ends[mid] then high=mid else low=mid+1 end end return low
end
local function playbackEnabled()
 if playbackStarted and not playbackDestroyed then script:EnableUpdate(loading or (ready and playbackRequested and #ends>1 and FREEZE_FRAME==0)) end
end
local function rewindPlayback()
 clock=0 displayClock=0 local target=startFrame()
 if variantReset then variantReset(target) else if current~=target then variantUpdate(target) end current=target end
end
-- Script methods: targetScript:Invoke("Play"), "Stop", or "Restart".
function Play()
 if playbackDestroyed then return false end
 playbackRequested=true
 if ready and not LOOP and clock>=total-0.001 then rewindPlayback() end
 playbackEnabled() return true
end
function Stop()
 if playbackDestroyed then return false end
 playbackRequested=false playbackEnabled() return true
end
function Restart()
 if playbackDestroyed then return false end
 playbackRequested=true if ready then rewindPlayback() end
 playbackEnabled() return true
end
local function finishLoading()
 current=startFrame() clock=0 displayClock=0 ready=true loading=false root:SetVisible(true)
 playbackEnabled()
end
function OnStart()
 if playbackDestroyed then playbackRequested=true end playbackStarted=true playbackDestroyed=false
 colors={} keys={} ends={} controls={} total=0 current=0 clock=0 displayClock=0 ready=false loading=true
 digits={} prefixes={} prefixBits={} powers={[0]=1} for i=1,52 do powers[i]=powers[i-1]*2 end
 at=1 buffer=0 bits=0 run=0 state={} components={} touched={} dirty={n=0} stage=1 bookAt=1 slot=1 f=1 c=1 changed=true previewLoading=false
 script:EnableUpdate(true)
end
function OnUpdate(deltaTime)
 if loading then
  -- Every loading stage draws from one budget, so small clips finish in a few updates.
  colorRemaining=math.max(1,math.floor(COLOR_BATCH*LOAD_SCALE)) remaining=LOAD_BATCH*LOAD_SCALE
  if previewLoading then
   repeat local before=remaining variantLoad() if remaining>=before then remaining=0 end until remaining<=0 or not variantPreview()
   if not variantPreview() then previewLoading=false root:SetVisible(true) end return
  end
  repeat load() until previewLoading or not loading or remaining<=0 return
 end
 if not ready or not root then return end
 if not playbackRequested then script:EnableUpdate(false) return end
 if FREEZE_FRAME>0 or #ends==1 then script:EnableUpdate(false) return end
 local dt=math.max(0,deltaTime) if variantTick then variantTick(dt) return end
 clock=clock+dt*1000000 displayClock=displayClock+dt
 if not LOOP and clock>=total then clock=total-0.001 end
 local limited=PLAYBACK_FPS>0 and PLAYBACK_FPS~=ENCODED_FPS
 if limited and displayClock<1/PLAYBACK_FPS and (LOOP or clock<total-0.001) then return end
 local target=frameAt(clock)
 if target~=current then variantUpdate(target) current=target if limited then displayClock=displayClock%(1/PLAYBACK_FPS) else displayClock=0 end end
 if not LOOP and clock>=total-0.001 then script:EnableUpdate(false) end
end
function OnDestroy()
 playbackDestroyed=true playbackRequested=false
 script:EnableUpdate(false) loading=false ready=false previewLoading=false
 if variantBeforeDestroy then variantBeforeDestroy() end
 if root and root.alive then game.DestroyClientUIControl(root) end
 variantDestroy() root=nil controls=nil colors=nil keys=nil ends=nil transparent=nil releaseCodec()
end

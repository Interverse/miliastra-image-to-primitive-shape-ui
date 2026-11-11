-- Attach to the same UI parent; use the original plain Image Control template.
-- Only startup is batched. Playback uses predecoded native coordinates/colors.
local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=6144,128,256
local SCAN_BATCH,COMPILE_BATCH,COLOR_BATCH=1024,2048,512
local FREEZE_FRAME=0 -- 1 displays one pose and disables playback updates.
local root,controls,colors,keys,ends,transparent
local total,current,clock,displayClock,loading,ready
local digits,prefixes,prefixBits,powers,at,buffer,bits,state,oldState,components
local stage,bookAt,slot,f,c,run,remaining,fixed,changed
local variantStart,variantLoad,variantUpdate,variantDestroy,variantTick,variantBeforeDestroy,variantPreview,variantReset
local previewLoading,colorRemaining
local playbackRequested=true
local playbackStarted,playbackDestroyed=false,false
local assets={100002,100001,100003}
local function take(count)
 while bits<count do local d=digits[string.byte(DATA,at)] assert(d,"Invalid animation data") buffer=buffer+d*2^bits bits=bits+6 at=at+1 end
 local power=powers[count] local v=buffer%power buffer=math.floor(buffer/power) bits=bits-count return v
end
local function symbol(channel)
 local book=books[channel] local node=book[1] if node<0 then return -node-1 end
 while bits<8 do local d=digits[string.byte(DATA,at)] if d==nil then d=0 end buffer=buffer+d*2^bits bits=bits+6 at=at+1 end
 local index=buffer%256+1 node=prefixes[channel][index] local count=prefixBits[channel][index]
 buffer=math.floor(buffer/powers[count]) bits=bits-count
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
local function add(key,v)
 state[key]=v if f==1 or (oldState[key] or 0)~=v then changed=true end
end
local function renderable(a)
 if math.floor((state[a+7] or 0)/16777216)==0 then return false end
 local w,h=state[a+4]*GEOMETRY,state[a+5]*GEOMETRY if w<=0 or h<=0 then return false end
 local angle=state[a+6]*ROTATION*math.pi/180 local co,si=math.abs(math.cos(angle)),math.abs(math.sin(angle))
 local rx,ry=(w*co+h*si)*0.5,(w*si+h*co)*0.5 local x,y=state[a+2]*GEOMETRY,state[a+3]*GEOMETRY
 return x+rx>=-W*0.5-2 and x-rx<=W*0.5+2 and y+ry>=-H*0.5-2 and y-ry<=H*0.5+2
end
local function releaseCodec()
 DATA=nil books=nil digits=nil prefixes=nil prefixBits=nil powers=nil state=nil oldState=nil components=nil moveCounts=nil durations=nil fixed=nil
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
  -- Each decoded channel writes every field; a zero-filled copy is unnecessary.
  for i=1,#durations do total=total+durations[i] ends[i]=total end slot=1 stage=4
 elseif stage==4 then
  local weight=c==10 and 4 or 1 local limit=math.max(1,math.floor(remaining/weight))
  if c==10 then if colorRemaining==0 then remaining=0 return end limit=math.min(limit,128,colorRemaining) end
  local stop=math.min(c<=11 and N or moveCounts[f],slot+limit-1) remaining=remaining-math.max(1,(stop-slot+1)*weight)
  for id=slot,stop do local delta=signed(value(c))
   if c<=6 then local key=(id-1)*8+c add(key,(oldState[key] or 0)+delta)
   elseif c<=10 then
    local key=(id-1)*4+c-6 components[key]=((components[key] or 0)+delta)%256
    if c==10 then local a=(id-1)*4 local p=components[a+4]*16777216+components[a+3]*65536+components[a+2]*256+components[a+1] add((id-1)*8+7,p)
     if colors[p]==nil then local r,g,b=components[a+3],components[a+2],components[a+1] if COMPACT then r=math.floor(r*255/31+0.5) g=math.floor(g*255/63+0.5) b=math.floor(b*255/31+0.5) end colors[p]=Color.FromRGBA(r,g,b,components[a+4]) colorRemaining=colorRemaining-1 end
    end
   elseif c==11 then local key=(id-1)*8+8 add(key,(oldState[key] or 0)+delta)
   end -- Old order plans are consumed; fixed painter slots need no playback sorting.
  end
  slot=stop+1 if slot>(c<=11 and N or moveCounts[f]) then assert(run==0,"Invalid animation run length") slot=1 c=c+1 if c==13 then if f>1 and not changed then keys[f]=keys[f-1] stage=6 else fixed={} stage=5 end end end
 elseif stage==5 then
  local stop=math.min(N,slot+math.max(1,math.floor(remaining/8))-1) remaining=remaining-math.max(1,(stop-slot+1)*8) local scale=WIDTH/W*GEOMETRY
  for id=slot,stop do local a=(id-1)*8 if state[a+1]~=0 and renderable(a) then
   local rank=state[a+8] assert(rank>=0 and rank<N and rank==math.floor(rank),"Invalid animation order") local dst=rank*8 assert(fixed[dst+1]==nil,"Duplicate animation order")
   fixed[dst+1]=state[a+1] fixed[dst+2]=state[a+2]*scale fixed[dst+3]=state[a+3]*scale fixed[dst+4]=state[a+4]*scale fixed[dst+5]=state[a+5]*scale fixed[dst+6]=state[a+6]*ROTATION fixed[dst+7]=colors[state[a+7]]
  end end slot=stop+1 if slot>N then keys[f]=fixed fixed=nil slot=1 stage=6 end
 elseif stage==6 then
  if variantPreview and not root and f==math.min(#ends,math.max(1,math.floor(FREEZE_FRAME))) then
   createRoot() variantStart() previewLoading=true remaining=0 return
  end
  remaining=remaining-1 oldState=state state={} f=f+1 c=1 slot=1 changed=false if f<=#durations then stage=4 else stage=7 end
 elseif stage==7 then
  local stop=math.min(moveCounts[f],slot+remaining-1) remaining=remaining-math.max(1,stop-slot+1) for i=slot,stop do value(12) end slot=stop+1 if slot>moveCounts[f] then assert(run==0,"Invalid loop order") stage=8 end
 elseif stage==8 then
  remaining=0 if not root then createRoot() variantStart() end
  releaseCodec() stage=9
 else remaining=0 variantLoad()
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
 at=1 buffer=0 bits=0 run=0 state={} oldState={} components={} stage=1 bookAt=1 slot=1 f=1 c=1 changed=true previewLoading=false
 script:EnableUpdate(true)
end
function OnUpdate(deltaTime)
 if loading then
  colorRemaining=COLOR_BATCH
  if previewLoading then variantLoad() if not variantPreview() then previewLoading=false root:SetVisible(true) end return end
  remaining=LOAD_BATCH for step=1,64 do load() if previewLoading or not loading or remaining<=0 then break end end return
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

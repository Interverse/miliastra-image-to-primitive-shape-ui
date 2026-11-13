/* Sparse Primeval animation states; static JSON is unchanged. */
"use strict";
const AnimationLua=(()=>{
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 function painterOrder(frame,count){const active=[],inactive=[];for(let id=0;id<count;id++)if(frame[id*8])active.push(id);else inactive.push(id);active.sort((a,b)=>frame[a*8+7]-frame[b*8+7]);return active.concat(inactive);}
 // Keep a longest stable subsequence and move only the other controls. This
 // work happens during export, never in the game's frame callback.
 function planOrder(previous,desired){
  const positions=new Int32Array(previous.length);previous.forEach((id,i)=>positions[id]=i);
  const tails=[],indices=[],parent=new Int32Array(desired.length).fill(-1);
  desired.forEach((id,i)=>{const value=positions[id];let low=0,high=tails.length;while(low<high){const mid=(low+high)>>1;if(tails[mid]<value)low=mid+1;else high=mid;}if(low)parent[i]=indices[low-1];tails[low]=value;indices[low]=i;});
  const keep=new Set();let at=indices.at(-1);while(at!==undefined&&at>=0){keep.add(desired[at]);at=parent[at];}
  const current=previous.slice(),moves=[];
  for(let i=desired.length-1;i>=0;i--){const id=desired[i];if(keep.has(id))continue;const from=current.indexOf(id),next=i+1<desired.length?current.indexOf(desired[i+1]):current.length;const to=next-(from<next?1:0);current.splice(from,1);current.splice(to,0,id);moves.push(id+1,to);}
  return moves;
 }
 // Lossless channel deltas, zero runs and static Huffman codes. All work here
 // runs in the browser; the Lua player only reads the resulting bit stream.
 function bookFor(chunks){
  const counts=chunks instanceof Map?chunks:new Map();if(!(chunks instanceof Map))for(const chunk of chunks)for(const token of chunk)counts.set(token.symbol,(counts.get(token.symbol)||0)+1);
  const heap=[];let sequence=0;const less=(a,b)=>a.weight-b.weight||a.sequence-b.sequence;
  const push=node=>{heap.push(node);let i=heap.length-1;while(i){const p=(i-1)>>1;if(less(heap[p],node)<=0)break;heap[i]=heap[p];i=p;}heap[i]=node;};
  const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&less(heap[j+1],heap[j])<0)j++;if(less(last,heap[j])<=0)break;heap[i]=heap[j];i=j;}heap[i]=last;}return first;};
  for(const [symbol,weight]of counts)push({symbol,weight,sequence:sequence++});if(!heap.length)push({symbol:1,weight:1,sequence:sequence++});
  while(heap.length>1){const left=pop(),right=pop();push({left,right,weight:left.weight+right.weight,sequence:sequence++});}
  const tree=[],codes=new Map();function visit(node,code,bits){if(node.symbol!==undefined){codes.set(node.symbol,[code,bits]);return -node.symbol-1;}const index=tree.length/2+1;tree.push(0,0);tree[(index-1)*2]=visit(node.left,code,bits+1);tree[(index-1)*2+1]=visit(node.right,code+2**bits,bits+1);return index;}
  const root=visit(pop(),0,0);return {root,tree,codes};
 }
 function tokens(values){const result=[];for(let i=0;i<values.length;i++){if(values[i]===0){let end=i+1;while(end<values.length&&values[end]===0)end++;if(end-i>=3){result.push({symbol:0,run:end-i});i=end-1;continue;}}const v=values[i];if(v===0)result.push({symbol:1});else {const extra=Math.floor(Math.log2(v));result.push({symbol:extra+2,extra,value:v-2**extra});}}return result;}
 const zig=n=>n<0?-n*2-1:n*2;
 function encode(animation){
  if(!Number.isSafeInteger(animation.controls)||animation.controls<1||!animation.frames.length||animation.frames.length!==animation.durations.length)throw Error('animation.limit');
  const N=animation.controls,chunks=Array.from({length:12},()=>[]),patches=[],orders=[],previous=new Float64Array(N*8);let previousOrder=Array.from({length:N},(_,i)=>i);
  const firstOrder=painterOrder(animation.frames[0],N);
  animation.frames.forEach((frame,f)=>{
   if(frame.length>N*8)throw Error('animation.limit');
   const patch=[];for(let at=0;at<N*8;at++){const v=frame[at]||0;if(!Number.isSafeInteger(v))throw Error('animation.limit');if(f===0||v!==previous[at])patch.push(at+1,v);}
   patches.push(patch);
   for(let c=0;c<11;c++){const values=[];for(let id=0;id<N;id++){const at=id*8+(c<6?c:c<10?6:7);let v=frame[at]||0,old=previous[at];if(c>=6&&c<10){const shift=(c-6)*8;v=(v>>>shift)&255;old=(old>>>shift)&255;}let delta=v-old;if(c>=6&&c<10)delta=((delta+128)&255)-128;values.push(zig(delta));}chunks[c].push(tokens(values));}
   const desired=painterOrder(frame,N),moves=planOrder(previousOrder,desired);orders.push(moves);previousOrder=desired;const values=[];let lastId=0,lastTo=0;for(let i=0;i<moves.length;i+=2){values.push(zig(moves[i]-lastId),zig(moves[i+1]-lastTo));lastId=moves[i];lastTo=moves[i+1];}chunks[11].push(tokens(values));
   for(let at=0;at<N*8;at++)previous[at]=frame[at]||0;
  });
  const loopOrder=planOrder(previousOrder,firstOrder),loopValues=[];let lastId=0,lastTo=0;for(let i=0;i<loopOrder.length;i+=2){loopValues.push(zig(loopOrder[i]-lastId),zig(loopOrder[i+1]-lastTo));lastId=loopOrder[i];lastTo=loopOrder[i+1];}chunks[11].push(tokens(loopValues));
  const books=chunks.map(bookFor);let text='',buffer=0,bits=0;
  function write(value,count){if(count>48)throw Error('animation.limit');buffer+=value*2**bits;bits+=count;while(bits>=6){text+=alphabet[buffer%64];buffer=Math.floor(buffer/64);bits-=6;}}
  function chunk(c,f){for(const token of chunks[c][f]){const [code,length]=books[c].codes.get(token.symbol);write(code,length);if(token.extra!==undefined)write(token.value,token.extra);if(token.symbol===0){const n=token.run,k=Math.floor(Math.log2(n));for(let i=0;i<k;i++)write(0,1);write(1,1);write(n-2**k,k);}}}
  for(let f=0;f<animation.frames.length;f++){for(let c=0;c<12;c++)chunk(c,f);}chunk(11,animation.frames.length);if(bits)text+=alphabet[buffer%64];
  return {text,books:books.map(({root,tree})=>({root,tree})),patches,orders,loopOrder};
 }
 function compactAnimation(animation){
  return {...animation,frames:animation.frames.map(frame=>Float64Array.from(frame,(v,i)=>{
   const c=i%8;if(c>=1&&c<=4)return c>=3&&v>0?Math.max(1,Math.round(v/5)):Math.round(v/5);
   if(c===5)return Math.round(v/10);
   if(c===6){const r=Math.round(((v>>>16)&255)*31/255),g=Math.round(((v>>>8)&255)*63/255),b=Math.round((v&255)*31/255);return (v>>>24)*16777216+r*65536+g*256+b;}return v;
  }))};
 }
 function encodeHuffman(animation){
  // Two passes, retaining only one channel's tokens. No per-frame order plans
  // or diagnostic patch arrays: fixed paint slots never use them in playback.
  const N=animation.controls,counts=Array.from({length:12},()=>new Map());
  function visit(consume){let previous=null;for(const frame of animation.frames){for(let c=0;c<11;c++){
   const values=new Float64Array(N);for(let id=0;id<N;id++){const at=id*8+(c<6?c:c<10?6:7);let v=frame[at]||0,p=previous?.[at]||0;if(c>=6&&c<10){const shift=(c-6)*8;v=(v>>>shift)&255;p=(p>>>shift)&255;values[id]=zig(((v-p+128)&255)-128);}else values[id]=zig(v-p);}consume(c,tokens(values));
  }previous=frame;}}
  visit((c,list)=>{for(const t of list)counts[c].set(t.symbol,(counts[c].get(t.symbol)||0)+1);});
  const books=counts.map(bookFor),parts=[];let text='',buffer=0,bits=0;
  function write(v,n){if(n>48)throw Error('animation.limit');buffer+=v*2**bits;bits+=n;while(bits>=6){text+=alphabet[buffer%64];buffer=Math.floor(buffer/64);bits-=6;if(text.length===8192){parts.push(text);text='';}}}
  visit((c,list)=>{for(const t of list){write(...books[c].codes.get(t.symbol));if(t.extra!==undefined)write(t.value,t.extra);if(t.symbol===0){const k=Math.floor(Math.log2(t.run));for(let i=0;i<k;i++)write(0,1);write(1,1);write(t.run-2**k,k);}}});
  if(bits)text+=alphabet[buffer%64];parts.push(text);
  return {text:parts.join(''),books:books.map(({root,tree})=>({root,tree}))};
 }
 function build(animation,options={}){
  const compact=options.compact===true,packed=encode(compact?compactAnimation(animation):animation),index=LuaExport.parseTemplateIndex(options.imageTemplateIndex)??LuaExport.IMAGE_TEMPLATE_PLACEHOLDER,width=options.width??animation.width;
  if(!Number.isFinite(width)||width<=0)throw Error('animation.limit');
  const fps=Number(options.fps??animation.fps??0);if(!Number.isSafeInteger(fps)||fps<0)throw Error('animation.fpsInvalid');
  const uiBudget=Number(options.uiBudget??2048);if(!Number.isSafeInteger(uiBudget)||uiBudget<32)throw Error('animation.limit');
  const books='{'+packed.books.map(b=>'{'+b.root+', {'+b.tree.join(',')+'}}').join(',')+'}';
  return `-- Primeval animation: fixed paint slots, budgeted preparation and atomic frame swaps.
local IMAGE_TEMPLATE_INDEX=${index}
local PLAYBACK_FPS=${fps} -- edit to lower playback FPS; 0 = stored timing
local ENCODED_FPS=${Number(animation.fps)||0}
local WIDTH,W,H,N=${width},${animation.width},${animation.height},${animation.controls}
local GEOMETRY,ROTATION,COMPACT=${compact?"0.5,1,true":"0.1,0.1,false"}
local LOOP=${animation.loop!==false?'true':'false'}
-- Lower these batches if the host has a stricter execution budget.
local LOAD_BATCH,SPAWN_BATCH=2048,10
-- Native UI calls per game update. Lower this if the 3D scene still hitches.
local MAX_UI_CALLS=${uiBudget}
local SCAN_BATCH,ORDER_BATCH=512,16
local CULL_INVISIBLE=true
local FREEZE_FRAME=0 -- Set 1 to isolate rendering cost from animation updates.
-- The last complete frame stays visible while the next buffer is prepared.
-- Playback may hold/skip poses when the client cannot sustain the stored FPS.
local DATA="${packed.text}"
local books=${books}
local durations={${animation.durations.map(d=>Math.max(1,Math.round(d*1e6))).join(',')}}
local moveCounts={${packed.orders.map(a=>a.length).concat(packed.loopOrder.length).join(',')}}
local root,controls,colors,keys,ends,pools,front,pending,empty,transparent
local total,current,clock,ready,loading,job,work,shownDue,displayClock,estimate,uiBudget
local digits,prefixes,at,buffer,bits,state,oldState,components,stage,bookAt,slot,f,c,run,remaining,fixed,changed
local assets={100002,100001,100003,106057}
local function take(count)
 while bits<count do local d=digits[string.byte(DATA,at)] assert(d,"Invalid animation data") buffer=buffer+d*2^bits bits=bits+6 at=at+1 end
 local power=2^count local value=buffer%power buffer=math.floor(buffer/power) bits=bits-count return value
end
local function symbol(channel)
 local book=books[channel] local node=book[1] if node<0 then return -node-1 end
 while bits<8 do local d=digits[string.byte(DATA,at)] if d==nil then d=0 end buffer=buffer+d*2^bits bits=bits+6 at=at+1 end
 local entry=prefixes[channel][buffer%256+1] node=entry[1] local length=entry[2] take(length)
 local tree=book[2] while node>0 do node=tree[node*2-1+take(1)] end return -node-1
end
local function value(channel)
 if run>0 then run=run-1 return 0 end
 local s=symbol(channel) if s==1 then return 0 elseif s>1 then return 2^(s-2)+take(s-2) end
 local count=0 while take(1)==0 do count=count+1 assert(count<53,"Invalid animation run") end
 run=2^count+take(count)-1 return 0
end
local function signed(v) if v%2==1 then return -math.floor((v+1)/2) end return math.floor(v/2) end
local function image(parent)
 local control=game.InstantiateClientUIControl(IMAGE_TEMPLATE_INDEX,parent) assert(control,"Image Control Template failed")
 control:SetActive(true) control:SetVisible(false) control:SetAnchorMin(0.5,0.5) control:SetAnchorMax(0.5,0.5) control:SetPivot(0.5,0.5)
 control.imageType=Enum.ImageType.Stretch control.enableMask=false return control
end
local function add(key,v)
 state[key]=v if f==1 or (oldState[key] or 0)~=v then changed=true end
end
function OnStart()
 controls=nil colors={} keys={} ends={} pools={} empty={} transparent=nil
 total=0 current=0 clock=0 shownDue=0 displayClock=0 estimate=0
 uiBudget=MAX_UI_CALLS front=0 pending=nil ready=false loading=true job=nil work={}
 digits={} prefixes={} at=1 buffer=0 bits=0 run=0 state={} oldState={} components={}
 stage=1 bookAt=1 slot=1 f=1 c=1 changed=true fixed=nil
 script:EnableUpdate(true)
end
local function renderable(a)
 if not CULL_INVISIBLE then return true end
 local p=state[a+7] or 0 if math.floor(p/16777216)==0 then return false end
 local w,h=(state[a+4] or 0)*GEOMETRY,(state[a+5] or 0)*GEOMETRY
 if w<=0 or h<=0 then return false end
 local angle=(state[a+6] or 0)*ROTATION*math.pi/180
 local co,si=math.abs(math.cos(angle)),math.abs(math.sin(angle))
 local rx,ry=(w*co+h*si)*0.5,(w*si+h*co)*0.5
 local x,y=(state[a+2] or 0)*GEOMETRY,(state[a+3] or 0)*GEOMETRY
 return x+rx>=-W*0.5-2 and x-rx<=W*0.5+2 and y+ry>=-H*0.5-2 and y-ry<=H*0.5+2
end
local function load()
 if stage==1 then
  local alphabet="${alphabet}" for i=1,64 do digits[string.byte(alphabet,i)]=i-1 end stage=2 remaining=remaining-64 return
 elseif stage==2 then
  local book=books[bookAt] local tree=book[2] local entries={} for v=0,255 do local node=book[1] local length=0 local n=v while node>0 and length<8 do node=tree[node*2-1+n%2] n=math.floor(n/2) length=length+1 end entries[v+1]={node,length} end
  prefixes[bookAt]=entries bookAt=bookAt+1 if bookAt>#books then stage=3 end remaining=remaining-256 return
 elseif stage==3 then
  local stop=math.min(N*8,slot+remaining-1) remaining=remaining-(stop-slot+1) for i=slot,stop do state[i]=0 end slot=stop+1
  if slot>N*8 then for i=1,#durations do total=total+durations[i] ends[i]=total end slot=1 stage=4 fixed={} changed=true end return
 elseif stage==4 then
  local weight=c==10 and 4 or 1 local limit=math.max(1,math.floor(remaining/weight)) if c==10 then limit=math.min(limit,32) end
  local stop=math.min(c<=11 and N or moveCounts[f],slot+limit-1)
  remaining=remaining-math.max(1,(stop-slot+1)*weight)
  for id=slot,stop do
   local delta=signed(value(c))
   if c<=6 then local key=(id-1)*8+c add(key,(oldState[key] or 0)+delta)
   elseif c<=10 then
    local key=(id-1)*4+c-6 local v=((components[key] or 0)+delta)%256 components[key]=v
    if c==10 then
     local base=(id-1)*4 local p=components[base+4]*16777216+components[base+3]*65536+components[base+2]*256+components[base+1]
     add((id-1)*8+7,p) if colors[p]==nil then
      local r,g,b=components[base+3],components[base+2],components[base+1] if COMPACT then r=math.floor(r*255/31+0.5) g=math.floor(g*255/63+0.5) b=math.floor(b*255/31+0.5) end
      colors[p]=Color.FromRGBA(r,g,b,components[base+4]) end
    end
   elseif c==11 then local key=(id-1)*8+8 add(key,(oldState[key] or 0)+delta)
   else -- Consume old order deltas; fixed draw slots need no playback sorting.
   end
  end
  slot=stop+1 if slot>(c<=11 and N or moveCounts[f]) then assert(run==0,"Invalid animation run length") slot=1 c=c+1 if c==13 then if f>1 and not changed then keys[f]=keys[f-1] stage=7 else fixed={} stage=5 end end end return
 elseif stage==5 then
  local stop=math.min(N,slot+math.max(1,math.floor(remaining/8))-1) remaining=remaining-math.max(1,(stop-slot+1)*8)
  for id=slot,stop do local a=(id-1)*8 if (state[a+1] or 0)~=0 and renderable(a) then
   local rank=state[a+8] or 0 assert(rank>=0 and rank<N and rank==math.floor(rank),"Invalid animation order")
   local dst=rank*8 assert(fixed[dst+1]==nil,"Duplicate animation order")
   for field=1,7 do fixed[dst+field]=state[a+field] end
  end end slot=stop+1 if slot>N then keys[f]=fixed fixed=nil slot=1 stage=7 end return
 elseif stage==7 then
  remaining=remaining-1 oldState=state state={} f=f+1 c=1 slot=1 changed=false
  if f<=#durations then stage=4 else stage=8 end return
 elseif stage==8 then
  local stop=math.min(moveCounts[f],slot+remaining-1) remaining=remaining-math.max(1,stop-slot+1)
  for i=slot,stop do value(12) end slot=stop+1
  if slot>moveCounts[f] then assert(run==0,"Invalid animation loop") stage=9 slot=1 end return
 elseif stage==9 then
  remaining=0 root=image(script.object) root:SetImage(Enum.ImageSource.StaticReference,100001)
  transparent=Color.FromRGBA(255,255,255,0) root.imageColor=transparent
  root.enableMask=true root.enableSoftEdge=false root.reverseMaskArea=false root:SetSizeDelta(WIDTH,WIDTH*H/W) root:SetAnchoredPosition(0,0)
  stage=10 return
 elseif stage==10 then
  remaining=0 for i=1,2 do local group=image(root) group.imageColor=transparent group:SetSizeDelta(WIDTH,WIDTH*H/W) group:SetAnchoredPosition(0,0) group:SetLocalScale(1,1,1) group:SetLocalRotation(0,0,0) group:SetVisible(true) pools[i]={root=group,controls={},shown=empty} end stage=11 slot=1 return
 elseif stage==11 then
  remaining=0 local stop=math.min(N*2,slot+SPAWN_BATCH-1)
  for index=slot,stop do local bank=math.floor((index-1)/N)+1 local id=(index-1)%N+1 pools[bank].controls[id]=image(pools[bank].root) end
  slot=stop+1 if slot>N*2 then stage=12 slot=1 end return
 elseif stage==12 then
  -- Children have entered OnStart before this initialization phase.
  remaining=0 local stop=math.min(N*2,slot+ORDER_BATCH-1)
  for index=slot,stop do local bank=math.floor((index-1)/N)+1 local id=(index-1)%N+1 pools[bank].controls[id]:SetSiblingIndex(math.floor(id-1)) end
  slot=stop+1 if slot>N*2 then stage=13 end return
 elseif stage==13 then
  remaining=0 for i=1,2 do pools[i].root:SetActive(false) end loading=false
  DATA=nil books=nil digits=nil prefixes=nil state=nil oldState=nil components=nil durations=nil moveCounts=nil fixed=nil
 end
end
local function frameAt(t)
 if not LOOP and t>=total then return #ends,total-(ends[#ends]- (ends[#ends-1] or 0)) end
 local cycle=LOOP and math.floor(t/total) or 0 local phase=t-cycle*total
 local low,high=1,#ends while low<high do local mid=math.floor((low+high)/2) if phase<ends[mid] then high=mid else low=mid+1 end end
 return low,cycle*total+(ends[low-1] or 0)
end
local function beginFrame(target,due)
 work.target=target work.due=due work.bank=front==1 and 2 or 1 work.id=1 work.field=1 work.elapsed=0 work.started=false
 if ready and keys[target]==pools[front].shown then work.bank=front pending=work job=nil return end
 if keys[target]==pools[work.bank].shown then pending=work job=nil return end
 job=work pending=nil
end
local function prepareFrame(limit)
 job.started=true local pool=pools[job.bank] local frame=keys[job.target] local prior=pool.shown local scale=WIDTH/W*GEOMETRY local scanned=0
 while job and limit>0 and scanned<SCAN_BATCH do
  local id=job.id local a=(id-1)*8 local kind=frame[a+1] or 0 local old=prior[a+1] or 0 local control=pool.controls[id] local field=job.field local wrote=false
  if field==1 then if kind~=0 and old~=kind then control:SetImage(Enum.ImageSource.StaticReference,assets[kind]) wrote=true end
  elseif field==2 then if (kind~=0)~=(old~=0) then control:SetVisible(kind~=0) wrote=true end
  elseif field==3 then if kind~=0 and (old==0 or frame[a+2]~=prior[a+2] or frame[a+3]~=prior[a+3]) then control:SetAnchoredPosition(frame[a+2]*scale,frame[a+3]*scale) wrote=true end
  elseif field==4 then if kind~=0 and (old==0 or frame[a+4]~=prior[a+4] or frame[a+5]~=prior[a+5]) then control:SetSizeDelta(frame[a+4]*scale,frame[a+5]*scale) wrote=true end
  elseif field==5 then if kind~=0 and (old==0 or frame[a+6]~=prior[a+6]) then control:SetLocalRotation(0,0,frame[a+6]*ROTATION) wrote=true end
  elseif field==6 then if kind~=0 and (old==0 or frame[a+7]~=prior[a+7]) then control.imageColor=colors[frame[a+7]] wrote=true end
  end
  if wrote then limit=limit-1 end job.field=field+1
  if job.field==7 then job.field=1 job.id=id+1 scanned=scanned+1 end
  if job.id>N then
   pool.shown=frame if job.elapsed>0 then estimate=estimate==0 and job.elapsed or estimate*0.5+job.elapsed*0.5 end
   pending=job job=nil
  end
 end
end
local function present()
 local bank=pending.bank
 if bank~=front then if front~=0 then pools[front].root:SetActive(false) end pools[bank].root:SetActive(true) front=bank end
 controls=pools[front].controls current=pending.target shownDue=pending.due pending=nil
 if not ready then ready=true root:SetVisible(true) clock=0 shownDue=0 displayClock=0 end
end
local function expired()
 local cycle=LOOP and math.floor(pending.due/total) or 0
 return clock>=cycle*total+ends[pending.target]
end
local function schedule()
 if not LOOP and current==#ends then return end
 local lead=estimate
 local nextDue=shownDue+ends[current]-(ends[current-1] or 0)
 local target,due=frameAt(math.max(clock+lead*1000000,nextDue))
 if target==current and keys[target]==pools[front].shown then target,due=frameAt(due+ends[target]-(ends[target-1] or 0)) end
 beginFrame(target,due)
end
function OnUpdate(deltaTime)
 local dt=math.max(0,deltaTime)
 if loading then remaining=LOAD_BATCH for step=1,64 do load() if not loading or remaining<=0 then break end end return end
 if not root then return end
 if job and job.started then job.elapsed=job.elapsed+dt end
 local limit=math.max(1,uiBudget-2)
 if not ready then if not job and not pending then beginFrame(FREEZE_FRAME>0 and math.min(#ends,math.max(1,math.floor(FREEZE_FRAME))) or 1,0) end if job then prepareFrame(limit) end if pending then present() end return end
 if #ends==1 or FREEZE_FRAME>0 then script:EnableUpdate(false) return end
 clock=clock+dt*1000000 if not LOOP and clock>=total then clock=total-0.001 end
 displayClock=displayClock+dt
 local limited=PLAYBACK_FPS>0 and PLAYBACK_FPS~=ENCODED_FPS local allowed=not limited or displayClock>=1/PLAYBACK_FPS or (not LOOP and clock>=total-0.001)
 local swapped=false
 if pending and clock>=pending.due then if expired() then pending=nil elseif allowed then present() swapped=true end end
 if not job and not pending then schedule() end
 if job then prepareFrame(limit) end
 -- A frame completed during this callback is useful even if preparation ran late.
 -- Dropping it here can starve playback when work takes longer than one pose.
 if pending and not swapped and clock>=pending.due and allowed then present() swapped=true end
 if swapped then if limited then displayClock=displayClock%(1/PLAYBACK_FPS) else displayClock=0 end end
 if not job and not pending and (LOOP or current<#ends) then schedule() end
 if not LOOP and current==#ends and clock>=total-0.001 then script:EnableUpdate(false) end
end
function OnDestroy()
 script:EnableUpdate(false) loading=false job=nil pending=nil work=nil
 if root and root.alive then game.DestroyClientUIControl(root) end
 root=nil controls=nil colors=nil keys=nil ends=nil pools=nil empty=nil transparent=nil
 DATA=nil books=nil digits=nil prefixes=nil state=nil oldState=nil components=nil durations=nil moveCounts=nil fixed=nil
end

`;
 }
 function minify(source){
  // Lex strings/long strings before removing comments; never rewrite literals.
  const tokens=[];let at=0;
  while(at<source.length){
   const rest=source.slice(at);let match;
   if((match=/^\s+/.exec(rest))){at+=match[0].length;continue;}
   if(rest.startsWith('--')){const long=/^--\[(=*)\[/.exec(rest);if(long){const end=source.indexOf(']'+long[1]+']',at+long[0].length);if(end<0)throw Error('Unclosed Lua comment');at=end+long[1].length+2;}else{const end=source.indexOf('\n',at);at=end<0?source.length:end;}continue;}
   if(rest[0]==='"'||rest[0]==="'"){const start=at++,quote=rest[0];while(at<source.length){if(source[at]==='\\'){at+=2;continue;}if(source[at++]===quote)break;}tokens.push(source.slice(start,at));continue;}
   if((match=/^\[(=*)\[/.exec(rest))){const end=source.indexOf(']'+match[1]+']',at+match[0].length);if(end<0)throw Error('Unclosed Lua string');const stop=end+match[1].length+2;tokens.push(source.slice(at,stop));at=stop;continue;}
   match=/^(?:[A-Za-z_][A-Za-z_0-9]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\.\.\.|\.\.|==|~=|<=|>=|<<|>>|\/\/|::|.)/.exec(rest);
   tokens.push(match[0]);at+=match[0].length;
  }
  // Internal aliases only; keep host methods, lifecycle names and editable
  // settings intact. These generated names cannot shadow existing identifiers.
  const names='SET_IMAGE SET_VISIBLE SET_POSITION SET_DIMENSIONS SET_ROTATION SHARED_METHODS STATIC rangeModels rangePrevious rangeLow rangeHigh rangeCode rangeSlot rangeChannel rangeMode rangeRun rangeLast rangeTake rangeBit rangeNumber releaseRange'.split(' '),aliases=new Map();
  names.forEach((name,i)=>{const alias='_Q'+i;if(!tokens.includes(alias))aliases.set(name,alias);});
  let out='',previous='';for(let i=0;i<tokens.length;i++){let token=tokens[i];if(aliases.has(token)&&tokens[i-1]!=='.'&&tokens[i-1]!==':'&&!(tokens[i+1]==='='&&(tokens[i-1]==='{'||tokens[i-1]===',')))token=aliases.get(token);if(previous&&(/[\w]$/.test(previous)&&/^\w/.test(token)||/[.\d]$/.test(previous)&&token[0]==='.'||previous==='-'&&token==='-'||previous==='['&&(token==='['||token==='=')))out+=' ';out+=token;previous=token;}return out;
 }
 /* Splat soft corners are a fixed 64 of 900 units (image 106057), so clips with
  * Splat shapes (kind 4) play on a 900-unit-tall canvas, as the Splat Lua
  * export does. Display size and shape proportions are unchanged. */
 const SPLAT_CANVAS_HEIGHT=900;
 function splatCanvas(animation){
  if(!animation.frames.some(frame=>{for(let at=0;at<frame.length;at+=8)if(frame[at]===4)return true;return false;}))return animation;
  const k=SPLAT_CANVAS_HEIGHT/animation.height;
  return {...animation,width:animation.width*k,height:SPLAT_CANVAS_HEIGHT,frames:animation.frames.map(frame=>Float64Array.from(frame,(v,i)=>{
   const c=i%8;return c>=1&&c<=4&&frame[i-c]?Math.round(v*k):v;
  }))};
 }
 function buildFast(animation,options={}){
  const codec=typeof AnimationCodec!=='undefined'?AnimationCodec:require('./animation-codec.js');
  const runtime=typeof AnimationPlayerRuntime!=='undefined'?AnimationPlayerRuntime:require('./animation-player-runtime.js');
  const compact=options.compact===true,canvas=splatCanvas(animation);let input=compact?compactAnimation(canvas):canvas;
  const index=LuaExport.parseTemplateIndex(options.imageTemplateIndex)??LuaExport.IMAGE_TEMPLATE_PLACEHOLDER,width=options.width??animation.width;
  const fps=Number(options.fps??animation.fps??0);
  if(!Number.isSafeInteger(fps)||fps<0)throw Error('animation.fpsInvalid');
  const loadSpeed=Number(options.loadSpeed??1);if(!(loadSpeed>0&&Number.isFinite(loadSpeed)))throw Error('animation.limit');
  if(!Number.isFinite(width)||width<=0||!Number.isFinite(animation.width)||animation.width<=0||!Number.isFinite(animation.height)||animation.height<=0||!Number.isSafeInteger(animation.controls)||animation.controls<1||!animation.frames.length||animation.frames.length!==animation.durations.length)throw Error('animation.limit');
  for(const frame of input.frames){if(frame.length>animation.controls*8||frame.length%8||!frame.every(Number.isSafeInteger))throw Error('animation.limit');}
  if(animation.durations.some(d=>!Number.isFinite(d)||d<=0))throw Error('animation.limit');
  let planning={changed:false};
  if(options.optimizeOrder!==false){
   const order=typeof AnimationOrder!=='undefined'?AnimationOrder:require('./animation-order.js');
   try{const plan=order.plan(input.frames,{compact,dimensions:[width,canvas.width,canvas.height,animation.controls],lines:{LOOP:String(animation.loop!==false)}});input={...input,frames:plan.frames};planning=plan.report;}
   catch(error){if(!error.message.startsWith('Draw-order dependency graph exceeds'))throw error;planning={changed:false,reason:'overlap-budget'};}
  }
  // Range coding saved only 3–4% on supplied clips but took ~10x as many game
  // updates to load. Keep it opt-in for tools; website downloads use fast decode.
  const huffman=encodeHuffman(input),bookText='{'+huffman.books.map(b=>'{'+b.root+',{'+b.tree.join(',')+'}}').join(',')+'}';
  const range=options.compression==='maximum'?codec.encode(input):null;
  const useRange=range!==null&&range.length+12*8<huffman.text.length+bookText.length,packed=useRange?range:huffman.text;
  const header=`-- ${canvas===animation?'Primeval':'Splat'} animation: lossless compression, one control pool, precompiled updates.
-- Other scripts: targetScript:Invoke("Play"), :Invoke("Stop"), :Invoke("Restart").
local IMAGE_TEMPLATE_INDEX=${index}
local PLAYBACK_FPS=${fps} -- 0 = stored timing
local LOAD_SPEED=${loadSpeed} -- higher loads faster; lower it if the game shows an execution timeout error
local ENCODED_FPS=${Number(animation.fps)||0}
local WIDTH,W,H,N=${width},${canvas.width},${canvas.height},${animation.controls}
local GEOMETRY,ROTATION,COMPACT=${compact?'0.5,1,true':'0.1,0.1,false'}
local LOOP=${animation.loop!==false}
local CODEC=${useRange?2:1}
local COLOR_TRANSFORM=false
local VARIANT="fast"
local LOSSLESS_DRAW_ORDER=${planning.changed}
-- Export planning: ${JSON.stringify(planning)}
local DATA="${packed}"
local books=${useRange?'{'+Array(12).fill('{-2,{}}').join(',')+'}':bookText}
local durations={${animation.durations.map(d=>Math.max(1,Math.round(d*1e6))).join(',')}}
local moveCounts={${Array(animation.frames.length+1).fill(0).join(',')}}
`;
  const player=useRange?runtime.replace('local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=6144,128,256','local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=384,128,256'):runtime.replace(/-- @BEGIN_RANGE_CODEC@[\s\S]*?-- @END_RANGE_CODEC@\r?\n/,'').replaceAll('releaseRange() ','');
  return header+minify(player)+'\n';
 }
 function buildAsync(animation,options={}){
  return new Promise((resolve,reject)=>{
   const worker=new Worker('js/worker-animation-export.js?v=7');
   worker.onmessage=({data})=>{worker.terminate();if(data.error)reject(Error(data.error));else resolve(data.text);};
   worker.onerror=event=>{worker.terminate();reject(Error(event.message||'animation.fitError'));};
   try{worker.postMessage({animation,options});}catch(error){worker.terminate();reject(error);}
  });
 }
 return {encode,encodeHuffman,build:buildFast,buildAsync,buildLegacy:build,planOrder,compactAnimation,minify};
})();
if(typeof module!=='undefined')module.exports=AnimationLua;

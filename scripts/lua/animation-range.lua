-- Only used while loading. Playback never reads compressed data.
local rangeModels,rangePrevious,rangeLow,rangeHigh,rangeCode,rangeSlot,rangeChannel,rangeMode,rangeRun,rangeLast
local function releaseRange()
 rangeModels=nil rangePrevious=nil rangeCode=nil
end
local function rangeTake()
 if bits==0 then local d=digits[string.byte(DATA,at)] or 0 buffer=d bits=6 at=at+1 end
 local v=buffer%2 buffer=math.floor(buffer/2) bits=bits-1 return v
end
local function rangeBit(context)
 local p=rangeModels[context] or 2048 local mid=rangeLow+math.floor((rangeHigh-rangeLow+1)*p/4096)-1
 local v=rangeCode>mid and 1 or 0
 if v==1 then rangeLow=mid+1 p=math.max(1,p-math.max(1,math.floor(p/32))) else rangeHigh=mid p=math.min(4095,p+math.max(1,math.floor((4096-p)/32))) end
 rangeModels[context]=p
 while true do
  if rangeHigh<2147483648 then
  elseif rangeLow>=2147483648 then rangeLow=rangeLow-2147483648 rangeHigh=rangeHigh-2147483648 rangeCode=rangeCode-2147483648
  elseif rangeLow>=1073741824 and rangeHigh<3221225472 then rangeLow=rangeLow-1073741824 rangeHigh=rangeHigh-1073741824 rangeCode=rangeCode-1073741824
  else break end
  rangeLow=rangeLow*2 rangeHigh=rangeHigh*2+1 rangeCode=rangeCode*2+rangeTake()
 end
 return v
end
local function rangeNumber(context,count)
 local v,node=0,1 for i=1,count do local b=rangeBit(context+node) v=v*2+b node=node*2+b end return v
end
if CODEC==2 then
 value=function(channel)
  if not rangeModels then
   rangeModels={} rangePrevious={} rangeLow=0 rangeHigh=4294967295 rangeCode=0 rangeSlot=0 rangeChannel=0 rangeRun=0
   for i=1,32 do rangeCode=rangeCode*2+rangeTake() end
  end
  local base=(channel-1)*4096
  if rangeChannel~=channel or rangeSlot==N then
   rangeChannel=channel rangeSlot=0 rangeLast=0 rangeRun=0 rangeMode=rangeNumber(base+3500,2) assert(rangeMode<3,"Invalid predictor")
   if not rangePrevious[channel] then rangePrevious[channel]={} end
  end
  rangeSlot=rangeSlot+1 local v=0
  if rangeRun>0 then rangeRun=rangeRun-1 else
   local s=rangeNumber(base,6)
   if s>1 then local k=s-2 assert(k<=48,"Invalid animation value") v=powers[k] for j=k-1,0,-1 do v=v+rangeBit(base+64+k*53+j)*powers[j] end
   elseif s==0 then
    local k=0 while rangeBit(base+3000+k)==0 do k=k+1 assert(k<=48,"Invalid animation run") end
    rangeRun=powers[k]-1 for j=k-1,0,-1 do rangeRun=rangeRun+rangeBit(base+3064+j)*powers[j] end
   end
  end
  local delta=v%2==1 and -(v+1)/2 or v/2
  local previous=rangePrevious[channel]
  if rangeMode==1 then delta=delta+(previous[rangeSlot] or 0) elseif rangeMode==2 then delta=delta+rangeLast end
  previous[rangeSlot]=delta rangeLast=delta
  if rangeSlot==N then assert(rangeRun==0,"Invalid animation run length") end
  return delta<0 and -delta*2-1 or delta*2
 end
end

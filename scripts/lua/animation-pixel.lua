-- Pixel-perfect poses (CODEC 3, see encodePixelStream in animation-lua.js):
-- runs repeated from the previous pose and predicted rectangles, decoded
-- straight into the same keys the channel decoder builds. Loading only.
local px
local function pixelNumber(channel) local k=symbol(channel) return powers[k]-1+take(k) end
local function pixelSigned(channel) local v=pixelNumber(channel) if v%2==1 then return -(v+1)/2 end return v/2 end
local function pixelFrame()
 if not px then px={colors={},n=0,raw={}} end
 if not px.fixed then
  px.prior=f>1 and keys[f-1] or {} px.priorRaw=px.raw px.priorN=px.n
  px.n=px.n+pixelSigned(10) assert(px.n>=0 and px.n<=N,"Invalid pixel pose")
  px.fixed={} px.raw={} px.p=0 px.d=0 px.run=0 px.last=nil px.same=f>1 and px.n==px.priorN remaining=remaining-1
 end
 local fixed,raw,prior,priorRaw,norm=px.fixed,px.raw,px.prior,px.priorRaw,PIXEL
 local scale=WIDTH/W*GEOMETRY
 while px.p<px.n and remaining>0 and colorRemaining>0 do
  local p=px.p
  if px.run>0 then
   local q=p+px.d local src,dst=q*8,p*8
   if prior[src+1] then for k=1,7 do fixed[dst+k]=prior[src+k] end for k=1,3 do raw[p*3+k]=priorRaw[q*3+k] end px.last=p end
   px.run=px.run-1 px.p=p+1 remaining=remaining-2
  else
   local op=symbol(1) remaining=remaining-1
   if op==0 then px.run=pixelNumber(2)+1 if px.d~=0 then px.same=false end
   elseif op==2 then px.d=px.d+pixelSigned(3) px.run=pixelNumber(2)+1 px.same=false
    assert(p+px.d>=0 and p+px.d+px.run<=px.priorN,"Invalid pixel shift")
   elseif op==3 then px.p=p+1 px.same=false
   else
    px.same=false
    local recent,s,color=px.colors,symbol(4)
    if s==0 then color=take(32) s=#recent+1 else color=recent[s] assert(color,"Invalid pixel color") end
    for i=s,2,-1 do recent[i]=recent[i-1] end recent[1]=color
    local w,h=norm[5]+pixelNumber(5)*norm[6],norm[7]+pixelNumber(6)*norm[8]
    local last,lastLeft,lastTop=px.last,0,0 if last then lastLeft,lastTop=raw[last*3+1],raw[last*3+2] end
    local dt=pixelSigned(7) local top,left=lastTop+dt
    if last and dt==0 then left=lastLeft+math.floor(2*raw[last*3+3]/norm[2])+pixelSigned(8) else left=lastLeft+pixelSigned(9) end
    if colors[color]==nil then
     local a=math.floor(color/16777216) local rgb=color-a*16777216 local r=math.floor(rgb/65536) local g=math.floor((rgb-r*65536)/256) local b=math.floor(rgb-r*65536-g*256)
     colors[color]=Color.FromRGBA(r,g,b,a) colorRemaining=colorRemaining-1
    end
    local dst=p*8
    fixed[dst+1]=2 fixed[dst+2]=(norm[1]+left*norm[2]+w)/2*scale fixed[dst+3]=(norm[3]+top*norm[4]-h)/2*scale
    fixed[dst+4]=w*scale fixed[dst+5]=h*scale fixed[dst+6]=0*ROTATION fixed[dst+7]=colors[color]
    raw[p*3+1]=left raw[p*3+2]=top raw[p*3+3]=w px.last=p px.p=p+1 remaining=remaining-8
   end
  end
 end
 if px.p<px.n then return false end
 assert(px.run==0,"Invalid pixel run")
 keys[f]=px.same and keys[f-1] or fixed px.fixed=nil px.prior=nil px.priorRaw=nil
 if f>=#durations then px=nil end
 return true
end

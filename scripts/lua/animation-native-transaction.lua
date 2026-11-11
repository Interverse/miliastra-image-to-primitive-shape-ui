-- Native experiment: suspend only our generated image tree while applying edits.
-- The owner script stays active; no yield or allocation occurs inside a frame.
local transactionSetter,nativeTuning,untunedTick,nativeModes,nativeSetters,nativeScores
local nativePhase,nativeElapsed,nativeSamples,nativeWinner,nativeVerifyBaseline
local function selectNative(mode)
 NATIVE_TRANSACTION_MODE=mode transactionSetter=nativeSetters[mode]
end
local function finishNative(mode,message)
 selectNative(mode) nativeTuning=false
 if untunedTick then variantTick=untunedTick untunedTick=nil end
 nativeModes=nil nativeScores=nil nativeSetters=nil
 print("GIF native: "..message.."; mode "..mode.." selected.")
end
local function tuneNative(dt)
 if dt<=0 then return end
 if dt>.25 then finishNative(0,"calibration stopped after a long frame") return end
 nativeElapsed=nativeElapsed+dt nativeSamples=nativeSamples+1
 if nativeElapsed<NATIVE_TEST_SECONDS then return end
 local fps=nativeSamples/nativeElapsed
 print("GIF native mode "..NATIVE_TRANSACTION_MODE..": "..string.format("%.1f",fps).." FPS")
 nativeElapsed=0 nativeSamples=0
 if nativePhase<=#nativeModes then
  nativeScores[NATIVE_TRANSACTION_MODE]=fps nativePhase=nativePhase+1
  if nativePhase<=#nativeModes then selectNative(nativeModes[nativePhase]) return end
  nativeWinner=0 local best=nativeScores[0] local required=best*1.03
  for _,mode in ipairs(nativeModes) do if mode~=0 and nativeScores[mode]>required and nativeScores[mode]>best then best=nativeScores[mode] nativeWinner=mode end end
  if nativeWinner==0 then finishNative(0,"no repeatable candidate improvement") return end
  print("GIF native: verifying candidate "..nativeWinner.." against direct updates.") selectNative(0) return
 end
 if not nativeVerifyBaseline then nativeVerifyBaseline=fps selectNative(nativeWinner) return end
 if fps>nativeVerifyBaseline*1.03 then finishNative(nativeWinner,"candidate verified") else finishNative(0,"candidate verification did not improve FPS") end
end
local function probeNative(frame,restore,mode,rootState)
 transactionSetter=nil
 local id
 for i=1,N do if frame[(i-1)*8+1] then id=i break end end
 if not id then return nil,false end
 local set
 local s=slots[id] local control=s[1] local a=(id-1)*8
 local otherId=id<N and id+1 or (id>1 and id-1 or nil)
 local other=otherId and slots[otherId] or nil
 local x,y=frame[a+2]+3.125,frame[a+3]-4.25
 local w,h=frame[a+4]+2.5,frame[a+5]+1.75 local angle=frame[a+6]+.625
 local asset=assets[frame[a+1]%3+1]
 local ok,reason=pcall(function()
  if mode==3 then
   local raw=root.SetLocalScale
   set=function(c,enabled) if enabled then raw(c,rootState[1],rootState[2],rootState[3]) else raw(c,0,0,rootState[3]) end end
  else set=mode==1 and root.SetActive or root.SetVisible end
  assert(set,"native strategy binding unavailable")
  local color=Color.FromRGBA(17,83,149,211)
  s[3](control,false) if other then other[3](other[1],true) end
  set(root,false)
  s[2](control,STATIC,asset) s[3](control,true) s[4](control,x,y)
  if TRANSFORM_GEOMETRY then s[5](control,w,h,1) else s[5](control,w,h) end
  s[6](control,0,0,angle) control.imageColor=color
  if other then other[3](other[1],false) end
  set(root,true)
  root:SetVisible(true)
  assert(control.visible==true,"showing a control was not retained")
  if other then assert(other[1].visible==false,"hiding a control was not retained") end
  local px,py=control:GetAnchoredPosition()
  local sx,sy if TRANSFORM_GEOMETRY then sx,sy=control:GetLocalScale() else sx,sy=control:GetSizeDelta() end
  local rx,ry,rz=control:GetLocalRotation() local r,g,b,alpha=Color.ToRGBA(control.imageColor)
  local aminx,aminy=control:GetAnchorMin() local amaxx,amaxy=control:GetAnchorMax() local pivotx,pivoty=control:GetPivot()
  assert(aminx==.5 and aminy==.5 and amaxx==.5 and amaxy==.5 and pivotx==.5 and pivoty==.5,"anchors were reset")
  if TRANSFORM_GEOMETRY then local bw,bh=control:GetSizeDelta() assert(math.abs(bw-1)<.001 and math.abs(bh-1)<.001,"unit geometry was reset") end
  assert(math.abs(px-x)<.001 and math.abs(py-y)<.001,"position was not retained")
  assert(math.abs(sx-w)<.001 and math.abs(sy-h)<.001,"dimensions were not retained")
  assert(math.abs(rx%360)<.001 and math.abs(ry%360)<.001 and math.abs((rz-angle+180)%360-180)<.001,"rotation was not retained")
  assert(r==17 and g==83 and b==149 and alpha==211,"color was not retained")
  assert(control.imageId==asset,"image was not retained")
  assert(control.imageType==Enum.ImageType.Stretch and control.enableMask==false,"image options were reset")
  assert(root.imageId==100001 and root.enableMask,"mask was reset")
  local _,_,_,rootAlpha=Color.ToRGBA(root.imageColor) assert(rootAlpha==0,"mask color was reset")
  local rw,rh=root:GetSizeDelta() local rpx,rpy=root:GetAnchoredPosition() local rsx,rsy,rsz=root:GetLocalScale()
  local rminx,rminy=root:GetAnchorMin() local rmaxx,rmaxy=root:GetAnchorMax() local pivx,pivy=root:GetPivot()
  assert(rminx==.5 and rminy==.5 and rmaxx==.5 and rmaxy==.5 and pivx==.5 and pivy==.5,"mask anchors were reset")
  assert(root.imageType==Enum.ImageType.Stretch and root.enableSoftEdge==false and root.reverseMaskArea==false,"mask options were reset")
  assert(math.abs(rw-WIDTH)<.001 and math.abs(rh-WIDTH*H/W)<.001 and math.abs(rpx)<.001 and math.abs(rpy)<.001,"mask dimensions were reset")
  assert(math.abs(rsx-rootState[1])<.001 and math.abs(rsy-rootState[2])<.001 and math.abs(rsz-rootState[3])<.001,"mask scale was not restored")
  if not other then set(root,false) s[3](control,false) set(root,true) root:SetVisible(true) assert(control.visible==false,"hiding a control was not retained") end
 end)
 -- Restore the real first pose even if a binding rejects inactive edits.
 local restored,restoreError=pcall(function()
  if set then set(root,true) end
  root:SetActive(true) root:SetVisible(false) root:SetAnchorMin(.5,.5) root:SetAnchorMax(.5,.5) root:SetPivot(.5,.5)
  root:SetLocalScale(rootState[1],rootState[2],rootState[3]) root:SetLocalRotation(rootState[4],rootState[5],rootState[6])
  root:SetSizeDelta(WIDTH,WIDTH*H/W) root:SetAnchoredPosition(0,0) root:SetImage(STATIC,100001) root.imageType=Enum.ImageType.Stretch root.imageColor=transparent
  root.enableMask=true root.enableSoftEdge=false root.reverseMaskArea=false restore(s,frame,a)
  if other then local index=(otherId-1)*8 if frame[index+1] then restore(other,frame,index) else other[3](other[1],false) end end
 end)
 if not restored then error(restoreError,0) end
 if not ok then print("GIF native mode "..mode.." rejected: "..tostring(reason)) return nil,true end
 return set,false
end
local function initNativePolicy(frame,restore)
 if PROFILE_LUA_ONLY or FREEZE_FRAME>0 or #ends==1 then AUTO_NATIVE_UPDATES=false NATIVE_TRANSACTION_MODE=0 return false end
 if not LOOP then AUTO_NATIVE_UPDATES=false end
 if not AUTO_NATIVE_UPDATES and NATIVE_TRANSACTION_MODE==0 then return false end
 local ok,state=pcall(function()local sx,sy,sz=root:GetLocalScale() local rx,ry,rz=root:GetLocalRotation() assert(type(sx)=="number" and type(sy)=="number" and type(sz)=="number") return {sx,sy,sz,rx,ry,rz}end)
 if not ok then NATIVE_TRANSACTION_MODE=0 AUTO_NATIVE_UPDATES=false print("GIF native: calibration unavailable; direct mode selected.") return false end
 nativeSetters={} nativeModes={0} nativeScores={} local repair=false
 for mode=1,3 do if AUTO_NATIVE_UPDATES or NATIVE_TRANSACTION_MODE==mode then
  local setter,failed=probeNative(frame,restore,mode,state) repair=repair or failed
  if setter then nativeSetters[mode]=setter nativeModes[#nativeModes+1]=mode end
 end end
 if not AUTO_NATIVE_UPDATES then
  if nativeSetters[NATIVE_TRANSACTION_MODE] then transactionSetter=nativeSetters[NATIVE_TRANSACTION_MODE] else NATIVE_TRANSACTION_MODE=0 end
  nativeModes=nil nativeScores=nil nativeSetters=nil return repair
 end
 selectNative(0)
 if #nativeModes==1 then AUTO_NATIVE_UPDATES=false nativeModes=nil nativeScores=nil nativeSetters=nil return repair end
 nativeTuning=true nativePhase=1 nativeElapsed=0 nativeSamples=0 nativeVerifyBaseline=nil nativeWinner=0
 untunedTick=variantTick local base=untunedTick
 variantTick=function(dt) if nativeTuning then tuneNative(dt) end base(dt) end
 print("GIF native: calibration started; keep the scene stable until a mode is selected.")
 return repair
end
local function nativeTransaction(apply,target)
 if not transactionSetter then apply(target) return end
 transactionSetter(root,false)
 local ok,reason=pcall(apply,target)
 transactionSetter(root,true)
 if not ok then error(reason,0) end
end
local function destroyNativePolicy()
 if untunedTick then variantTick=untunedTick end
 transactionSetter=nil untunedTick=nil nativeTuning=false nativeModes=nil nativeScores=nil nativeSetters=nil
end

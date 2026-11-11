-- Every stored frame has its own parent and persistent children.
-- All frames finish loading before playback. More frames require more memory.
local groups,frameControls,frameList,initStage,initFrame,initSlot,orderSlot
local MAX_FRAME_CALLS=2
variantStart=function()
 groups={} frameControls={} initStage=1 initFrame=1 initSlot=1 orderSlot=1
end
variantLoad=function()
 if initStage==1 then
  local group=image(root) group.imageColor=transparent group:SetSizeDelta(WIDTH,WIDTH*H/W) group:SetAnchoredPosition(0,0) group:SetLocalScale(1,1,1) group:SetLocalRotation(0,0,0) group:SetVisible(true)
  groups[initFrame]=group frameControls[initFrame]={} frameList={} initStage=2 initSlot=1
 elseif initStage==2 then
  local frame=keys[initFrame] local made=0 local scanned=0
  while initSlot<=N and made<SPAWN_BATCH and scanned<SCAN_BATCH do
   local a=(initSlot-1)*8 if frame[a+1] then local control=image(groups[initFrame]) configure(control,frame,a) frameControls[initFrame][initSlot]=control frameList[#frameList+1]=control made=made+1 end initSlot=initSlot+1 scanned=scanned+1
  end
  if initSlot>N then initStage=3 orderSlot=1 end
 elseif initStage==3 then
  -- Assign stacking once after children enter OnStart, never during playback.
  local stop=math.min(#frameList,orderSlot+ORDER_BATCH-1) for id=orderSlot,stop do frameList[id]:SetSiblingIndex(math.floor(id-1)) end orderSlot=stop+1 if orderSlot>#frameList then initStage=4 end
 elseif initStage==4 then
  groups[initFrame]:SetActive(false) initFrame=initFrame+1 frameList=nil if initFrame>#ends then initStage=5 else initStage=1 end
 else
  groups[startFrame()]:SetActive(true) keys=nil colors=nil finishLoading()
 end
end
variantUpdate=function(target)
 groups[current]:SetActive(false) groups[target]:SetActive(true)
end
variantDestroy=function() groups=nil frameControls=nil frameList=nil end

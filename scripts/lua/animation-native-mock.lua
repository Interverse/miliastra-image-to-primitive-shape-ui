-- TEST HOST ONLY. Models the documented native API; not included in game scripts.
local nativeDepth=0 local tweenCreates=0 local sequenceCreates=0 local liveTweens=0 local liveSequences=0 local nativeCalls=0 local internalWrites=0
local function nativeEnter()
 local hook,mask,count=debug.gethook() debug.sethook() nativeDepth=nativeDepth+1 nativeCalls=nativeCalls+1 return hook,mask,count
end
local function nativeLeave(hook,mask,count)
 nativeDepth=nativeDepth-1 if hook then debug.sethook(hook,mask,count) end
end
local function get(control,key)
 if key=="anchoredPositionX" then return control.x or 0 elseif key=="anchoredPositionY" then return control.y or 0 elseif key=="localScaleX" then return control.sx or 1 elseif key=="localScaleY" then return control.sy or 1 elseif key=="sizeDeltaX" then return control.w or 0 elseif key=="sizeDeltaY" then return control.h or 0 elseif key=="localRotationZ" then return control.r or 0 elseif key=="imageColor" then return control.imageColor or 4294967295 end error("Unknown target field")
end
local function apply(control,target)
 assert(control.alive,"native batch targeted a destroyed image")
 for key,value in pairs(target) do
  if key=="anchoredPositionX" then control.x=value elseif key=="anchoredPositionY" then control.y=value elseif key=="localScaleX" then control.sx=value elseif key=="localScaleY" then control.sy=value elseif key=="sizeDeltaX" then control.w=value elseif key=="sizeDeltaY" then control.h=value elseif key=="localRotationZ" then control.r=value elseif key=="imageColor" then control.properties.imageColor=value else error("Unknown target field") end internalWrites=internalWrites+1
 end
end
local Sequence={}
function Sequence:Append(tween)
 local h,m,c=nativeEnter() assert(self.state=="Initial" and tween.state=="Initial") tween.state="Locked" self.children[#self.children+1]=tween nativeLeave(h,m,c) return self
end
Sequence.Join=Sequence.Append
function Sequence:Play()
 local h,m,c=nativeEnter() assert(self.state=="Initial") self.state="Playing" for _,t in ipairs(self.children) do t.state="Playing" end nativeLeave(h,m,c) return self
end
function Sequence:Restart()
 local h,m,c=nativeEnter() assert(self.state~="Initial" and self.state~="Dead") self.state="Playing" for _,t in ipairs(self.children) do apply(t.control,t.initial) t.state="Playing" end nativeLeave(h,m,c)
end
function Sequence:Complete()
 local h,m,c=nativeEnter() assert(self.state=="Playing") for _,t in ipairs(self.children) do apply(t.control,t.target) t.state="Completed" end self.state="Completed" nativeLeave(h,m,c)
end
function Sequence:Kill(complete)
 local h,m,c=nativeEnter() assert(not complete and self.state~="Dead") for _,t in ipairs(self.children) do t.state="Dead" liveTweens=liveTweens-1 end self.state="Dead" liveSequences=liveSequences-1 nativeLeave(h,m,c)
end
game.Tween=function(control,target,duration)
 local h,m,c=nativeEnter() assert(duration>0) tweenCreates=tweenCreates+1 liveTweens=liveTweens+1 local initial={} for key in pairs(target) do initial[key]=get(control,key) end local tween={control=control,target=target,initial=initial,state="Initial"} nativeLeave(h,m,c) return tween
end
game.TweenSequence=function()
 local h,m,c=nativeEnter() sequenceCreates=sequenceCreates+1 liveSequences=liveSequences+1 local sequence=setmetatable({children={},state="Initial"},{__index=function(t,key) local fn=Sequence[key] if BOUND_SEQUENCE_METHODS then return function(receiver,...) assert(receiver==t,"wrong sequence receiver") return fn(receiver,...) end end return fn end}) nativeLeave(h,m,c) return sequence
end

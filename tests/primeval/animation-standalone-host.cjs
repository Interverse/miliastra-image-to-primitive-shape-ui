'use strict';
module.exports=function(indices,bound=false){return `
local nodes={} local writes=0 local creates=0 local colors=0 local siblings=0 local enabled=false local destroys=0 local reads=0 local images=0 local activeOwner
local Control={}
function Control:SetActive(v) self.active=v writes=writes+1 end
function Control:SetVisible(v) self.visible=v writes=writes+1 end
function Control:SetAnchorMin(x,y) self.ax=x self.ay=y end function Control:SetAnchorMax(x,y) self.amx=x self.amy=y end function Control:SetPivot(x,y) self.pvx=x self.pvy=y end
function Control:GetAnchorMin() return self.ax,self.ay end function Control:GetAnchorMax() return self.amx,self.amy end function Control:GetPivot() return self.pvx,self.pvy end
function Control:SetAnchoredPosition(x,y) self.x=x self.y=y writes=writes+1 end
function Control:SetSizeDelta(w,h) self.w=w self.h=h writes=writes+1 end
function Control:SetLocalScale(x,y,z) self.sx=x self.sy=y self.sz=z writes=writes+1 end
function Control:SetLocalRotation(x,y,z) self.r=z writes=writes+1 end
function Control:SetImage(source,asset) self.asset=asset writes=writes+1 images=images+1 end
function Control:GetAnchoredPosition() return self.x or 0,self.y or 0 end
function Control:GetSizeDelta() return self.w or 0,self.h or 0 end
function Control:GetLocalScale() return self.sx or 1,self.sy or 1,self.sz or 1 end
function Control:GetLocalRotation() return 0,0,self.r or 0 end
function Control:SetSiblingIndex(i)
 assert(math.type(i)=="integer") local hook,mask,count=debug.gethook() debug.sethook()
 local children=self.parent.children for j,c in ipairs(children) do if c==self then table.remove(children,j) break end end table.insert(children,math.min(i+1,#children+1),self) writes=writes+1 siblings=siblings+1
 if hook then debug.sethook(hook,mask,count) end
end
local function kill(c) if not c.alive then return end c.alive=false for _,child in ipairs(c.children) do kill(child) end end
local valid={${indices.map(n=>'['+n+']=true').join(',')}}
game={InstantiateClientUIControl=function(index,parent)
 assert(valid[index],"wrong template") creates=creates+1 local c=setmetatable({parent=parent,children={},properties={},alive=true},{__index=function(t,k)
 if k=="imageId" then return rawget(t,"asset") end local method=Control[k] if method then reads=reads+1 if ${bound} then return function(receiver,...) assert(receiver==t,"wrong method receiver") return method(receiver,...) end end return method end return t.properties[k]
 end,__newindex=function(t,k,v) if k=="imageColor" then t.properties[k]=v writes=writes+1 elseif k=="localRotationZ" then rawset(t,"r",v) writes=writes+1 else rawset(t,k,v) end end}) parent.children[#parent.children+1]=c nodes[#nodes+1]=c return c
end,DestroyClientUIControl=function(c) assert(c.alive,"double destroy") destroys=destroys+1 kill(c) if c.parent then local children=c.parent.children for i,v in ipairs(children) do if v==c then table.remove(children,i) break end end end end}
Color={FromRGBA=function(r,g,b,a) colors=colors+1 return a*16777216+r*65536+g*256+b end}
Color.ToRGBA=function(c)return math.floor(c/65536)%256,math.floor(c/256)%256,c%256,math.floor(c/16777216) end
Enum={ImageSource={StaticReference=1},ImageType={Stretch=1}}
local world={children={}} script={object=world,EnableUpdate=function(self,v) enabled=v end}
`;};

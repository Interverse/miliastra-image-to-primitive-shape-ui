'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {generate}=require('../../scripts/animation-kernel.cjs');
const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});if(!lua)throw Error('Lua VM required for kernel parity');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kernel-parity-'));
try{
 for(const options of [{layout:'columns'},{layout:'rows'},{layout:'unpack'},{layout:'hybrid',blockSize:4},{layout:'hybrid',blockSize:8},{layout:'hybrid',blockSize:16}]){
  const source=`local SHARED_METHODS=true local TRANSFORM_GEOMETRY=true local STATIC=1 local calls=0
local function image(c,source,asset) assert(source==STATIC) c.asset=asset calls=calls+1 end
local function visible(c,v) c.visible=v calls=calls+1 end
local function position(c,x,y) c.x=x c.y=y calls=calls+1 end
local function scale(c,w,h,z) assert(z==1) c.w=w c.h=h calls=calls+1 end
local function size(c,w,h) c.w=w c.h=h calls=calls+1 end
local function rotate(c,x,y,z) assert(x==0 and y==0) c.r=z calls=calls+1 end
local SET_IMAGE,SET_VISIBLE,SET_POSITION,SET_DIMENSIONS,SET_ROTATION=image,visible,position,scale,rotate
${generate(options)}
local function has(mask,bit)return math.floor(mask/bit)%2==1 end
for _,bound in ipairs({false,true}) do for _,geometry in ipairs({false,true}) do
 SHARED_METHODS=not bound TRANSFORM_GEOMETRY=geometry SET_DIMENSIONS=geometry and scale or size
 for mask=1,63 do if dispatch[mask] then for _,n in ipairs({1,7,8,9,15,16,17,31}) do
  local columns="${options.layout}"=="columns" or ("${options.layout}"=="hybrid" and mask~=60 and mask~=61) local blocks="${options.layout}"=="hybrid" and (mask==60 or mask==61)
  local t,controls={},{} local expectedCalls=0
  for i=1,n do
   local c={asset=0,visible=true,x=0,y=0,w=1,h=1,r=0,imageColor=0} controls[i]=c
   local s={c} for index,fn in ipairs({image,visible,position,SET_DIMENSIONS,rotate}) do s[index+1]=function(receiver,...)assert(receiver==c) return fn(receiver,...)end end
   local row={bound and s or c}
   if has(mask,1)then row[#row+1]=100001+i expectedCalls=expectedCalls+1 end
   if has(mask,2)then row[#row+1]=i%2==1 expectedCalls=expectedCalls+1 end
   if has(mask,4)then row[#row+1]=i*3 row[#row+1]=-i*2 expectedCalls=expectedCalls+1 end
   if has(mask,8)then row[#row+1]=i+10 row[#row+1]=i+20 expectedCalls=expectedCalls+1 end
   if has(mask,16)then row[#row+1]=i*7 expectedCalls=expectedCalls+1 end
   if has(mask,32)then row[#row+1]=0xff123456+i end
   if columns then for k=1,#row do if not t[k]then t[k]={}end t[k][i]=row[k] end
   elseif blocks then local b=t[#t] if not b or #b>=#row*${options.blockSize||8} then b={} t[#t+1]=b end for k=1,#row do b[#b+1]=row[k]end
   else t[i]=row end
  end
  calls=0 dispatch[mask](t) assert(calls==expectedCalls,"extra/missing native method calls")
  for i,c in ipairs(controls)do
   assert(c.asset==(has(mask,1)and 100001+i or 0),"asset") assert(c.visible==(not has(mask,2)or i%2==1),"visibility")
   assert(c.x==(has(mask,4)and i*3 or 0)and c.y==(has(mask,4)and -i*2 or 0),"position")
   assert(c.w==(has(mask,8)and i+10 or 1)and c.h==(has(mask,8)and i+20 or 1),"dimensions")
   assert(c.r==(has(mask,16)and i*7 or 0),"rotation") assert(c.imageColor==(has(mask,32)and 0xff123456+i or 0),"color")
  end
 end end end
end end
print("PASS kernel parity")`;
  const file=path.join(dir,'test.lua');fs.writeFileSync(file,source);const r=spawnSync(lua,[file],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,JSON.stringify(options)+'\n'+r.stdout+r.stderr);console.log('PASS kernel semantics, every reachable mask, shared/bound receivers, both geometry modes, exact and partial block tails: '+JSON.stringify(options));
 }
 global.LuaExport=require('../../js/lua-export.js');
 const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs');
 const N=256,frames=Array.from({length:3},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [(id+f)%3+1,(id%16)*30-225+f,Math.floor(id/16)*15-110-f,50+f,40+f,id+f*13,0xff123456+id+f*101,id][i%8];}));
 const source=Player.buildLegacy({width:64,height:32,controls:N,frames,durations:[.07,.07,.07],fps:15},{imageTemplateIndex:123});
 const input=path.join(dir,'source.lua');fs.writeFileSync(input,source);
 const profiles={flat:buildVariants(source,{kernel:{layout:'flat'}}).fast,hybrid:buildVariants(source).fast};
 profiles.diagnostic=profiles.hybrid.replace('local PROFILE_LUA_ONLY=false','local PROFILE_LUA_ONLY=true');
 const counts={};
 for(const [name,code]of Object.entries(profiles)){
  const file=path.join(dir,name+'.lua');fs.writeFileSync(file,code);const r=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,file,'vm'],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(r.status,0,r.stdout+r.stderr);
  counts[name]=Number(r.stdout.match(/total=(\d+)/)[1]);if(name==='diagnostic')assert.match(r.stdout,/UI writes=0/);
 }
 assert.ok(counts.hybrid<counts.flat*.9,'the default kernel must reduce player-only instructions, excluding fake API implementations');
 console.log('PASS actual exported player: lower script-only instructions, exact parity, Lua-only diagnostic advances frames with zero native writes '+JSON.stringify(counts));
}finally{fs.rmSync(dir,{recursive:true,force:true});}

'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {generate,fields}=require('./animation-kernel.cjs'),flat=require('./animation-dispatch.cjs');
function benchmark(){
 const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});if(!lua)throw Error('Lua unavailable');
 const variants=[{name:'flat',layout:'flat',code:flat()}];
 for(const layout of ['columns','rows','unpack'])for(const unroll of [1,2,4,8])for(const hoist of [false,true])variants.push({name:layout+'-'+unroll+(hoist?'-local':''),layout,code:generate({layout,unroll,hoist})});
 for(const blockSize of [4,8,16])variants.push({name:'hybrid-'+blockSize,layout:'hybrid',blockSize,code:generate({layout:'hybrid',blockSize})});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lua-kernel-'));let results=[];
 try{
  for(const v of variants){
   const code=`local SHARED_METHODS=true local TRANSFORM_GEOMETRY=true local STATIC=1
local function noop() end local SET_IMAGE,SET_VISIBLE,SET_POSITION,SET_DIMENSIONS,SET_ROTATION=noop,noop,noop,noop,noop
${v.code}
local output={} local masks={32,60,61,63} local count=2000
for _,mask in ipairs(masks) do
 local stride=1 for b=0,5 do if math.floor(mask/2^b)%2==1 then stride=stride+((b==2 or b==3) and 2 or 1) end end
 local isBlock="${v.layout}"=="hybrid" and (mask==60 or mask==61) local isColumns="${v.layout}"=="columns" or ("${v.layout}"=="hybrid" and not isBlock)
 local t={} if isColumns then for k=1,stride do t[k]={} end end
 for i=1,count do local row={{imageColor=0},100001,true,10,20,30,40,50,0xff123456} -- overwrite with exactly this mask's fields
 row={ {imageColor=0} } if mask%2==1 then row[#row+1]=100001 end if math.floor(mask/2)%2==1 then row[#row+1]=true end
 if math.floor(mask/4)%2==1 then row[#row+1]=10 row[#row+1]=20 end if math.floor(mask/8)%2==1 then row[#row+1]=30 row[#row+1]=40 end
 if math.floor(mask/16)%2==1 then row[#row+1]=50 end if math.floor(mask/32)%2==1 then row[#row+1]=0xff123456 end
 if isBlock then local block=t[#t] if not block or #block>=stride*${v.blockSize||8} then block={} t[#t+1]=block end for k=1,stride do block[#block+1]=row[k] end
 elseif isColumns then for k=1,stride do t[k][i]=row[k] end elseif "${v.layout}"=="flat" then for k=1,stride do t[#t+1]=row[k] end else t[i]=row end end
 local fn=dispatch[mask] fn(t) local instructions=0 debug.sethook(function() instructions=instructions+1 end,"",1) fn(t) debug.sethook()
 local times={} for trial=1,5 do collectgarbage("collect") local start=os.clock() for j=1,300 do fn(t) end times[trial]=(os.clock()-start)*1000 end table.sort(times)
 print(mask..","..instructions..","..string.format("%.5f",times[3]))
end`;
   const file=path.join(dir,'test.lua');fs.writeFileSync(file,code);const r=spawnSync(lua,[file],{encoding:'utf8',timeout:60000});if(r.status!==0)throw Error(r.stdout+r.stderr);
   results.push({name:v.name,bytes:Buffer.byteLength(v.code),cases:r.stdout.trim().split(/\r?\n/).map(line=>{const [mask,instructions,ms]=line.split(',').map(Number);return {mask,instructions,ms};})});
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 return results;
}
if(require.main===module){const results=benchmark();const file=process.argv[2];if(file)fs.writeFileSync(file,JSON.stringify({note:'Lua-only no-op native methods; 2,000 records; 5 timing samples, median of 300 passes. Not game FPS.',results},null,2));for(const r of results){const c=r.cases.find(c=>c.mask===60);console.log(JSON.stringify({name:r.name,bytes:r.bytes,...c}));}}
module.exports={benchmark};

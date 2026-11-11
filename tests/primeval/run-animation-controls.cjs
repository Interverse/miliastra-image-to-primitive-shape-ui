'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs'),{buildPipeline}=require('../../scripts/prepare-animation-pipeline.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'animation-controls-'));
try{
 for(const loop of [true,false]){
  const N=17,frames=Array.from({length:5},(_,f)=>Float64Array.from({length:N*8},(_,i)=>[Math.floor(i/8)%3+1,Math.floor(i/8)*12-100+f,30-f,60+f,50+f,f*10,0xff123456+f*923,(Math.floor(i/8)+f)%N][i%8]));
  const data={width:64,height:32,controls:N,frames,durations:[.07,.01,.1,.03,.08],fps:0,loop},source=Player.buildLegacy(data,{imageTemplateIndex:123,fps:0});
  const variants={fast:Player.build(data,{imageTemplateIndex:123,optimizeOrder:false}),preloaded:buildVariants(source).preloaded,pipeline:buildPipeline(source)};
  for(const [name,code] of Object.entries(variants)){
   const file=path.join(dir,name+'.lua');fs.writeFileSync(file,code);
   for(const method of ['Play','Stop','Restart'])assert.ok(code.includes('function '+method+'()'));
   const run=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),file,file,'controls'],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
  }
 }
 const lua=['lua','texlua'].find(command=>spawnSync(command,['--version'],{encoding:'utf8'}).status===0);assert.ok(lua,'native Lua required');
 const code=Player.build({width:32,height:16,controls:1,frames:[new Float64Array([1,0,0,80,60,0,0xff123456,0]),new Float64Array([1,30,0,80,60,0,0xff654321,0])],durations:[.07,.11],fps:0},{imageTemplateIndex:123});
 const program=require('./animation-standalone-host.cjs')([123])+`
local source=[====[${code}\nfunction Snapshot() return current,clock,ready end]====]
local function instance()
 local target={object={children={}},enabled=false,EnableUpdate=function(self,value) self.enabled=value end}
 local env=setmetatable({script=target},{__index=_G}) assert(load(source,"clip","t",env))()
 function target:Invoke(name) return env[name]() end
 env.OnStart() return env,target
end
local a,sa=instance() local b,sb=instance()
for i=1,10000 do local _,_,ra=a.Snapshot() local _,_,rb=b.Snapshot() if ra and rb then break end if not ra then a.OnUpdate(0) end if not rb then b.OnUpdate(0) end end
sa:Invoke("Stop") a.OnUpdate(.071) b.OnUpdate(.071) assert(a.Snapshot()==1 and b.Snapshot()==2,"one instance stopped another")
sb:Invoke("Restart") assert(a.Snapshot()==1 and b.Snapshot()==1)
sa:Invoke("Play") a.OnUpdate(.071) assert(a.Snapshot()==2 and b.Snapshot()==1)
a.OnDestroy() assert(sb.object.children[1].alive and not sa:Invoke("Play")) b.OnUpdate(.071) assert(b.Snapshot()==2) b.OnDestroy()
for _,node in ipairs(nodes) do assert(not node.alive,"instance leak") end
print("PASS independent Script invocation: stopping/restarting/destroying one player preserves the other")
`;
 const file=path.join(dir,'instances.lua');fs.writeFileSync(file,program);const run=spawnSync(lua,[file],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
}finally{fs.rmSync(dir,{recursive:true,force:true});}

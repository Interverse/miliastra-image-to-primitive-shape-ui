'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict'),{spawnSync}=require('child_process'),host=require('../tests/primeval/animation-standalone-host.cjs');
function compare(files,steps=360){
 const sources=files.map(f=>fs.readFileSync(f,'utf8')),indices=sources.map(s=>Number(s.match(/^local IMAGE_TEMPLATE_INDEX=([^\r\n]+)/m)[1]));
 const factories=sources.map((s,i)=>`local function make${i}(parent) local localEnabled=false local script={object=parent,EnableUpdate=function(self,v) localEnabled=v end} local OnStart,OnUpdate,OnDestroy\n${s}\nreturn {start=OnStart,tick=OnUpdate,destroy=OnDestroy,ready=function()return ready end} end\n`).join('\n');
 const checks=`
local players={} ${sources.map((s,i)=>`players[${i+1}]=make${i}({children={}})`).join(' ')} for _,p in ipairs(players)do p.start()end
for i=1,100000 do local all=true for _,p in ipairs(players)do if not p.ready()then p.tick(0) all=false end end if all then break end end
for _,p in ipairs(players)do assert(p.ready(),"startup stalled")end
local initialCreates,initialColors,initialTweens,initialSequences=creates,colors,tweenCreates,sequenceCreates local initialSiblings=siblings
local peak=0 local instructions=0 local totalBefore=writes+nativeCalls local internalBefore=internalWrites
for i=1,${steps} do local before=writes+nativeCalls local count=0 debug.sethook(function()count=count+100 end,"",100) for _,p in ipairs(players)do p.tick(1/60)end debug.sethook() peak=math.max(peak,writes+nativeCalls-before) instructions=instructions+count end
assert(creates==initialCreates and colors==initialColors and tweenCreates==initialTweens and sequenceCreates==initialSequences and siblings==initialSiblings,"steady allocation")
print("PASS independent scripts: instances=${sources.length}, controls="..creates..", cached tweens="..tweenCreates..", cached sequences="..sequenceCreates..", peak Lua/native submissions="..peak..", total submissions="..(writes+nativeCalls-totalBefore)..", total Lua instructions="..instructions..", internal endpoint writes="..(internalWrites-internalBefore))
for _,p in ipairs(players)do p.destroy()end assert(liveTweens==0 and liveSequences==0,"native cache leak") for _,c in ipairs(nodes)do assert(not c.alive,"UI leak")end
`;
 const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});if(!lua)throw Error('Native Lua unavailable');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'standalone-instances-'));try{const file=path.join(tmp,'run.lua');fs.writeFileSync(file,host(indices)+fs.readFileSync(path.join(__dirname,'lua/animation-native-mock.lua'),'utf8')+factories+checks);const result=spawnSync(lua,[file],{encoding:'utf8',maxBuffer:2*1024*1024});assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
if(require.main===module)process.stdout.write(compare(process.argv.slice(2)));
module.exports={compare};

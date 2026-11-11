'use strict';
// Trusted local exports only. Timing includes the emulated API, never game FPS.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const host=require('../tests/primeval/animation-standalone-host.cjs'),{extract}=require('./upgrade-animation-player.cjs');
function compare(files,{steps=1200,trials=7}={}){
 const sources=files.map(f=>fs.readFileSync(f,'utf8').replace('local AUTO_NATIVE_UPDATES=true','local AUTO_NATIVE_UPDATES=false').replace(/^local NATIVE_TRANSACTION_MODE=.*$/m,'local NATIVE_TRANSACTION_MODE=0')),metas=sources.map(extract);
 for(const m of metas)for(const key of ['DATA','WIDTH,W,H,N','GEOMETRY,ROTATION,COMPACT','durations','PLAYBACK_FPS','ENCODED_FPS'])if(m.lines[key]!==metas[0].lines[key])throw Error('Timing comparison requires identical payload/settings: '+key);
 const factories=sources.map((s,i)=>`local function make${i}() local own={children={}} local isEnabled=false local script={object=own,EnableUpdate=function(self,v)isEnabled=v end} local print=function()end local OnStart,OnUpdate,OnDestroy\n${s}\nreturn {start=OnStart,tick=OnUpdate,destroy=OnDestroy,ready=function()return ready end} end`).join('\n');
 const code=host(metas.map(m=>m.templateIndex))+factories+`
local players={${sources.map((_,i)=>'make'+i+'()').join(',')}} local times={} local submissions={} local baselineCreates,baselineColors
for index,p in ipairs(players)do p.start() for i=1,100000 do if p.ready()then break end p.tick(0) end assert(p.ready()) times[index]={} for i=1,600 do p.tick(1/60) end end
baselineCreates=creates baselineColors=colors
for trial=1,${trials} do for order=1,#players do local index=(trial+order-2)%#players+1 local p=players[index] collectgarbage("collect") local before=writes local start=os.clock() for i=1,${steps} do p.tick(1/60) end times[index][trial]=(os.clock()-start)*1000 local used=writes-before if order==1 then submissions[trial]=used else assert(used==submissions[trial],"unequal native submissions") end end end
assert(creates==baselineCreates and colors==baselineColors,"steady allocations")
for index,samples in ipairs(times)do table.sort(samples) print(index..","..samples[1]..","..samples[math.floor(#samples/2)+1]..","..samples[#samples]) end
for _,p in ipairs(players)do p.destroy()end for _,c in ipairs(nodes)do assert(not c.alive)end
`;
 const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});if(!lua)throw Error('Lua unavailable');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lua-runtime-time-'));try{const file=path.join(dir,'test.lua');fs.writeFileSync(file,code);const r=spawnSync(lua,[file],{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});if(r.status!==0)throw Error(r.stdout+r.stderr);return {note:`Same payload; ${trials} rotating-order trials; median CPU time for ${steps} updates after warmup, including fake API. Not game FPS.`,steps,trials,results:r.stdout.trim().split(/\r?\n/).map(line=>{const [i,minMs,medianMs,maxMs]=line.split(',').map(Number);return {file:path.basename(files[i-1]),minMs,medianMs,maxMs};})};}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
if(require.main===module){const [output,...files]=process.argv.slice(2);if(!output||files.length<2)throw Error('Usage: <report.json> <baseline.lua> <candidate.lua> [...]');const report=compare(files);fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
module.exports={compare};

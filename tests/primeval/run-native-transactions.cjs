'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs'),{decode,expand}=require('../../scripts/animation-payload.cjs');
const host=require('./animation-standalone-host.cjs');
const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});if(!lua)throw Error('Native Lua required');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-transaction-'));
try{
 const N=17,frames=Array.from({length:5},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [(id+f)%3+1,id*13-110+f*5,id*3-20-f*2,40+f*2,30+f,f*71+id,0xff123456+id*123+f*1001,id][i%8];}));
 const source=Player.buildLegacy({width:64,height:32,controls:N,frames,durations:[.07,.08,.01,.11,.07],fps:15},{imageTemplateIndex:123}),normal=buildVariants(source).fast,code=buildVariants(source,{nativeTransactions:true}).fast;
 assert.ok(!normal.includes('calibration started')&&!normal.includes('local AUTO_NATIVE_UPDATES='),'normal exports must omit live calibration');
 const decoded=decode(code),scale=decoded.meta.dimensions[0]/64*.1,expected=decoded.frames.map(frame=>{const state=expand(frame,decoded.meta.compact),out=Array(N*8).fill(0);for(let id=0;id<N;id++)for(let k=0;k<8;k++)out[state[id*8+7]*8+k]=state[id*8+k];return out;});
 const oracle=`
local expected={${expected.map(f=>'{'+f.join(',')+'}').join(',')}}
local function verifyPose(f)
 local state=expected[f] local root=nodes[1] assert(root.active and root.visible,"image left suspended") assert((root.sx or 1)==1 and (root.sy or 1)==1,"image left collapsed")
 local assets={100002,100001,100003}
 for id=1,${N} do local c=root.children[id] local a=(id-1)*8 assert(c.visible and c.asset==assets[state[a+1]],"image") assert(math.abs(c.x-state[a+2]*${scale})<.00001 and math.abs(c.y-state[a+3]*${scale})<.00001,"position") assert(math.abs(c.w*(c.sx or 1)-state[a+4]*${scale})<.00001 and math.abs(c.h*(c.sy or 1)-state[a+5]*${scale})<.00001,"size") assert(math.abs(c.r-state[a+6]*.1)<.00001 and c.imageColor==state[a+7],"rotation/color") end
end
OnStart() for i=1,10000 do if ready then break end OnUpdate(0) end assert(ready) verifyPose(current)
`;
 function run(name,player,setup,checks,{bound=false,watch=false}={}){
  let prefix=host([123],bound);if(watch)prefix=prefix.replace('if k=="imageColor" then t.properties[k]=v','if k=="imageColor" then watchWrite(t) t.properties[k]=v');
  const script='local monitor=false local expectedMode=0 local observations=0 local inject=false\n'+prefix+`
function watchWrite(c)
 if monitor and c~=nodes[1] then observations=observations+1 local r=nodes[1]
  if expectedMode==1 then assert(not r.active,"write escaped inactive transaction") elseif expectedMode==2 then assert(not r.visible,"write escaped hidden transaction") else assert(r.sx==0 and r.sy==0,"write escaped collapsed transaction") end
 end
end
${watch?`for _,name in ipairs({"SetImage","SetVisible","SetAnchoredPosition","SetSizeDelta","SetLocalScale","SetLocalRotation"})do local fn=Control[name] Control[name]=function(c,...)watchWrite(c) if inject and c~=nodes[1] then inject=false error("injected setter failure")end return fn(c,...)end end`:''}
${setup||''}
${player}
${oracle}
${checks}
OnDestroy() assert(not enabled) for _,c in ipairs(nodes)do assert(not c.alive,"leaked native control")end assert(not nativeTuning and not transactionSetter and not nativeSetters,"retained policy resources")
print("PASS ${name}")`;
  const file=path.join(dir,'test.lua');fs.writeFileSync(file,script);const r=spawnSync(lua,[file],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(r.status,0,name+'\n'+r.stdout+r.stderr);console.log('PASS '+name);
 }
 for(const mode of [1,2,3])for(const bound of [false,true]){
  const player=code.replace('local AUTO_NATIVE_UPDATES=true','local AUTO_NATIVE_UPDATES=false').replace('local NATIVE_TRANSACTION_MODE=0','local NATIVE_TRANSACTION_MODE='+mode);
  run('native mode '+mode+' bound='+bound,player,'',`
assert(NATIVE_TRANSACTION_MODE==${mode} and transactionSetter,"probe must pass") expectedMode=${mode} monitor=true
for i=1,90 do OnUpdate(1/60) verifyPose(current)end assert(observations>0) local before=creates
inject=true local ok=pcall(OnUpdate,.09) assert(not ok,"setter fault not triggered") assert(nodes[1].active and nodes[1].visible and nodes[1].sx==1 and nodes[1].sy==1,"exception stranded image")
OnUpdate(0) verifyPose(current) assert(creates==before,"playback created controls") monitor=false
`,{bound,watch:true});
 }
 run('normal playback never toggles root across 60 seconds and repeated loops',normal,`
local rootWrites=0
for _,name in ipairs({"SetActive","SetVisible","SetLocalScale"})do local fn=Control[name] Control[name]=function(c,...)if monitor and c==nodes[1]then rootWrites=rootWrites+1 error("normal playback touched image root")end return fn(c,...)end end
`, `monitor=true local seen={} for i=1,3600 do OnUpdate(1/60) seen[current]=true if i%60==0 then verifyPose(current)end end assert(rootWrites==0) for i=1,#ends do assert(seen[i],"frame was never displayed")end monitor=false`);
 const auto=code.replace('local AUTO_NATIVE_UPDATES=false','local AUTO_NATIVE_UPDATES=true').replace('local NATIVE_TEST_SECONDS=6','local NATIVE_TEST_SECONDS=.1');
 run('native policy selects and verifies faster mode',auto,'',`
local original=untunedTick for i=1,1000 do if not nativeTuning then break end local fps=NATIVE_TRANSACTION_MODE==3 and 60 or (NATIVE_TRANSACTION_MODE==1 and 35 or 48) OnUpdate(1/fps) verifyPose(current) end
assert(not nativeTuning and NATIVE_TRANSACTION_MODE==3,"did not select faster native strategy") assert(variantTick==original,"tuning wrapper not removed")
`);
 run('native policy rejects equal FPS',auto,'',`for i=1,1000 do if not nativeTuning then break end OnUpdate(1/48) verifyPose(current)end assert(not nativeTuning and NATIVE_TRANSACTION_MODE==0)`);
 run('native policy rejects scene-change false positive',auto,'',`
for i=1,1000 do if not nativeTuning then break end local fps if nativePhase>#nativeModes then fps=60 else fps=NATIVE_TRANSACTION_MODE==2 and 60 or 48 end OnUpdate(1/fps) verifyPose(current)end assert(not nativeTuning and NATIVE_TRANSACTION_MODE==0,"unverified improvement retained")
`);
 run('native policy aborts after long frame',auto,'',`OnUpdate(.4) verifyPose(current) assert(not nativeTuning and NATIVE_TRANSACTION_MODE==0)`);
 run('native policy cleanup during calibration',auto,'',`assert(nativeTuning) OnUpdate(1/60) verifyPose(current)`);
 run('nonloop playback bypasses calibration and finishes normally',auto.replace('local LOOP=true','local LOOP=false'),'',`assert(not nativeTuning and not AUTO_NATIVE_UPDATES) OnUpdate(2) verifyPose(current) assert(not enabled)`);
 const manual=code.replace('local AUTO_NATIVE_UPDATES=true','local AUTO_NATIVE_UPDATES=false').replace('local NATIVE_TRANSACTION_MODE=0','local NATIVE_TRANSACTION_MODE=1');
 run('unsupported getter falls back to direct',manual,'Control.GetLocalScale=nil',`assert(NATIVE_TRANSACTION_MODE==0) for i=1,60 do OnUpdate(1/60) verifyPose(current)end`);
 run('reactivation-reset probe repairs every control and falls back',manual,`
local old=Control.SetActive Control.SetActive=function(c,v) old(c,v) if v and c==nodes[1] then for _,child in ipairs(c.children)do child.x=999 child.w=123 end end end
`, `assert(NATIVE_TRANSACTION_MODE==0,"invalid reactivation binding accepted") for i=1,60 do OnUpdate(1/60) verifyPose(current)end`);
 console.log('Native policy timing tests use injected frame times to test selection logic; they do not predict game FPS.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}

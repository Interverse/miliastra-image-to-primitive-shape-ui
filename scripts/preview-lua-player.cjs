/* Offline visual conformance test. Executes saved Lua, not a JS player rewrite. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {extract}=require('./upgrade-animation-player.cjs');
const {decode,expand}=require('./animation-payload.cjs');
const host=require('../tests/primeval/animation-standalone-host.cjs');
function literal(s){let eq='=';while(s.includes(']'+eq+']'))eq+='=';return '['+eq+'['+s+']'+eq+']';}
function expectedFrame(frame,meta,preloaded){
 const [width,w,h,N]=meta.dimensions,scale=width/w*.1,slots=[];let dense=0;
 for(let id=0;id<N;id++){
  const a=id*8,kind=frame[a],x=frame[a+1]*.1,y=frame[a+2]*.1;
  if(!kind||Math.floor(frame[a+6]/16777216)===0||frame[a+3]===0||frame[a+4]===0)continue;
  const co=Math.abs(Math.cos(frame[a+5]*Math.PI/1800)),si=Math.abs(Math.sin(frame[a+5]*Math.PI/1800));
  const rx=(frame[a+3]*co+frame[a+4]*si)*.05,ry=(frame[a+3]*si+frame[a+4]*co)*.05;
  if(x+rx < -w/2-2||x-rx>w/2+2||y+ry < -h/2-2||y-ry>h/2+2)continue;
  slots.push([frame[a+7]+1,[100002,100001,100003,106057][kind-1],frame[a+1]*scale,frame[a+2]*scale,frame[a+3]*scale,frame[a+4]*scale,frame[a+5]*.1,frame[a+6]]);
 }
 slots.sort((a,b)=>a[0]-b[0]);if(preloaded)for(const s of slots)s[0]=++dense;return slots;
}
function differences(actual,expected){
 const found=new Map(actual.map(s=>[s[0],s])),errors=[];
 for(const e of expected){const a=found.get(e[0]);found.delete(e[0]);if(!a){errors.push({slot:e[0],field:'missing'});continue;}
  for(let k=1;k<8;k++){const delta=k===6?Math.abs(((a[k]-e[k])%360+540)%360-180):Math.abs(a[k]-e[k]);if(delta>1e-5)errors.push({slot:e[0],field:['slot','asset','x','y','width','height','rotation','color'][k],actual:a[k],expected:e[k]});}
 }
 for(const slot of found.keys())errors.push({slot,field:'unexpected visible shape'});return errors;
}
function capture(source,{fault=false}={}){
 if(Buffer.byteLength(source)>8*1024*1024)throw Error('Input exceeds 8 MiB test limit');
 const meta=extract(source),N=meta.dimensions[3];
 if(N>10000||meta.durations.length>500||N*meta.durations.length>500000)throw Error('Mock resource limit: 10,000 shapes / 500 frames / 500,000 shape-frames');
 const decoded=decode(source),preloaded=source.includes('local VARIANT="preloaded"');
 const expected=decoded.frames.map(f=>expectedFrame(expand(f,meta.compact),meta,preloaded));
 const lua=['lua','texlua'].find(c=>{const p=spawnSync(c,['--version'],{encoding:'utf8'});return !p.error&&p.status===0;});if(!lua)throw Error('Install Lua 5.3+ (lua or texlua must be on PATH)');
 const instrumentation='\nreturn {start=OnStart,update=OnUpdate,destroy=OnDestroy,ready=function() return ready end,current=function() return current end,clock=function() return clock end}';
 const native=fs.readFileSync(path.join(__dirname,'lua/animation-native-mock.lua'),'utf8');
 const program=host([meta.templateIndex])+`\nlocal BOUND_SEQUENCE_METHODS=false\n`+native+`
 -- Trusted host code stays outside the loaded script's restricted environment.
 local instantiate=game.InstantiateClientUIControl
 game.InstantiateClientUIControl=function(...) assert(creates<500001,"mock control limit") return instantiate(...) end
 local makeTween=game.Tween
 game.Tween=function(...) assert(tweenCreates<500001,"mock Tween limit") return makeTween(...) end
 local env={math={},string={},table={},game=game,Enum=Enum,Color=Color,script=script,
  assert=assert,error=error,pcall=pcall,ipairs=ipairs,pairs=pairs,next=next,select=select,tonumber=tonumber,tostring=tostring,type=type,
  print=function() end}
 for k,v in pairs(math) do env.math[k]=v end for k,v in pairs(string) do env.string[k]=v end for k,v in pairs(table) do env.table[k]=v end
 local chunk=assert(load(${literal(source+instrumentation)},"@saved-animation.lua","t",env))
 local function limited(fn,...)
  local used=0 debug.sethook(function() used=used+1000 if used>5000000 then error("mock callback instruction limit",0) end end,"",1000)
  local result=table.pack(pcall(fn,...)) debug.sethook() assert(used<=5000000,"mock callback instruction limit") assert(result[1],result[2]) return table.unpack(result,2,result.n)
 end
 local api=limited(chunk) assert(type(api.start)=="function" and type(api.update)=="function","Missing animation callbacks")
 local function emit()
  io.write('{"frame":',api.current(),',"clock":',api.clock() or 0,',"writes":',writes,',"nativeCalls":',nativeCalls,',"shapes":[')
  local first=true
  local function visit(parent)
   for index,c in ipairs(parent.children) do if c.alive and c.active~=false and c.visible~=false then
    if c.asset and c~=nodes[1] and math.floor((c.imageColor or 4294967295)/16777216)>0 then
     if not first then io.write(',') end first=false
     io.write(string.format('[%d,%d,%.12g,%.12g,%.12g,%.12g,%.12g,%.0f]',index,c.asset,c.x or 0,c.y or 0,(c.w or 0)*(c.sx or 1),(c.h or 0)*(c.sy or 1),c.r or 0,c.imageColor or 4294967295))
    end visit(c)
   end end
  end visit(world) io.write(']}\\n')
 end
 limited(api.start) local startup=0 local firstVisible=0
 while not api.ready() do startup=startup+1 assert(startup<200000,"startup stalled") limited(api.update,0) if firstVisible==0 and nodes[1] and nodes[1].visible then firstVisible=startup end end
 -- Deliberately corrupt the observed pose in negative-control mode.
 local inject=${fault?'true':'false'}
 local function snapshot() if inject and nodes[2] then nodes[2].x=(nodes[2].x or 0)+7 end emit() end
 local function advance(dt)
  if enabled then limited(api.update,dt) end
  io.write('{"tick":',dt,',"frame":',api.current(),'}\\n')
 end
 snapshot()
 local durations={${meta.durations.map(n=>n/1e6).join(',')}}
 -- Visit each frame explicitly, then exercise ordinary 60 Hz, loops and long stalls.
 for i=1,#durations-1 do advance(durations[i]+0.000000001) snapshot() end
 for i=1,math.ceil(${meta.durations.reduce((a,b)=>a+b,0)/1e6}*120) do
  local previous=api.current() advance(1/60) if api.current()~=previous then snapshot() end
 end
 for _,dt in ipairs({.001,.3,2,5.231,10000.125,.04}) do advance(dt) snapshot() end
 limited(api.destroy) assert(not enabled,"updates enabled after destroy")
 for _,c in ipairs(nodes) do assert(not c.alive,"leaked UI control") end
 assert(liveTweens==0 and liveSequences==0,"leaked Tween cache") limited(api.destroy)
 io.write('{"summary":true,"controls":',creates,',"tweens":',tweenCreates,',"sequences":',sequenceCreates,',"startupCallbacks":',startup,',"firstVisibleCallback":',firstVisible,'}\\n')
 `;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lua-visual-'));
 let output;try{const file=path.join(dir,'host.lua');fs.writeFileSync(file,program);const run=spawnSync(lua,[file],{encoding:'utf8',timeout:60000,maxBuffer:128*1024*1024});if(run.error)throw run.error;if(run.status!==0)throw Error(run.stdout.slice(-500)+run.stderr);output=run.stdout;}finally{fs.rmSync(dir,{recursive:true,force:true});}
 const records=output.trim().split(/\r?\n/).map(s=>JSON.parse(s)),summary=records.pop();
 const poses=[],poseIds=new Map(),timeline=[];let mismatchCount=0;const mismatches=[];
 const frozen=Number(source.match(/^local FREEZE_FRAME=(\d+)/m)?.[1]||0),loop=meta.lines.LOOP.trim()==='true',fps=Number(meta.lines.PLAYBACK_FPS.split('--')[0]),encodedFPS=Number(meta.lines.ENCODED_FPS.split('--')[0]),total=meta.durations.reduce((a,b)=>a+b,0);
 let expectedIndex=frozen>0?Math.min(meta.durations.length,Math.max(1,frozen)):1,simClock=0,displayClock=0,timingChecks=0;
 for(const r of records){
  if(r.tick!==undefined){
   timingChecks++;
   if(!frozen&&meta.durations.length>1){simClock+=Math.max(0,r.tick)*1e6;displayClock+=Math.max(0,r.tick);if(!loop)simClock=Math.min(simClock,total-.001);
    const limited=fps>0&&fps!==encodedFPS;
    if(!limited||displayClock>=1/fps||(!loop&&simClock>=total-.001)){
     const phase=loop?simClock%total:simClock;let sum=0,target=1;while(target<meta.durations.length){sum+=meta.durations[target-1];if(phase<sum)break;target++;}
     if(target!==expectedIndex){expectedIndex=target;displayClock=limited?displayClock%(1/fps):0;}
    }
   }
   if(r.frame!==expectedIndex){mismatchCount++;if(mismatches.length<100)mismatches.push({tick:timingChecks,field:'timeline',actual:r.frame,expected:expectedIndex});}continue;
  }
  const errors=differences(r.shapes,expected[expectedIndex-1]);mismatchCount+=errors.length;if(errors.length&&mismatches.length<100)mismatches.push({sample:timeline.length,frame:r.frame,...errors[0]});
  const key=JSON.stringify(r.shapes);let pose=poseIds.get(key);if(pose===undefined){pose=poses.length;poses.push(r.shapes);poseIds.set(key,pose);}timeline.push({...r,expectedFrame:expectedIndex,shapes:undefined,pose,errors:errors.length+(r.frame!==expectedIndex?1:0)});
 }
 summary.timingChecks=timingChecks;
 return {name:'Saved animation',mode:source.match(/^local VARIANT="([a-z]+)"/m)?.[1]||'buffered',width:meta.dimensions[0],height:meta.dimensions[0]*meta.dimensions[2]/meta.dimensions[1],durations:meta.durations,expected,poses,timeline,mismatches,mismatchCount,summary,native:source.includes('local NATIVE_BATCH=true'),fault};
}
function html(report){return fs.readFileSync(path.join(__dirname,'lua/preview-player.html'),'utf8').replace('/* REPORT_DATA */',JSON.stringify(report).replace(/</g,'\\u003c'));}
if(require.main===module){
 const [input,output,...options]=process.argv.slice(2);if(!input||!output||!output.endsWith('.html'))throw Error('Usage: node scripts/preview-lua-player.cjs input.lua output.html [--inject-fault]');
 if(path.resolve(input)===path.resolve(output))throw Error('Preserve the input Lua file');
 const report=capture(fs.readFileSync(input,'utf8'),{fault:options.includes('--inject-fault')});report.name=path.basename(input);fs.writeFileSync(output,html(report));
 console.log(JSON.stringify({output:path.resolve(output),samples:report.timeline.length,mismatches:report.mismatchCount,...report.summary}));if(report.mismatchCount)process.exitCode=1;
}
module.exports={capture,html,differences};

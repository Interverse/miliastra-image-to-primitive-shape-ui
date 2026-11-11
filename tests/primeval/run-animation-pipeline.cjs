'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),{buildPipeline}=require('../../scripts/prepare-animation-pipeline.cjs'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs');
const {capture}=require('../../scripts/preview-lua-player.cjs'),verify=require('../../scripts/verify-animation-order.cjs').verify;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pipeline-test-'));
function run(input,output,profile,extra={}){const r=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,output,profile],{encoding:'utf8',maxBuffer:2*1024*1024,env:{...process.env,...extra}});assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
try{
 for(const count of [1,2]){
  const frame=new Float64Array([2,0,0,120,80,0,0xffabcdef,0]);
  const source=Player.buildLegacy({width:64,height:32,controls:1,frames:Array.from({length:count},()=>frame.slice()),durations:Array(count).fill(.07),fps:15},{imageTemplateIndex:123});
  assert.equal(capture(buildPipeline(source)).mismatchCount,0,'static and two-frame identical clips');
 }
 for(const compact of [false,true])for(const frameCount of [5,6]){
  const N=13,frames=Array.from({length:frameCount},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [id===f?0:id%3+1,id===10?10000:id*23-120+f*4,id*11-60-f*2,20+f*3,30-f,f*127+id*31,(id===9?0:0x80000000)+((id*7919+f*997)%0x1000000),(id+f*3)%N][i%8];}));frames[1]=frames[0].slice();
  const source=Player.buildLegacy({width:64,height:32,controls:N,frames,durations:[.07,.01,.11,.025,.065,.05].slice(0,frameCount),fps:15},{imageTemplateIndex:123,width:137.5,compact}),pipeline=buildPipeline(source),input=path.join(dir,'input.lua'),output=path.join(dir,'pipeline.lua');fs.writeFileSync(input,source);fs.writeFileSync(output,pipeline);verify(source,pipeline);
  assert.equal(capture(pipeline).mismatchCount,0);
  for(const profile of ['steady','jitter','hitch','slow','seek','cancel'])run(input,output,profile,{BIND_METHODS:'1'});
  for(const code of [pipeline.replace('local TRANSFORM_GEOMETRY=true','local TRANSFORM_GEOMETRY=false'),pipeline.replace('local FREEZE_FRAME=0','local FREEZE_FRAME=2'),pipeline.replace(/^local LOOP=true/m,'local LOOP=false'),pipeline.replace(/^local PLAYBACK_FPS=.*$/m,'local PLAYBACK_FPS=4')])assert.equal(capture(code).mismatchCount,0);
  console.log(`PASS pipeline: compact=${compact}, ${frameCount} frames, shared/bound methods, all fields, short frames, skips, frozen/nonloop/FPS cap, cancellation`);
 }
 const N=2000,frames=Array.from({length:5},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [id%3+1,(id*17+f*3)%500-250,(id*11+f*5)%240-120,10+(id+f)%20,10+(id*3+f)%20,(id*13+f)%3600-1800,0xff000000+((id*7919+f*997)%0x1000000),id][i%8];}));
 const source=Player.buildLegacy({width:64,height:32,controls:N,frames,durations:[.07,.07,.07,.07,.01],fps:15},{imageTemplateIndex:123}),input=path.join(dir,'dense-input.lua'),direct=path.join(dir,'direct.lua'),pipeline=path.join(dir,'dense-pipeline.lua');fs.writeFileSync(input,source);fs.writeFileSync(direct,buildVariants(source).fast);fs.writeFileSync(pipeline,buildPipeline(source));
 const directResult=run(input,direct,'steady'),pipelineResult=run(input,pipeline,'steady');process.stdout.write(directResult+pipelineResult);
 const peak=s=>Number(s.match(/peak Lua\/native submissions=(\d+)/)[1]);assert.ok(peak(pipelineResult)<peak(directResult)*.7,'rolling lookahead must reduce peak submissions for this 2,000-shape fixture');
 const compare=require('../../scripts/benchmark-standalone-instances.cjs').compare;process.stdout.write(compare([pipeline,pipeline],180));
 console.log('PASS 2,000-shape rolling pools: lower peak work, exact parity and independent instance cleanup');
}finally{fs.rmSync(dir,{recursive:true,force:true});}

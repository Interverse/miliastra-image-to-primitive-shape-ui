'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs'),{buildPipeline}=require('../../scripts/prepare-animation-pipeline.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'startup-test-'));
function run(input,code){const file=path.join(dir,'player.lua');fs.writeFileSync(file,code);const r=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,file,'steady'],{encoding:'utf8',maxBuffer:2*1024*1024});assert.equal(r.status,0,r.stdout+r.stderr);const stats=r.stdout.match(/PASS startup: callbacks=(\d+), first visible=(\d+).*peak controls created\/update=(\d+), peak colors created\/update=(\d+), Lua instructions=(\d+)/);assert.ok(stats,r.stdout);const [callbacks,first,spawns,colors,instructions]=stats.slice(1).map(Number);return {callbacks,first,spawns,colors,instructions};}
try{
 const N=2000,frames=Array.from({length:8},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [id%3+1,(id%80)*28-1100+f,Math.floor(id/80)*28-350-f,20+f,20+f*2,id%180+f*11,0xff000000+(id*7919+f*991)%0x1000000,id][i%8];}));
 const source=Player.buildLegacy({width:256,height:128,controls:N,frames,durations:Array(8).fill(.067),fps:15},{imageTemplateIndex:123}),input=path.join(dir,'source.lua');fs.writeFileSync(input,source);
 const direct=buildVariants(source).fast;
 // Same decoded data and optimized codec; isolate old scheduling and late visibility.
 const baseline=direct.replace('local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=6144,128,256','local LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=2048,20,32').replace('local SCAN_BATCH,COMPILE_BATCH,COLOR_BATCH=1024,2048,512','local SCAN_BATCH,COMPILE_BATCH,COLOR_BATCH=512,128,512')+'\nvariantPreview=nil\n';
 const before=run(input,baseline),fast=run(input,direct),pipeline=run(input,buildPipeline(source));
 for(const stats of [fast,pipeline]){assert.ok(stats.callbacks<before.callbacks*.5,JSON.stringify({before,stats}));assert.ok(stats.first<before.first*.15);assert.ok(stats.first<stats.callbacks,'first image appears before all frames are ready');assert.ok(stats.spawns<=128);assert.ok(stats.colors<=513);}
 console.log('PASS 2,000-control startup: exact preview during decode, faster full readiness, bounded constructors/instructions, unchanged playback and cleanup\n'+JSON.stringify({baseline:before,fast,pipeline}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}

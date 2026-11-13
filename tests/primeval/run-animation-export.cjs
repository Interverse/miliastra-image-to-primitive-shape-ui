'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),Payload=require('../../scripts/animation-payload.cjs'),Order=require('../../js/animation-order.js'),{verify}=require('../../scripts/verify-animation-order.cjs');
const N=128,F=54,frames=Array.from({length:F},(_,f)=>Float64Array.from({length:N*8},(_,at)=>{
 const id=Math.floor(at/8);return [id%3+1,(id%16)*280-2100+f,Math.floor(id/16)*280-980,40,40,f*3,0xff000000+(id*7919+f*997)%0x1000000,(id+f)%N][at%8];
}));
const animation={width:480,height:240,controls:N,frames,durations:Array.from({length:F},(_,i)=>i%5===0?.01:.04),fps:0};
const original=Player.build(animation,{imageTemplateIndex:123,optimizeOrder:false,compression:'maximum'}),updated=Player.build(animation,{imageTemplateIndex:123});
assert.ok(original.includes('local CODEC=2'),'fixture reproduces the slow decoder');
assert.ok(updated.includes('local CODEC=1'),'website uses the fast-loading codec');
assert.ok(!updated.includes('Invalid predictor'),'unused arithmetic decoder is absent');
const planning=JSON.parse(updated.match(/-- Export planning: (.*)/)[1]);
assert.ok(planning.changed&&planning.after.images<planning.before.images*.25,'substantially fewer native sprite replacements');
assert.ok(planning.after.writes<=planning.before.writes&&planning.after.runs<=planning.before.runs,'native submissions and material runs cannot regress');
verify(original,updated);
assert.equal(Payload.decode(updated).frames.length,F,'all source frames survive');
assert.deepEqual(Order.plan(frames,{dimensions:[480,480,240,N]},{maxCells:0}).frames,frames,'large-export fallback preserves every fitted value');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'animation-export-'));
try{
 const input=path.join(dir,'before.lua'),output=path.join(dir,'after.lua');fs.writeFileSync(input,original);fs.writeFileSync(output,updated);
 function run(file,profile){const p=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,file,profile],{encoding:'utf8',maxBuffer:2*1024*1024});assert.equal(p.status,0,p.stdout+p.stderr);return p.stdout;}
 const before=run(input,'steady'),after=run(output,'steady');
 const callbacks=s=>Number(s.match(/PASS startup: callbacks=(\d+)/)[1]);
 assert.ok(callbacks(after)<callbacks(before)*.25,JSON.stringify({before:callbacks(before),after:callbacks(after)}));
 for(const profile of ['seek','cancel'])run(output,profile);
 const upgraded=path.join(dir,'upgraded.lua');fs.writeFileSync(upgraded,require('../../scripts/upgrade-animation-player.cjs').upgrade(original).code);run(upgraded,'seek');
 console.log('PASS website startup and lossless material planning: '+JSON.stringify({callbacksBefore:callbacks(before),callbacksAfter:callbacks(after),...planning}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
{
 // LOAD_SPEED scales the work each game update spends loading; playback stays exact.
 const {capture}=require('../../scripts/preview-lua-player.cjs');
 const small={...animation,controls:20,frames:frames.map((frame,f)=>frame.slice(0,20*8).map((v,i)=>i%8===7?(Math.floor(i/8)+f)%20:v))};
 assert.ok(Player.build(small,{imageTemplateIndex:123}).includes('local LOAD_SPEED=1 '),'header exposes LOAD_SPEED');
 assert.throws(()=>Player.build(small,{loadSpeed:0}),/animation.limit/);
 const startup=Object.fromEntries([0.5,1,2].map(speed=>{const r=capture(Player.build(small,{imageTemplateIndex:123,loadSpeed:speed}));assert.equal(r.mismatchCount,0,'speed '+speed);return [speed,r.summary?.startupCallbacks??r.startupCallbacks];}));
 assert.ok(startup[2]<startup[1]&&startup[1]<startup[0.5]&&startup[1]<=12,JSON.stringify(startup));
 console.log('PASS LOAD_SPEED startup updates: '+JSON.stringify(startup));
}

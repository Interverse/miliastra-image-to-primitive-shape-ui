'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),Codec=require('../../js/animation-codec.js'),Payload=require('../../scripts/animation-payload.cjs');
assert.equal(fs.readFileSync(path.resolve(__dirname,'../../js/animation-player-runtime.js'),'utf8'),require('../../scripts/build-animation-player.cjs').source(),'browser player must match its canonical Lua and kernels');
let seed=123;function random(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}
const N=2000,frames=Array.from({length:6},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{
 const id=Math.floor(i/8);return [id%3+1,(id%40)*14-280+f*3,Math.floor(id/40)*10-250-f,20+f,30+f*2,id%120+f*4,0xff000000+((id*7919+f*991)%0x1000000),(id+f)%N][i%8];
}));
const animation={width:64,height:64,controls:N,frames,durations:[.07,.01,.11,.025,.065,.05],fps:15};
for(const data of [animation,{...animation,frames:Array(4).fill(new Float64Array(N*8)),durations:Array(4).fill(.05)},
 {controls:71,frames:Array.from({length:23},()=>Float64Array.from({length:71*8},(_,i)=>i%8===6?random(0xffffffff):random(100000)-50000))}]){
 for(const transform of [false,true])assert.deepEqual(Codec.decode(Codec.encode(data,{transform}),data.controls,data.frames.length,{transform}),data.frames,'bit-exact signed geometry, unsigned colors, predictors and runs');
}
const compressed=Codec.encode(animation);assert.ok(compressed.length<Player.encode(animation).text.length*.65,'smooth motion compresses substantially better than first-order Huffman');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'animation-codec-'));
try{
 for(const compact of [false,true]){
  const code=Player.build(animation,{imageTemplateIndex:123,width:137.5,compact,optimizeOrder:false,compression:'maximum'}),file=path.join(dir,'player.lua');fs.writeFileSync(file,code);
  assert.ok(code.includes('local CODEC=2'));assert.ok(!code.includes('calibration started'));assert.ok(!code.includes('game.Tween'));
  const expected=compact?Player.compactAnimation(animation).frames:frames,decoded=Payload.decode(code).frames;
  assert.ok(decoded.every((frame,f)=>frame.every((v,i)=>v===expected[f][i])),'saved Lua data matches selected precision exactly');
  for(const profile of compact?['steady']:['steady','seek','cancel','vm']){
   const run=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),file,file,profile],{encoding:'utf8',maxBuffer:2*1024*1024});
   assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
  }
 }
 const still={width:64,height:64,controls:2,frames:[new Float64Array([1,1,2,5,5,1,0xffffffff,0,1,1,2,5,5,1,0xffffffff,1])],durations:[.1]};
 const code=Player.build(still,{imageTemplateIndex:123}),file=path.join(dir,'still.lua');fs.writeFileSync(file,code);assert.ok(code.includes('local CODEC=1'),'small clips use the smaller Huffman variant');
 const run=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),file,file,'steady'],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);
 assert.deepEqual(Payload.decode(Payload.asHuffman(Player.build(animation,{imageTemplateIndex:123,optimizeOrder:false,compression:'maximum'}))).frames,frames,'research players can consume new browser exports without changing fitted values');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.throws(()=>Player.build({...animation,durations:[NaN]}),/animation.limit/);
assert.equal(Player.minify('local a="--not a comment" -- comment\nreturn a'), 'local a="--not a comment"return a');
console.log('PASS predictive lossless codec, native Lua parity/budgets/cancellation, minification and generated browser runtime');

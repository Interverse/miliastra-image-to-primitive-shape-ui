'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../js/importance-analysis.js'),'utf8');
  const {normalizeAttention,cropAttention}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  assert.equal(normalizeAttention([1,1],2,1,[255,255]),null);
  assert.equal(normalizeAttention([0,1],2,1,[0,0]),null);
  assert.throws(()=>normalizeAttention([0,NaN],2,1,[255,255]));
  assert.throws(()=>normalizeAttention([0,1],3,1,[255,255]));
  const map=normalizeAttention([0,.25,.5,.75,1],5,1,[255,255,255,255,0]);
  assert.equal(map.values[0],0);assert.equal(map.values[1],.5);assert.equal(map.values[3],1);
  // The range comes from visible pixels; a transparent pixel keeps its (clamped) value.
  assert.equal(map.values[4],1);
  assert.deepEqual(Array.from(cropAttention(Float32Array.from([0,1,2,3,4,5]),{x:1,y:0,width:2,height:2},3)),[1,2,4,5]);
  console.log('PASS importance normalization, neutral maps, visible-pixel range, transparent values and crop alignment');
})().catch(error=>{console.error(error);process.exitCode=1;});

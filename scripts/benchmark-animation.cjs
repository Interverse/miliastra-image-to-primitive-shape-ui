/* Synthetic state/storage benchmark, excluding fitting/decoding/game rendering. */
"use strict";
const A=require('../js/animation-core.js');global.LuaExport=require('../js/lua-export.js');const L=require('../js/animation-lua.js');
const animation={kind:'primeval',width:512,height:288,controls:200,frames:[],durations:Array(120).fill(1/30),loop:true};
for(let f=0;f<120;f++){const frame=new Float64Array(200*8);for(let i=0;i<200;i++)frame.set([i%3+1,i*20+(i===0?f:0),i*5,100,80,i===0?f:0,0xff203040,i],i*8);animation.frames.push(frame);}
const at=performance.now(),packed=L.encode(animation),script=L.build(animation,{imageTemplateIndex:123});
console.log(JSON.stringify({frames:120,controls:200,meanChangedFields:packed.patches.slice(1).reduce((n,p)=>n+p.length/2,0)/119,luaBytes:Buffer.byteLength(script),encodeMs:performance.now()-at},null,2));

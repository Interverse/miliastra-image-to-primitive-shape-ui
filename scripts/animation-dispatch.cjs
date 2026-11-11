'use strict';
// Static Lua functions: no load(), eval, or generated code executes in the game.
// Each mask groups shapes with the same changed fields, reading each receiver once.
module.exports=function dispatchSource(pipelined=false){
 const lines=['local dispatch={}'];
 for(let mask=1;mask<64;mask++){
  // A newly visible shape needs every field; a hidden shape needs visibility only.
  if((mask&2)&&mask!==2&&mask!==63)continue;
  function loop(shared,scale){
   let offset=1;const body=[pipelined?'local s=pool[t[i]] local control=s[1]':(shared?'local control=t[i]':'local s=t[i] local control=s[1]')],fn=(n,name)=>shared?name:'s['+n+']';
   if(mask&1){body.push(`${fn(2,'SET_IMAGE')}(control,STATIC,t[i+${offset}])`);offset++;}
   if(mask&2){body.push(`${fn(3,'SET_VISIBLE')}(control,t[i+${offset}])`);offset++;}
   if(mask&4){body.push(`${fn(4,'SET_POSITION')}(control,t[i+${offset}],t[i+${offset+1}])`);offset+=2;}
   if(mask&8){body.push(`${fn(5,'SET_DIMENSIONS')}(control,t[i+${offset}],t[i+${offset+1}]${scale?',1':''})`);offset+=2;}
   if(mask&16){body.push(`${fn(6,'SET_ROTATION')}(control,0,0,t[i+${offset}])`);offset++;}
   if(mask&32){body.push(`control.imageColor=t[i+${offset}]`);offset++;}
   if(pipelined)body.push('s[7]=frame');
   return `for i=${pipelined?'first,last':'1,#t'},${offset} do ${body.join(' ')} end`;
  }
  const path=shared=>(mask&8)?`if TRANSFORM_GEOMETRY then ${loop(shared,true)} else ${loop(shared,false)} end`:loop(shared,false);
  lines.push(`dispatch[${mask}]=function(t${pipelined?',first,last,pool,frame':''}) if SHARED_METHODS then ${path(true)} else ${path(false)} end end`);
 }
 return lines.join('\n');
};

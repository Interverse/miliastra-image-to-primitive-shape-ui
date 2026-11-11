'use strict';
// Independently implemented data-layout/specialization experiments; plain Lua.
function fields(mask){let n=1;const f={};for(const [bit,name,width] of [[1,'image',1],[2,'visible',1],[4,'position',2],[8,'size',2],[16,'rotation',1],[32,'color',1]])if(mask&bit){f[name]=Array.from({length:width},()=>++n);}return {fields:f,stride:n};}
function blocked(mask,{blockSize,scalarRotation}){
 const {fields:f,stride}=fields(mask);
 const body=(base,shared,scale)=>{
  const get=k=>base===null?`block[j${k>1?'+'+(k-1):''}]`:`block[${base*stride+k}]`,fn=(slot,name)=>shared?name:`s[${slot}]`;
  const lines=['do',shared?`local control=${get(1)}`:`local s=${get(1)} local control=s[1]`];
  if(f.image)lines.push(`${fn(2,'SET_IMAGE')}(control,STATIC,${get(f.image[0])})`);
  lines.push(`${fn(4,'SET_POSITION')}(control,${get(f.position[0])},${get(f.position[1])})`,`${fn(5,'SET_DIMENSIONS')}(control,${get(f.size[0])},${get(f.size[1])}${scale?',1':''})`);
  lines.push(scalarRotation?`control.localRotationZ=${get(f.rotation[0])}`:`${fn(6,'SET_ROTATION')}(control,0,0,${get(f.rotation[0])})`,`control.imageColor=${get(f.color[0])}`,'end');return lines.join(' ');
 };
 const loop=(shared,scale)=>`local n=#t for i=1,n-1 do local block=t[i] ${Array.from({length:blockSize},(_,i)=>body(i,shared,scale)).join(' ')} end local block=t[n] for j=1,#block,${stride} do ${body(null,shared,scale)} end`;
 const path=shared=>`if TRANSFORM_GEOMETRY then ${loop(shared,true)} else ${loop(shared,false)} end`;
 return `dispatch[${mask}]=function(t) if SHARED_METHODS then ${path(true)} else ${path(false)} end end`;
}
function generate({layout='columns',unroll=1,hoist=false,scalarRotation=false,blockSize=8}={}){
 if(!['columns','rows','unpack','hybrid'].includes(layout)||![1,2,4,8].includes(unroll)||![4,8,16].includes(blockSize))throw Error('Invalid kernel experiment');
 const hybrid=layout==='hybrid';if(hybrid)layout='columns';
 const out=['local dispatch={}'];if(layout==='unpack')out.push('local UNPACK=table.unpack or unpack');
 for(let mask=1;mask<64;mask++){
  if((mask&2)&&mask!==2&&mask!==63)continue;
  if(hybrid&&(mask===60||mask===61)){out.push(blocked(mask,{blockSize,scalarRotation}));continue;}
  const {fields:f,stride}=fields(mask),used=[];
  for(const [name,fn] of [['image','SET_IMAGE'],['visible','SET_VISIBLE'],['position','SET_POSITION'],['size','SET_DIMENSIONS'],['rotation','SET_ROTATION']])if(f[name])used.push(fn);
  function branch(shared,scale){
   const locals=[];
   if(layout==='columns')for(let k=1;k<=stride;k++)locals.push(`local a${k}=t[${k}]`);
   if(hoist&&shared)for(const fn of used)locals.push(`local ${fn.toLowerCase()}=${fn}`);
   const size=layout==='columns'?'#a1':'#t';
   function body(index){
    const code=['do'];if(index!=='i')code.push(`local j=${index}`);const ix=index==='i'?'i':'j';
    if(layout==='rows')code.push(`local row=t[${ix}]`);
    if(layout==='unpack')code.push(`local ${Array.from({length:stride},(_,k)=>'v'+(k+1)).join(',')}=UNPACK(t[${ix}])`);
    const get=k=>layout==='columns'?`a${k}[${ix}]`:layout==='rows'?`row[${k}]`:`v${k}`;
    code.push(shared?`local control=${get(1)}`:`local s=${get(1)} local control=s[1]`);
    const fn=(slot,name)=>shared?(hoist?name.toLowerCase():name):`s[${slot}]`;
    if(f.image)code.push(`${fn(2,'SET_IMAGE')}(control,STATIC,${get(f.image[0])})`);
    if(f.visible)code.push(`${fn(3,'SET_VISIBLE')}(control,${get(f.visible[0])})`);
    if(f.position)code.push(`${fn(4,'SET_POSITION')}(control,${get(f.position[0])},${get(f.position[1])})`);
    if(f.size)code.push(`${fn(5,'SET_DIMENSIONS')}(control,${get(f.size[0])},${get(f.size[1])}${scale?',1':''})`);
    if(f.rotation)code.push(scalarRotation?`control.localRotationZ=${get(f.rotation[0])}`:`${fn(6,'SET_ROTATION')}(control,0,0,${get(f.rotation[0])})`);
    if(f.color)code.push(`control.imageColor=${get(f.color[0])}`);
    code.push('end');return code.join(' ');
   }
   let loop;
   if(unroll===1)loop=`for i=1,${size} do ${body('i')} end`;
   else loop=`local n=${size} local stop=n-n%${unroll} for i=1,stop,${unroll} do ${Array.from({length:unroll},(_,k)=>body(k?'i+'+k:'i')).join(' ')} end for i=stop+1,n do ${body('i')} end`;
   return locals.join(' ')+' '+loop;
  }
  const path=shared=>f.size?`if TRANSFORM_GEOMETRY then ${branch(shared,true)} else ${branch(shared,false)} end`:branch(shared,false);
  out.push(`dispatch[${mask}]=function(t) if SHARED_METHODS then ${path(true)} else ${path(false)} end end`);
 }
 return out.join('\n');
}
function append(layout='columns',blockSize=8){
 const receiver='SHARED_METHODS and controls[id] or slots[id]';
 const entries=[['asset',['assets[kind]']],['visible',['kind~=nil']],['position',['frame[a+2]','frame[a+3]']],['size',['frame[a+4]','frame[a+5]']],['rotation',['frame[a+6]']],['color',['frame[a+7]']]];
 if(layout==='hybrid')return ' if mask==60 or mask==61 then\n'+append('flat').replace('local t=buckets[mask] if not t then t={} buckets[mask]=t end',`local blocks=buckets[mask] if not blocks then blocks={} buckets[mask]=blocks end local t=blocks[#blocks] local width=mask==60 and 7 or 8 if not t or #t>=width*${blockSize} then t={} blocks[#blocks+1]=t end` )+'\n else\n'+append('columns')+'\n end';
 if(layout==='flat')return ` local t=buckets[mask] if not t then t={} buckets[mask]=t end local n=#t t[n+1]=${receiver} n=n+1\n`+entries.map(([test,values])=>` if ${test} then ${values.map(value=>`t[n+1]=${value} n=n+1`).join(' ')} end`).join('\n');
 if(layout==='columns')return ` local t=buckets[mask] if not t then t={} local width=1+(asset and 1 or 0)+(visible and 1 or 0)+(position and 2 or 0)+(size and 2 or 0)+(rotation and 1 or 0)+(color and 1 or 0) for k=1,width do t[k]={} end buckets[mask]=t end\n local record=#t[1]+1 local n=1 t[1][record]=${receiver}\n`+entries.map(([test,values])=>` if ${test} then ${values.map(value=>`n=n+1 t[n][record]=${value}`).join(' ')} end`).join('\n');
 if(layout==='rows'||layout==='unpack')return ` local t=buckets[mask] if not t then t={} buckets[mask]=t end local row={${receiver}} t[#t+1]=row local n=1\n`+entries.map(([test,values])=>` if ${test} then ${values.map(value=>`n=n+1 row[n]=${value}`).join(' ')} end`).join('\n');
 throw Error('Invalid command layout');
}
module.exports={generate,fields,append};

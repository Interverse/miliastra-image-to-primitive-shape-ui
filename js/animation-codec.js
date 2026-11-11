/* Lossless, predictive adaptive arithmetic coding. Private Lua payload only. */
'use strict';
const AnimationCodec=(()=>{
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',TOP=4294967296,HALF=2147483648,QUARTER=1073741824;
 const zig=n=>n<0?-2*n-1:2*n, signed=n=>n%2?-(n+1)/2:n/2;
 function coder(input){
  let low=0,high=TOP-1,pending=0,word=0,bits=0,text='',at=0,code=0;const chunks=[];
  const models=new Map();
  function put(bit){word+=bit*2**bits;if(++bits===6){text+=alphabet[word];word=bits=0;if(text.length===8192){chunks.push(text);text='';}}}
  function get(){if(!bits){word=alphabet.indexOf(input[at++]);if(word<0)word=0;bits=6;}const bit=word%2;word=Math.floor(word/2);bits--;return bit;}
  if(input!==undefined)for(let i=0;i<32;i++)code=code*2+get();
  function bit(context,value){
   let p=models.get(context)??2048;
   const mid=low+Math.floor((high-low+1)*p/4096)-1;
   if(input!==undefined)value=code>mid?1:0;
   if(value)low=mid+1;else high=mid;
   models.set(context,Math.max(1,Math.min(4095,value?p-Math.max(1,Math.floor(p/32)):p+Math.max(1,Math.floor((4096-p)/32)))));
   for(;;){
    if(high<HALF){if(input===undefined){put(0);while(pending){put(1);pending--;}}}
    else if(low>=HALF){if(input===undefined){put(1);while(pending){put(0);pending--;}}low-=HALF;high-=HALF;if(input!==undefined)code-=HALF;}
    else if(low>=QUARTER&&high<3*QUARTER){if(input===undefined)pending++;low-=QUARTER;high-=QUARTER;if(input!==undefined)code-=QUARTER;}
    else break;
    low*=2;high=high*2+1;if(input!==undefined)code=code*2+get();
   }
   return value;
  }
  function number(context,count,value=0){let out=0,node=1;for(let i=count-1;i>=0;i--){const b=bit(context+node,Math.floor(value/2**i)%2);out=out*2+b;node=node*2+b;}return out;}
  function finish(){pending++;const b=low<QUARTER?0:1;put(b);while(pending){put(1-b);pending--;}if(bits)text+=alphabet[word];chunks.push(text);return chunks.join('');}
  return {bit,number,finish};
 }
 function channel(frame,old,c,N,transform){const out=new Float64Array(N);for(let id=0;id<N;id++){const a=id*8+(c<6?c:c<10?6:7);let v=frame[a]||0,p=old?.[a]||0;if(c>=6&&c<10){const s=(c-6)*8;const vg=(v>>>8)&255,pg=(p>>>8)&255;v=(((v>>>s)&255)-(transform&&(c===6||c===8)?vg:0)+256)%256;p=(((p>>>s)&255)-(transform&&(c===6||c===8)?pg:0)+256)%256;out[id]=((v-p+128)&255)-128;}else out[id]=v-p;}return out;}
 function prediction(values,previous){let best=0,cost=Infinity;for(let mode=0;mode<3;mode++){let sum=0,last=0,run=0;for(let i=0;i<values.length;i++){const d=values[i]-(mode===1?(previous?.[i]||0):mode===2?last:0);if(d===0)run++;else{if(run)sum+=2*Math.log2(run+1)+1;run=0;sum+=2*Math.log2(Math.abs(d)+1)+2;}last=values[i];}if(run)sum+=2*Math.log2(run+1)+1;if(sum<cost){cost=sum;best=mode;}}return best;}
 function encode(animation,{transform=false}={}){
  const output=coder(),N=animation.controls,previous=Array(11);let old=null;
  for(const frame of animation.frames){
   for(let c=0;c<11;c++){
    const values=channel(frame,old,c,N,transform),mode=prediction(values,previous[c]),base=c*4096;
    output.number(base+3500,2,mode);
    const residual=Float64Array.from(values,(v,i)=>zig(v-(mode===1?(previous[c]?.[i]||0):mode===2?(values[i-1]||0):0)));
    for(let i=0;i<N;i++){
     let v=residual[i],run=0;
     if(v===0){let end=i+1;while(end<N&&residual[end]===0)end++;if(end-i>=3){run=end-i;i=end-1;}}
     const extra=v?Math.floor(Math.log2(v)):0,symbol=run?0:v?extra+2:1;
     if(extra>48)throw Error('animation.limit');
     output.number(base,6,symbol);
     if(symbol>1){for(let j=extra-1;j>=0;j--)output.bit(base+64+extra*53+j,Math.floor((v-2**extra)/2**j)%2);}
     if(run){const k=Math.floor(Math.log2(run));for(let j=0;j<k;j++)output.bit(base+3000+j,0);output.bit(base+3000+k,1);for(let j=k-1;j>=0;j--)output.bit(base+3064+j,Math.floor((run-2**k)/2**j)%2);}
    }
    previous[c]=values;
   }
   old=frame;
  }
  return output.finish();
 }
 function decode(text,N,count,{transform=false}={}){
  const input=coder(text),previous=Array(11),frames=[];let old=new Float64Array(N*8);
  for(let f=0;f<count;f++){
   const frame=new Float64Array(N*8),colors=new Uint32Array(N);
   for(let c=0;c<11;c++){
    const base=c*4096,mode=input.number(base+3500,2),deltas=new Float64Array(N);let run=0;
    if(mode>2)throw Error('Invalid animation predictor');
    for(let id=0;id<N;id++){
     let value=0;
     if(run)run--;else{
      const s=input.number(base,6);
      if(s>1){const k=s-2;if(k>48)throw Error('Invalid animation value');value=2**k;for(let j=k-1;j>=0;j--)value+=input.bit(base+64+k*53+j)*2**j;}
      else if(s===0){let k=0;while(!input.bit(base+3000+k)){if(++k>48)throw Error('Invalid animation run');}run=2**k-1;for(let j=k-1;j>=0;j--)run+=input.bit(base+3064+j)*2**j;}
     }
     const delta=signed(value)+(mode===1?(previous[c]?.[id]||0):mode===2?(deltas[id-1]||0):0);deltas[id]=delta;
     if(c<6)frame[id*8+c]=old[id*8+c]+delta;
     else if(c<10){const shift=(c-6)*8,b=((((old[id*8+6]>>>shift)&255)-(transform&&(c===6||c===8)?(old[id*8+6]>>>8)&255:0)+delta+512)%256);colors[id]+=b*2**shift;if(c===9&&!transform)frame[id*8+6]=colors[id];else if(c===9){const g=(colors[id]>>>8)&255;frame[id*8+6]=(colors[id]>>>24)*16777216+(((colors[id]>>>16)&255)+g)%256*65536+g*256+((colors[id]&255)+g)%256;}}
     else frame[id*8+7]=old[id*8+7]+delta;
    }
    if(run)throw Error('Invalid animation run length');previous[c]=deltas;
   }
   frames.push(frame);old=frame;
  }
  return frames;
 }
 return {encode,decode};
})();
if(typeof module!=='undefined')module.exports=AnimationCodec;

'use strict';
const {extract}=require('./upgrade-animation-player.cjs');
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decode(source,withSegments=false){
 const meta=extract(source),N=meta.dimensions[3],data=meta.lines.DATA.trim().slice(1,-1);let at=0,buffer=0,bits=0,run=0;
 if(meta.lines.CODEC==='2'){if(withSegments)throw Error('Range-coded data has no Huffman segments');return {meta,frames:require('../js/animation-codec.js').decode(data,N,meta.durations.length,{transform:meta.lines.COLOR_TRANSFORM==='true'}),segments:[]};}
 const take=n=>{while(bits<n){const digit=alphabet.indexOf(data[at++]);if(digit<0)throw Error('Truncated animation payload');buffer+=digit*2**bits;bits+=6;}const p=2**n,v=buffer%p;buffer=Math.floor(buffer/p);bits-=n;return v;};
 const value=c=>{if(run){run--;return 0;}const [root,tree]=meta.books[c];let node=root,steps=0;while(node>0){if(++steps>tree.length+1)throw Error('Invalid Huffman tree');node=tree[(node-1)*2+take(1)];}if(!Number.isInteger(node))throw Error('Invalid Huffman node');const symbol=-node-1;if(symbol===1)return 0;if(symbol>1)return 2**(symbol-2)+take(symbol-2);let n=0;while(!take(1)){if(++n>=53)throw Error('Invalid animation run');}run=2**n+take(n)-1;return 0;};
 const signed=v=>v%2?-(v+1)/2:v/2,frames=[],segments=[],components=new Uint8Array(N*4);let old=new Float64Array(N*8);
 for(let f=0;f<meta.durations.length;f++){const state=new Float64Array(N*8);for(let c=0;c<12;c++){const start=at*6-bits,length=c<11?N:meta.moveCounts[f];for(let id=0;id<length;id++){const v=signed(value(c));if(c<6)state[id*8+c]=old[id*8+c]+v;else if(c<10){const key=id*4+c-6;components[key]=(components[key]+v+256)%256;if(c===9){const a=id*4;state[id*8+6]=components[a+3]*16777216+components[a+2]*65536+components[a+1]*256+components[a];}}else if(c===10)state[id*8+7]=old[id*8+7]+v;}if(run)throw Error('Animation run exceeds channel');if(withSegments&&c<11)segments.push([start,at*6-bits]);}frames.push(state);old=state;}
 return {meta,frames,segments};
}
function stripOrdering(source){
 const {meta,segments}=decode(source,true),input=meta.lines.DATA.trim().slice(1,-1);let text='',value=0,bits=0;
 for(const [start,end] of segments)for(let at=start;at<end;){const offset=at%6,n=Math.min(6-offset,end-at),chunk=(alphabet.indexOf(input[Math.floor(at/6)])>>>offset)&((1<<n)-1);value|=chunk<<bits;bits+=n;at+=n;if(bits>=6){text+=alphabet[value&63];value>>>=6;bits-=6;}}
 if(bits)text+=alphabet[value];const books=meta.books.map((b,i)=>i===11?[-2,[]]:b),lines={...meta.lines,DATA:'"'+text+'"',books:'{'+books.map(b=>'{'+b[0]+', {'+b[1].join(',')+'}}').join(',')+'}',moveCounts:'{'+Array(meta.durations.length+1).fill(0).join(',')+'}'};
 return Object.entries(lines).map(([name,value])=>'local '+name+'='+value).join('\n');
}
function expand(frame,compact){if(!compact)return frame.slice();return Float64Array.from(frame,(v,i)=>{const c=i%8;if(c>=1&&c<=4)return v*5;if(c===5)return v*10;if(c===6)return (v>>>24)*16777216+Math.round(((v>>>16)&255)*255/31)*65536+Math.round(((v>>>8)&255)*255/63)*256+Math.round((v&255)*255/31);return v;});}
function asHuffman(source){
 const meta=extract(source);if(meta.lines.CODEC!=='2')return source;
 const packed=require('../js/animation-lua.js').encodeHuffman({controls:meta.dimensions[3],frames:decode(source).frames}),lines={...meta.lines};
 delete lines.CODEC;delete lines.COLOR_TRANSFORM;
 lines.DATA='"'+packed.text+'"';lines.books='{'+packed.books.map(b=>'{'+b.root+',{'+b.tree.join(',')+'}}').join(',')+'}';lines.moveCounts='{'+meta.moveCounts.map(()=>0).join(',')+'}';
 return Object.entries(lines).map(([name,value])=>'local '+name+'='+value).join('\n');
}
module.exports={decode,expand,stripOrdering,asHuffman};

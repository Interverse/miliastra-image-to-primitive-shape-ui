'use strict';
const {decode,stripOrdering}=require('./animation-payload.cjs');
const Player=require('../js/animation-lua.js'),Order=require('../js/animation-order.js');
function optimize(source){
 const {meta,frames}=decode(source),N=meta.dimensions[3],planned=Order.plan(frames,meta,{maxCells:Infinity}),optimized=planned.frames;
 const packed=Player.encode({controls:N,frames:optimized,durations:meta.durations}),lines={...meta.lines};delete lines.CODEC;delete lines.COLOR_TRANSFORM;lines.DATA='"'+packed.text+'"';lines.books='{'+packed.books.map(b=>'{'+b.root+', {'+b.tree.join(',')+'}}').join(',')+'}';lines.moveCounts='{'+packed.orders.map(a=>a.length).concat(packed.loopOrder.length).join(',')+'}';
 return {source:stripOrdering(Object.entries(lines).map(([name,value])=>'local '+name+'='+value).join('\n')),...planned};
}
module.exports={optimize,bounds:Order.bounds,overlap:Order.overlap,graph:Order.graph,measure:Order.measure,originalOrder:Order.originalOrder};

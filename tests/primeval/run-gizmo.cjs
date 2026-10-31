const assert=require('node:assert/strict');
const {hit,resize}=require('../../js/gizmo-resize.js');
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} != ${b}`);
for(const a of [0,Math.PI/4,Math.PI/2,-1.1]){
  const box={c:{x:100,y:80},w:40,h:20,a};
  const world=(x,y)=>({x:100+x*Math.cos(a)-y*Math.sin(a),y:80+x*Math.sin(a)+y*Math.cos(a)});
  for(const [side,x,y,dx,dy]of [[0,15,-20,0,-10],[1,40,7,20,0],[2,17,20,0,12],[3,-40,-7,15,0]]){
    const start=world(x,y),end=world(x+dx,y+dy),handle=hit(box,start,9);
    assert.equal(handle.side,side,'whole edges are draggable away from midpoint handles');
    const result=resize(box,start,end,side,.01),horizontal=side%2===1;
    near(horizontal?result.sy:result.sx,1);
    const sign=side===1||side===2?1:-1;
    const oldOpposite=horizontal?world(-sign*40,0):world(0,-sign*20);
    const lx=horizontal?-sign*40*result.sx:0,ly=horizontal?0:-sign*20*result.sy;
    near(result.c.x+lx*Math.cos(a)-ly*Math.sin(a),oldOpposite.x);
    near(result.c.y+lx*Math.sin(a)+ly*Math.cos(a),oldOpposite.y);
  }
  assert.equal(hit(box,world(40,20),9).axis,'xy');
  assert.equal(hit(box,world(80,80),9),null);
}
console.log('PASS edge resizing: four sides, rotated boxes, independent axes and fixed opposite edges');

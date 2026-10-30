/* Exact final Primeval geometry -> one asset per shape. No per-shape masks. */
(function(root){
  "use strict";
  const ASSETS={ellipse:100002,rectangle:100001,triangle:100003};
  const hex=c=>"#"+c.slice(0,3).map(n=>n.toString(16).padStart(2,"0")).join("");
  const packed=(c,a)=>((((Math.round(a*255)&255)<<24)|((c[0]&255)<<16)|((c[1]&255)<<8)|(c[2]&255))>>>0);
  function triangle(points){
    let best;
    for(let apex=0;apex<3;apex++){
      const a=(apex+1)%3,b=(apex+2)%3;
      const qx=(points[2*a]+points[2*b])/2,qy=(points[2*a+1]+points[2*b+1])/2;
      const hx=points[2*apex]-qx,hy=points[2*apex+1]-qy,height=Math.hypot(hx,hy);
      const width=Math.hypot(points[2*a]-points[2*b],points[2*a+1]-points[2*b+1]);
      const error=Math.abs((points[2*a]-points[2*b])*hx+(points[2*a+1]-points[2*b+1])*hy)/Math.max(width*height,1e-30);
      if(!best||error<best.error)best={error,width,height,x:(qx+points[2*apex])/2,y:(qy+points[2*apex+1])/2,angle:Math.atan2(hx,-hy)*180/Math.PI};
    }
    if(!best||best.error>1e-8)throw Error("PRIMEVAL_TRIANGLE_GEOMETRY");
    return best;
  }
  function drawingToElements(drawing,width,height,config={}){
    const scale=Math.min(width/drawing.width,height/drawing.height);
    const ox=(width-drawing.width*scale)/2,oy=(height-drawing.height*scale)/2;
    const unit=Number(config.image_scale)||1,alpha=config.output_alpha??1;
    const origin={x:width/2,y:height/2};
    if(config.origin?.type==="top_left"){origin.x=0;origin.y=0;}
    if(config.origin?.type==="custom"){origin.x=Number(config.origin.x)||0;origin.y=Number(config.origin.y)||0;}
    const make=(type,x,y,w,h,angle,color,background=false)=>{
      const a=(color[3]/255)*(background?1:alpha),cx=x*unit,cy=-y*unit;
      return {type,shape:type==="rectangle"?"rect":type==="ellipse"?"circle":"triangle",center:{x:cx,y:cy},relative:{x:cx-origin.x*unit,y:cy+origin.y*unit},size:type==="ellipse"?{rx:w*unit/2,ry:h*unit/2}:{width:w*unit,height:h*unit},rotation:{x:0,y:0,z:-angle},color:hex(color),alpha:a,packed_color:packed(color,a),primitive_type:type==="rectangle"?"rect":type==="ellipse"?"circle":"triangle",image_asset_ref:ASSETS[type],...(background?{is_background:true}:{})};
    };
    const elements=[make("rectangle",width/2,height/2,width,height,0,drawing.background,true)];
    for(const shape of drawing.shapes){
      const g=shape.geometry;let type,x,y,w,h,angle=0;
      if(shape.kind==="ellipse"){
        type="ellipse";[x,y,w,h,angle]=g;w*=2;h*=2;
      }else if(shape.kind==="rectangle"){
        type="rectangle";[x,y,w,h]=g;x+=w/2;y+=h/2;
      }else if(shape.kind==="polygon"&&g.length===6){
        const tri=triangle(g);type="triangle";({x,y,width:w,height:h,angle}=tri);
      }else if(shape.kind==="polygon"&&g.length===8){
        type="rectangle";x=(g[0]+g[2]+g[4]+g[6])/4;y=(g[1]+g[3]+g[5]+g[7])/4;
        w=Math.hypot(g[2]-g[0],g[3]-g[1]);h=Math.hypot(g[4]-g[2],g[5]-g[3]);angle=Math.atan2(g[3]-g[1],g[2]-g[0])*180/Math.PI;
      }else throw Error("PRIMEVAL_SHAPE_GEOMETRY");
      const element=make(type,x*scale+ox,y*scale+oy,w*scale,h*scale,angle,shape.color);
      // Existing website triangles use a centroid pivot; the game asset's
      // bounding-box center is retained separately for every export boundary.
      if(type==="triangle")element.triangle_pivot="box";
      elements.push(element);
    }
    return {elements,origin,scale,offset:[ox,oy]};
  }
  function matteRGB(rgba){
    const out=new Uint8Array(rgba.length/4*3),matte=[240,240,245];
    for(let i=0,j=0;i<rgba.length;i+=4,j+=3){const a=rgba[i+3];for(let c=0;c<3;c++)out[j+c]=Math.floor((rgba[i+c]*a+matte[c]*(255-a)+127)/255);}
    return out;
  }
  const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function chunk(type,data){
    const out=new Uint8Array(data.length+12),v=new DataView(out.buffer);v.setUint32(0,data.length);
    for(let i=0;i<4;i++)out[4+i]=type.charCodeAt(i);out.set(data,8);
    let crc=0xffffffff;for(let i=4;i<out.length-4;i++)crc=crcTable[(crc^out[i])&255]^(crc>>>8);
    v.setUint32(out.length-4,(crc^0xffffffff)>>>0);return out;
  }
  async function encodeRGB(rgb,width,height){
    const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
    const rows=new Uint8Array(height*(width*3+1));for(let y=0;y<height;y++)rows.set(rgb.subarray(y*width*3,(y+1)*width*3),y*(width*3+1)+1);
    const stream=new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"));
    const compressed=new Uint8Array(await new Response(stream).arrayBuffer());
    return new Uint8Array(await new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",compressed),chunk("IEND",new Uint8Array())]).arrayBuffer());
  }
  function drawElements(ctx,elements,unit=1){
    for(const e of elements){
      ctx.save();ctx.translate(e.center.x/unit,-e.center.y/unit);ctx.rotate(-(e.rotation?.z||0)*Math.PI/180);
      ctx.globalAlpha=e.alpha;ctx.fillStyle=e.color;ctx.beginPath();
      if(e.type==="ellipse")ctx.ellipse(0,0,e.size.rx/unit,e.size.ry/unit,0,0,Math.PI*2);
      else if(e.type==="triangle"){
        const w=e.size.width/unit,h=e.size.height/unit;ctx.moveTo(0,-h/2);ctx.lineTo(-w/2,h/2);ctx.lineTo(w/2,h/2);ctx.closePath();
      }else ctx.rect(-e.size.width/unit/2,-e.size.height/unit/2,e.size.width/unit,e.size.height/unit);
      ctx.fill();ctx.restore();
    }
  }
  const api={triangle,drawingToElements,matteRGB,encodeRGB,drawElements};root.PrimevalResult=api;
  if(typeof module!=="undefined")module.exports=api;
})(typeof self!=="undefined"?self:globalThis);

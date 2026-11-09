/* Data-only import. Untrusted SVG/CSS is parsed, never mounted or executed. */
"use strict";
const FinishedImport=(()=>{
  const fail=(code='import.invalid')=>{throw new Error(code);};
  const num=(v,fallback)=>{if(v===undefined||v===null||v===''){if(fallback===undefined)fail();v=fallback;}if(!['number','string'].includes(typeof v))fail();const n=Number(v);return Number.isFinite(n)?n:fail();};
  const type=t=>({circle:'ellipse',rect:'rectangle'}[t]||t);
  let colorCanvas;
  function color(value,alpha=1){
    if(typeof value!=='string')fail();
    if(!colorCanvas){colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;}
    const c=colorCanvas.getContext('2d');c.clearRect(0,0,1,1);
    if(!CSS.supports('color',value)||/var\(|currentcolor|inherit|initial|unset|revert/i.test(value))fail();
    c.fillStyle=value;c.fillRect(0,0,1,1);const p=c.getImageData(0,0,1,1).data;
    return {color:'#'+[...p.slice(0,3)].map(n=>n.toString(16).padStart(2,'0')).join(''),alpha:p[3]/255*alpha};
  }
  function finish(width,height,elements,config={},origin=null,mask=null){
    width=num(width);height=num(height);if(width<=0||height<=0)fail();
    const inferredPPU=config.pixel_per_unit ?? config.primitive_size;
    const unit=num(config.image_scale,inferredPPU!=null?1/num(inferredPPU):1);if(unit<=0)fail();
    const ppu=num(inferredPPU,1/unit);if(ppu<=0)fail();
    if(config.allowed_shapes!=null&&(!Array.isArray(config.allowed_shapes)||config.allowed_shapes.some(s=>typeof s!=='string')))fail();
    if(config.primeval_experiments!=null&&!Array.isArray(config.primeval_experiments))fail();
    const image_size={width:Math.ceil(width),height:Math.ceil(height)};
    const image_center={x:image_size.width/2,y:image_size.height/2};
    const offset=origin?{x:num(origin.x),y:num(origin.y)}:{x:image_center.x/ppu,y:-image_center.y/ppu};
    const normalized=elements.map((raw,i)=>{
      if(!raw||!['ellipse','rectangle','triangle'].includes(type(raw.type)))fail('import.unsupported');
      const el=structuredClone(raw);el.type=type(el.type);el.id??=i;
      el.center=raw.center?{x:num(raw.center.x),y:num(raw.center.y)}:{x:num(raw.relative?.x)+offset.x,y:num(raw.relative?.y)+offset.y};
      el.relative={x:el.center.x-offset.x,y:el.center.y-offset.y};
      const keys=el.type==='ellipse'?['rx','ry']:['width','height'];
      if(!raw.size)fail();el.size={...raw.size};for(const k of keys){el.size[k]=num(raw.size[k]);if(el.size[k]<0)fail();}
      el.rotation=typeof raw.rotation==='object'?{x:num(raw.rotation.x,0),y:num(raw.rotation.y,0),z:num(raw.rotation.z,0)}:{x:0,y:0,z:num(raw.rotation,0)};
      if(raw.packed_color!=null){
        const packed=num(raw.packed_color);if(!Number.isInteger(packed)||packed<0||packed>4294967295)fail();
        el.color='#'+(packed%16777216).toString(16).padStart(6,'0');el.alpha=Math.floor(packed/16777216)/255;
        // Export JSON's alpha/color carry more precision than packed game colour.
        if(raw.color!=null){const paint=color(raw.color,num(raw.alpha,1));el.color=paint.color;el.alpha=paint.alpha;}
      }else{const paint=color(raw.color||'#808080',num(raw.alpha,.5));el.color=paint.color;el.alpha=paint.alpha;el.packed_color=LuaExport.packColor(el.color,el.alpha);}
      if(el.alpha<0||el.alpha>1)fail();
      return el;
    });
    if(mask){
      if(typeof mask!=='object')fail();
      if(mask.center)for(const k of ['x','y'])num(mask.center[k]);
      if(mask.size)for(const k of ['width','height'])if(num(mask.size[k])<0)fail();
    }
    return {mode:config.mode||'fill',image_size,image_center,elements:normalized,elements_count:normalized.length,elapsed_seconds:0,
      config:{...config,image_scale:unit,pixel_per_unit:ppu,engine:'import-browser',primeval_reference:false,output_has_transparency:config.output_has_transparency??true},
      mask:mask?structuredClone(mask):null,importOrigin:{x:offset.x*ppu,y:-offset.y*ppu}};
  }
  function json(text){
    let data;try{data=JSON.parse(text);}catch{fail();}
    if(!data||!data.image_size||!Array.isArray(data.elements))fail();
    return finish(data.image_size.width,data.image_size.height,data.elements,data.config||{},data.origin,data.mask);
  }
  const point=(m,x,y)=>({x:m.a*x+m.c*y+m.e,y:m.b*x+m.d*y+m.f});
  function matrix(text){
    let m=new DOMMatrix(),end=0;const source=text||'';
    for(const match of source.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)){
      if(source.slice(end,match.index).trim())fail('import.unsupported');end=match.index+match[0].length;
      const v=match[2].trim().split(/[ ,]+/).map(n=>num(n));let next=new DOMMatrix();
      if(match[1]==='matrix'&&v.length===6)next=new DOMMatrix(v);
      else if(match[1]==='translate'&&[1,2].includes(v.length))next.translateSelf(v[0],v[1]||0);
      else if(match[1]==='scale'&&[1,2].includes(v.length))next.scaleSelf(v[0],v[1]??v[0]);
      else if(match[1]==='rotate'&&[1,3].includes(v.length)){if(v.length===3)next.translateSelf(v[1],v[2]);next.rotateSelf(v[0]);if(v.length===3)next.translateSelf(-v[1],-v[2]);}
      else if(match[1]==='skewX'&&v.length===1)next.skewXSelf(v[0]);
      else if(match[1]==='skewY'&&v.length===1)next.skewYSelf(v[0]);else fail('import.unsupported');m=m.multiply(next);
    }
    if(source.slice(end).trim())fail('import.unsupported');return m;
  }
  function element(shape,m,paint){
    let geometry;
    if(shape.kind==='ellipse'){
      const [x,y,rx,ry]=shape.geometry,c=point(m,x,y),ux=m.a*rx,uy=m.b*rx,vx=m.c*ry,vy=m.d*ry;
      const xx=ux*ux+vx*vx,yy=uy*uy+vy*vy,xy=ux*uy+vx*vy,disc=Math.hypot(xx-yy,2*xy);
      geometry={type:'ellipse',center:{x:c.x,y:-c.y},size:{rx:Math.sqrt(Math.max(0,(xx+yy+disc)/2)),ry:Math.sqrt(Math.max(0,(xx+yy-disc)/2))},rotation:{z:-Math.atan2(2*xy,xx-yy)*90/Math.PI}};
    }else{
      const points=shape.geometry.map((p)=>point(m,p.x,p.y));
      if(points.length===3){
        let tri;try{tri=PrimevalResult.triangle(points.flatMap(p=>[p.x,p.y]));}catch{fail('import.unsupported');}
        geometry={type:'triangle',triangle_pivot:'box',center:{x:tri.x,y:-tri.y},size:{width:tri.width,height:tri.height},rotation:{z:-tri.angle}};
      }else if(points.length===4){
        const [a,b,c,d]=points,ux=b.x-a.x,uy=b.y-a.y,vx=d.x-a.x,vy=d.y-a.y,w=Math.hypot(ux,uy),h=Math.hypot(vx,vy);
        const tolerance=.002*Math.max(1,Math.hypot(m.a,m.b),Math.hypot(m.c,m.d));
        if(Math.abs(ux*vx+uy*vy)>tolerance*Math.max(1,w,h)||Math.hypot(c.x-(b.x+d.x-a.x),c.y-(b.y+d.y-a.y))>tolerance)fail('import.unsupported');
        geometry={type:'rectangle',center:{x:(a.x+c.x)/2,y:-(a.y+c.y)/2},size:{width:w,height:h},rotation:{z:-Math.atan2(uy,ux)*180/Math.PI}};
      }else fail('import.unsupported');
    }
    return {...geometry,...paint};
  }
  function svg(text){
    const doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;
    if(root.localName!=='svg'||doc.querySelector('parsererror'))fail();
    const vb=(root.getAttribute('viewBox')||'').trim().split(/[ ,]+/).filter(Boolean).map(n=>num(n));
    const dimension=(name,fallback)=>{const value=root.getAttribute(name);if(!value)return fallback;if(!/^[+\d.eE-]+(?:px)?$/.test(value))fail('import.unsupported');return num(value.replace(/px$/,''));};
    const w=dimension('width',vb[2]),h=dimension('height',vb[3]);if(!(w>0&&h>0))fail();
    let view=new DOMMatrix();
    if(vb.length){if(vb.length!==4||vb[2]<=0||vb[3]<=0)fail();const aspect=root.getAttribute('preserveAspectRatio')||'xMidYMid meet';
      if(aspect==='none')view.scaleSelf(w/vb[2],h/vb[3]).translateSelf(-vb[0],-vb[1]);
      else if(aspect==='xMidYMid meet'){const scale=Math.min(w/vb[2],h/vb[3]);view.translateSelf((w-vb[2]*scale)/2,(h-vb[3]*scale)/2).scaleSelf(scale).translateSelf(-vb[0],-vb[1]);}
      else fail('import.unsupported');
    }
    const elements=[];
    function walk(node,parent,style={fill:'#000000','fill-opacity':'1',stroke:'none'}){
      if(['defs','title','desc','metadata'].includes(node.localName))return;
      if(!['svg','g','rect','circle','ellipse','polygon'].includes(node.localName))fail('import.unsupported');
      for(const attr of node.attributes){if(/^on/i.test(attr.name)||/href$/i.test(attr.name))fail('import.unsupported');}
      const s={...style};for(const k of ['fill','fill-opacity','stroke','stroke-width','opacity','display','visibility','filter','mask','clip-path'])if(node.hasAttribute(k))s[k]=node.getAttribute(k);
      const inline=document.createElement('div').style;inline.cssText=node.getAttribute('style')||'';
      for(const k of inline){if(!['fill','fill-opacity','stroke','stroke-width','opacity','display','visibility'].includes(k))fail('import.unsupported');s[k]=inline.getPropertyValue(k);}
      if(s.filter||s.mask||s['clip-path']||s.display==='none'||s.visibility==='hidden'||(s.stroke!=='none'&&num(s['stroke-width'],1)>0))fail('import.unsupported');
      const m=parent.multiply(matrix(node.getAttribute('transform')));
      if(['svg','g'].includes(node.localName)){if(num(s.opacity,1)!==1)fail('import.unsupported');for(const child of node.children)walk(child,m,s);return;}
      if(s.fill==='none')return;
      let paint;const gradient=s.fill.match(/^url\(#([^)]*)\)$/);
      if(gradient){
        const g=[...doc.querySelectorAll('[id]')].find(node=>node.getAttribute('id')===gradient[1]),stops=g?[...g.children]:[];
        if(g?.localName!=='radialGradient'||stops.length!==Gaussian.stops.length)fail('import.unsupported');
        for(const attr of g.attributes)if(attr.name!=='id')fail('import.unsupported');
        const tint=stops[0].getAttribute('stop-color');
        for(let i=0;i<stops.length;i++)if(stops[i].localName!=='stop'||stops[i].getAttribute('stop-color')!==tint||Math.abs(num(stops[i].getAttribute('offset'))-Gaussian.stops[i][0])>1e-6||Math.abs(num(stops[i].getAttribute('stop-opacity'),1)-Gaussian.stops[i][1])>1e-6)fail('import.unsupported');
        paint={...color(tint,num(s['fill-opacity'],1)*num(s.opacity,1)),primitive_type:'blurred_circle',image_asset_ref:106057,image_type:'Basic'};
      }else paint=color(s.fill,num(s['fill-opacity'],1)*num(s.opacity,1));
      const n=(key,fallback)=>num(node.getAttribute(key),fallback);
      if(['ellipse','circle'].includes(node.localName)){const rx=n(node.localName==='circle'?'r':'rx'),ry=n(node.localName==='circle'?'r':'ry');if(rx<0||ry<0)fail();elements.push(element({kind:'ellipse',geometry:[n('cx',0),n('cy',0),rx,ry]},m,paint));}
      else if(node.localName==='rect'){
        if(n('rx',0)||n('ry',0))fail('import.unsupported');const x=n('x',0),y=n('y',0),rw=n('width'),rh=n('height');if(rw<0||rh<0)fail();
        elements.push(element({geometry:[{x,y},{x:x+rw,y},{x:x+rw,y:y+rh},{x,y:y+rh}]},m,paint));
      }else {const points=(node.getAttribute('points')||'').trim().split(/[ ,\s]+/).map(n=>num(n));if(![6,8].includes(points.length))fail('import.unsupported');elements.push(element({geometry:Array.from({length:points.length/2},(_,i)=>({x:points[i*2],y:points[i*2+1]}))},m,paint));}
    }
    walk(root,view);return finish(w,h,elements);
  }
  function css(text){
    if(/@import\b/i.test(text.replace(/\/\*[\s\S]*?\*\//g,'')))fail('import.unsupported');
    const sheet=new CSSStyleSheet();try{sheet.replaceSync(text);}catch{fail();}
    const container=document.createElement('div'),base=document.createElement('div'),items=new Map();let found=false;
    for(const rule of sheet.cssRules){
      if(rule.type!==1)fail('import.unsupported');
      if(rule.selectorText==='.shaper-container'){container.style.cssText+=rule.style.cssText;found=true;}
      else if(rule.selectorText==='.shaper-element')base.style.cssText+=rule.style.cssText;
      else{const match=rule.selectorText.match(/^\.shaper-element\.shaper-e(\d+)$/);if(!match)fail('import.unsupported');const node=items.get(match[1])||document.createElement('div');node.style.cssText+=rule.style.cssText;items.set(match[1],node);}
    }
    if(!found)fail('import.unsupported');
    for(const key of container.style)if(!['position','width','height','box-sizing','overflow','overflow-x','overflow-y','background','background-color','background-image','background-position','background-position-x','background-position-y','background-size','background-repeat','background-origin','background-clip','background-attachment'].includes(key))fail('import.unsupported');
    const px=value=>{if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value))fail('import.unsupported');return num(value.replace(/px$/,''));};
    const w=px(container.style.width),h=px(container.style.height),elements=[];
    if(!['','none','initial'].includes(container.style.backgroundImage))fail('import.unsupported');
    const background=container.style.backgroundColor;if(background&&!['transparent','initial'].includes(background)){const c=color(background);if(c.alpha)elements.push(element({geometry:[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}]},new DOMMatrix(),c));}
    const ordered=[...items.values()].map((node,i)=>{const styled=document.createElement('div');styled.style.cssText=base.style.cssText+node.style.cssText;return {s:styled.style,i};}).sort((a,b)=>num(a.s.zIndex,0)-num(b.s.zIndex,0)||a.i-b.i);
    for(const {s} of ordered){
      for(const key of s)if(!['position','box-sizing','left','top','width','height','background','background-color','background-image','background-position','background-position-x','background-position-y','background-size','background-repeat','background-origin','background-clip','background-attachment','opacity','transform','transform-origin','z-index','border-radius','border-top-left-radius','border-top-right-radius','border-bottom-left-radius','border-bottom-right-radius','clip-path'].includes(key))fail('import.unsupported');
      for(const [key,defaults] of Object.entries({'background-position-x':['0%','0px'],'background-position-y':['0%','0px'],'background-size':['auto','auto auto'],'background-origin':['padding-box'],'background-clip':['border-box'],'background-attachment':['scroll']}))if(!['','initial',...defaults].includes(s.getPropertyValue(key)))fail('import.unsupported');
      const ew=px(s.width),eh=px(s.height),x=px(s.left),y=px(s.top);if(ew<0||eh<0)fail();
      const tr=s.transform.match(/^translate\(\s*([-\d.]+)%[ ,]+([-\d.]+)%\s*\) rotate\(\s*([-\d.]+)deg\s*\)$/);
      if(!tr)fail('import.unsupported');const origins=(s.transformOrigin||'50% 50%').split(/\s+/),origin=(v,size)=>v.endsWith('%')?num(v.slice(0,-1))*size/100:px(v);
      const ox=origin(origins[0],ew),oy=origin(origins[1]||origins[0],eh);
      const m=new DOMMatrix().translate(x+ox,y+oy).translate(num(tr[1])*ew/100,num(tr[2])*eh/100).rotate(num(tr[3])).translate(-ox,-oy);
      let paint;if(!['','none','initial'].includes(s.backgroundImage)){
        const match=s.backgroundImage.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);if(!match)fail('import.unsupported');
        const rgb=match.slice(1).map(Number),expected=document.createElement('div');
        expected.style.background=`radial-gradient(ellipse closest-side, ${Gaussian.stops.map(([r,a])=>`rgba(${rgb.join(',')},${a.toFixed(6)}) ${(r*100).toFixed(3)}%`).join(', ')})`;
        if(s.backgroundImage!==expected.style.backgroundImage)fail('import.unsupported');paint={...color(`rgb(${rgb.join(',')})`,num(s.opacity,1)),primitive_type:'blurred_circle',image_asset_ref:106057,image_type:'Basic'};
      }else paint=color(s.backgroundColor||'transparent',num(s.opacity,1));
      if(s.clipPath&&s.clipPath!=='none'){
        if(s.clipPath.replace(/\s+/g,'')!=='polygon(50%0%,0%100%,100%100%)')fail('import.unsupported');
        elements.push(element({geometry:[{x:ew/2,y:0},{x:0,y:eh},{x:ew,y:eh}]},m,paint));
      }else if(s.borderRadius&&s.borderRadius!=='0px'){
        if(s.borderRadius!=='50%')fail('import.unsupported');elements.push(element({kind:'ellipse',geometry:[ew/2,eh/2,ew/2,eh/2]},m,paint));
      }else elements.push(element({geometry:[{x:0,y:0},{x:ew,y:0},{x:ew,y:eh},{x:0,y:eh}]},m,paint));
    }
    return finish(w,h,elements);
  }
  function detect(text){const t=text.trim();return t.startsWith('{')?'json':/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t)?'svg':t.includes('.shaper-container')?'css':null;}
  function parse(text,format){try{return ({json,css,svg}[format||detect(text)]||(()=>fail()))(text);}catch(error){if(error.message.startsWith('import.'))throw error;fail();}}
  async function render(result){
    const {width,height}=result.image_size,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    if(canvas.width!==width||canvas.height!==height)fail('import.render');const ctx=canvas.getContext('2d');if(!ctx)fail('import.render');
    const ppu=result.config.pixel_per_unit;if(!result.config.output_has_transparency){ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);}
    for(const el of result.elements){ctx.save();ctx.translate(el.center.x*ppu,-el.center.y*ppu);ctx.rotate(-(el.rotation?.z||0)*Math.PI/180);ctx.fillStyle=el.color;ctx.globalAlpha=el.alpha;ctx.beginPath();
      if(el.type==='ellipse'){if(Gaussian.isGaussian(el)){ctx.globalAlpha=1;Gaussian.draw(ctx,el,ppu);}else{ctx.ellipse(0,0,el.size.rx*ppu,el.size.ry*ppu,0,0,Math.PI*2);ctx.fill();}}
      else if(el.type==='triangle'){const w=el.size.width*ppu,h=el.size.height*ppu,shift=el.triangle_pivot==='box'?h/6:0;ctx.moveTo(0,-2*h/3+shift);ctx.lineTo(-w/2,h/3+shift);ctx.lineTo(w/2,h/3+shift);ctx.closePath();ctx.fill();}
      else {ctx.rect(-el.size.width*ppu/2,-el.size.height*ppu/2,el.size.width*ppu,el.size.height*ppu);ctx.fill();}ctx.restore();}
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)fail('import.render');result.image_rgba=ctx.getImageData(0,0,width,height).data.buffer;
    return blob;
  }
  return {parse,detect,render};
})();

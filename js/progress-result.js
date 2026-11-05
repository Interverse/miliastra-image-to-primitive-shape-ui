/* Retain completed native geometry so an explicitly stopped job can be exported. */
(function(root){
  'use strict';
  function shape(node){
    const number=(name,fallback=0)=>Number(node.getAttribute(name)??fallback);
    const hex=node.getAttribute('fill');
    if(!/^#[0-9a-f]{6}$/i.test(hex||''))return null;
    const color=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
    color.push(Math.round(number('fill-opacity',1)*255));
    let result;
    if(node.localName==='ellipse')result={kind:'ellipse',geometry:[number('cx'),number('cy'),number('rx'),number('ry'),Number((node.getAttribute('transform')||'').match(/rotate\(\s*([-\d.e]+)/)?.[1]||0)],color};
    else if(node.localName==='polygon')result={kind:'polygon',geometry:(node.getAttribute('points')||'').trim().split(/[\s,]+/).map(Number),color};
    else if(node.localName==='rect')result={kind:'rectangle',geometry:[number('x'),number('y'),number('width'),number('height')],color};
    if(!result||!result.geometry.every(Number.isFinite))return null;
    return result;
  }
  function update(previous,msg){
    if(msg.previewSvg){
      const svg=new DOMParser().parseFromString(msg.previewSvg,'image/svg+xml').documentElement;
      const width=Number(svg.getAttribute('width')),height=Number(svg.getAttribute('height'));
      if(svg.localName!=='svg'||!(width>0&&height>0))return previous;
      const drawing={width,height,background:[0,0,0,0],shapes:[]};
      for(const node of svg.children){
        const item=shape(node);if(!item)continue;
        if(node.localName==='rect'&&!node.hasAttribute('x')&&!node.hasAttribute('transform'))drawing.background=item.color;
        else drawing.shapes.push(item);
      }
      return drawing;
    }
    if(msg.shapeSvg&&Number.isInteger(msg.previewIndex)&&previous){
      const svg=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">'+msg.shapeSvg+'</svg>','image/svg+xml').documentElement;
      const item=svg.firstElementChild&&shape(svg.firstElementChild);
      if(item&&msg.previewIndex>=0&&msg.previewIndex<=previous.shapes.length)previous.shapes[msg.previewIndex]=item;
    }
    return previous;
  }
  function primeval(drawing,config,width,height){
    const converted=PrimevalResult.drawingToElements(drawing,width,height,config);
    const unit=Number(config.image_scale)||1;
    return {mode:'fill',image_size:{width,height},image_center:converted.origin,
      elements:converted.elements,elements_count:converted.elements.length,
      mask:{enabled:false},mask_gray:null,preview_rgba:null,primeval_drawing:drawing,
      config:{...config,engine:'primeval-browser',primeval_reference:false,primeval_exact:false,
        source_size:{width,height},working_size:{width:drawing.width,height:drawing.height},
        image_scale:unit,pixel_per_unit:1/unit,unit_scale:unit,
        output_has_transparency:!!config.enable_png_mode,fill_variant:config.enable_png_mode?'png':'mask'}};
  }
  const api={shape,update,primeval};root.ProgressResult=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);

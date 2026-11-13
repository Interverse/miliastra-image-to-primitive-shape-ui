/* Export-only sizing. No session metadata is added to exported JSON. */
"use strict";
const ScreenSizing = (() => {
  const devices = [[1600,900],[1280,720],[1920,1080],[1280,720]];
  function width(setting, naturalWidth) { return setting ? (setting.profiles?.[setting.device]?.fraction ?? setting.fraction) * devices[setting.device][0] : naturalWidth; }
  function session(setting, naturalWidth) {
    const base={fraction:setting?.fraction ?? naturalWidth/1600,x:setting?.x ?? .5,y:setting?.y ?? .5};
    return {device:setting?.device ?? 0,snap:setting?.snap ?? true,sync:setting?.sync ?? true,
      profiles:devices.map((_,i)=>({...base,...setting?.profiles?.[i]}))};
  }
  function syncZoom(setting) {
    const fraction=setting.profiles[setting.device].fraction;
    for(const profile of setting.profiles)profile.fraction=fraction;
  }
  function factor(setting, naturalWidth) { return width(setting,naturalWidth)/naturalWidth; }
  function scaleObject(value, scale) {
    if (!value) return value;
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, typeof v === 'number' && ['x','y','rx','ry','width','height'].includes(k) ? v*scale : v]));
  }
  function payload(data, scale) {
    if (scale===1) return data;
    const result = {...data};
    if(data.origin) result.origin=scaleObject(data.origin,scale);
    if(data.config) {
      result.config={...data.config};
      if ('image_scale' in result.config) result.config.image_scale*=scale;
      if ('unit_scale' in result.config) result.config.unit_scale*=scale;
      if ('pixel_per_unit' in result.config) result.config.pixel_per_unit/=scale;
    }
    if(data.image_bounds) result.image_bounds=scaleObject(data.image_bounds,scale);
    if(data.mask) result.mask={...data.mask,center:scaleObject(data.mask.center,scale),size:scaleObject(data.mask.size,scale)};
    result.elements=data.elements.map(el=>({...el,center:scaleObject(el.center,scale),relative:scaleObject(el.relative,scale),size:scaleObject(el.size,scale)}));
    return result;
  }
  function svg(text, scale) {
    if(scale===1) return text;
    const doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;
    if(root.localName!=='svg') throw Error('Invalid SVG');
    const box=root.getAttribute('viewBox')?.split(/[ ,]+/).map(Number);
    const w=parseFloat(root.getAttribute('width')) || box?.[2], h=parseFloat(root.getAttribute('height')) || box?.[3];
    if(!root.hasAttribute('viewBox'))root.setAttribute('viewBox',`0 0 ${w} ${h}`);
    root.setAttribute('width',w*scale);root.setAttribute('height',h*scale);
    return new XMLSerializer().serializeToString(root);
  }
  function create({getImage,confirm}) {
    const $=id=>document.getElementById(id), dialog=$('screenSizingDialog'),stage=$('screenSizingStage'),image=$('screenSizingImage');
    let draft,info,url,drag;
    const buttons=[...dialog.querySelectorAll('[data-screen-device]')];
    const profile=()=>draft.profiles[draft.device];
    function draw() {
      stage.dataset.device=String(draft.device);
      const [w,h]=devices[draft.device], iw=profile().fraction*w, ih=iw*info.height/info.width;
      image.style.width=`${iw/w*100}%`; image.style.left=`${profile().x*100}%`;image.style.top=`${profile().y*100}%`;
      $('screenSizingHandle').style.left=`${(profile().x+iw/w/2)*100}%`; $('screenSizingHandle').style.top=`${(profile().y+ih/h/2)*100}%`;
      $('screenSizingWidth').value=+(iw.toFixed(2));
      $('screenSizingDimensions').textContent=`${w} × ${h} · ${+(iw.toFixed(2))} × ${+(ih.toFixed(2))}`;
      $('screenSizingSnap').checked=draft.snap;
      $('screenSizingSync').checked=draft.sync;
      buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===draft.device)));
    }
    function resize(iw) {
      if(!Number.isFinite(iw)||iw<=0){draw();return;}
      const [w,h]=devices[draft.device], ratio=info.height/info.width;
      if(draft.snap){
        const candidates=[profile().x*w*2,(1-profile().x)*w*2,profile().y*h*2/ratio,(1-profile().y)*h*2/ratio].filter(v=>v>0);
        const closest=candidates.sort((a,b)=>Math.abs(a-iw)-Math.abs(b-iw))[0];
        if(Math.abs(closest-iw)*stage.clientWidth/w<10)iw=closest;
      }
      profile().fraction=iw/w;if(draft.sync)syncZoom(draft);draw();
    }
    buttons.forEach((button,device)=>button.addEventListener('click',()=>{draft.device=device;draw();}));
    $('screenSizingSyncNow').addEventListener('click',()=>{syncZoom(draft);draw();});
    $('screenSizingSync').addEventListener('change',e=>{draft.sync=e.target.checked;if(draft.sync)syncZoom(draft);draw();});
    $('screenSizingSnap').addEventListener('change',e=>{draft.snap=e.target.checked;});
    $('screenSizingWidth').addEventListener('change',e=>resize(Number(e.target.value)));
    $('screenSizingReset').addEventListener('click',()=>{profile().fraction=info.width/devices[draft.device][0];profile().x=profile().y=.5;if(draft.sync)syncZoom(draft);draw();});
    $('screenSizingCancel').addEventListener('click',()=>dialog.close());
    $('screenSizingConfirm').addEventListener('click',()=>{confirm(session(draft,info.width),info);dialog.close();});
    dialog.addEventListener('close',()=>{if(url)URL.revokeObjectURL(url);url=null;image.removeAttribute('src');drag=null;});
    stage.addEventListener('wheel',e=>{e.preventDefault();resize(profile().fraction*devices[draft.device][0]*Math.exp(-e.deltaY*.001));},{passive:false});
    stage.addEventListener('pointerdown',e=>{
      if(e.target!==image && e.target.id!=='screenSizingHandle')return;
      e.preventDefault();stage.setPointerCapture(e.pointerId);
      drag={id:e.pointerId,scale:e.target.id==='screenSizingHandle',x:e.clientX,y:e.clientY,cx:profile().x,cy:profile().y,fraction:profile().fraction};
    });
    stage.addEventListener('pointermove',e=>{
      if(!drag||e.pointerId!==drag.id)return;
      const rect=stage.getBoundingClientRect();
      if(drag.scale){const ratio=info.height/info.width,delta=((e.clientX-drag.x)+ratio*(e.clientY-drag.y))/(1+ratio*ratio);resize((drag.fraction+2*delta/rect.width)*devices[draft.device][0]);}
      else {
        profile().x=drag.cx+(e.clientX-drag.x)/rect.width;profile().y=drag.cy+(e.clientY-drag.y)/rect.height;
        if(draft.snap){const fx=profile().fraction/2,fy=fx*info.height/info.width*16/9;
          for(const x of [fx,1-fx])if(Math.abs(profile().x-x)*rect.width<10)profile().x=x;
          for(const y of [fy,1-fy])if(Math.abs(profile().y-y)*rect.height<10)profile().y=y;
        }draw();
      }
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(event,()=>{drag=null;});
    return {async open(setting){
      info=await getImage();if(!info)return;
      draft=session(setting,info.width);
      url=URL.createObjectURL(info.png||new Blob([info.svg],{type:'image/svg+xml'}));image.src=url;
      dialog.showModal();draw();$('screenSizingConfirm').focus();
    }};
  }
  return {devices,width,session,syncZoom,factor,payload,svg,create};
})();
if(typeof module!=='undefined')module.exports=ScreenSizing;

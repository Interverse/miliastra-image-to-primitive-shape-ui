"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=require('../runtime-root.cjs'),P=require(path.join(root,'js/primeval-result.js'));let checks=0;
function check(value,message){assert(value,message);checks++;}
const sample={width:80,height:64,background:[240,240,245,255],shapes:[
 {kind:'polygon',geometry:[20,4,4,40,36,40],color:[255,30,40,128]},
 {kind:'ellipse',geometry:[60,20,10,4,35],color:[20,80,240,220]},
 {kind:'polygon',geometry:[48,42,68,42,68,54,48,54],color:[100,200,80,255]},
]};
for(const scale of [.2,1,4]){
 const result=P.drawingToElements(sample,160,128,{image_scale:scale});
 check(result.elements.length===4,'one background plus three controls');
 check(result.elements[0].is_background,'one background control');
 const e=result.elements[1],angle=-e.rotation.z*Math.PI/180,w=e.size.width/scale,h=e.size.height/scale,cx=e.center.x/scale,cy=-e.center.y/scale;
 const points=[[0,-h/2],[-w/2,h/2],[w/2,h/2]].map(([x,y])=>[cx+x*Math.cos(angle)-y*Math.sin(angle),cy+x*Math.sin(angle)+y*Math.cos(angle)]);
 const expected=[[40,8],[8,80],[72,80]];
 check(points.every(p=>expected.some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<1e-10)),'one triangle asset reconstructs final vertices');
 check(e.triangle_pivot==='box'&&e.image_asset_ref===100003,'triangle asset and pivot');
 check(result.elements[2].type==='ellipse'&&result.elements[2].rotation.z===-35,'ellipse rotation preserved');
 check(result.elements[3].type==='rectangle'&&result.elements[3].size.width===40*scale,'rectangle geometry preserved');
}
assert.throws(()=>P.triangle([0,0,20,0,4,17]),/GEOMETRY/);checks++;
const matte=P.matteRGB(Uint8Array.from([100,50,200,0,100,50,200,128,100,50,200,255]));
check(Array.from(matte).join(',')==='240,240,245,170,145,222,100,50,200','reference matte without source alpha restoration');
const world={LOCALES:{}};for(const lang of ['en','zh-CN','zh-TW','ja','ko','fr','de','es','pt','ru','th','vi','id','tr','it'])world.LOCALES[lang]={};
vm.runInNewContext(fs.readFileSync(path.join(root,'js/locales/fitting.js'),'utf8'),{window:world});
for(const [lang,table] of Object.entries(world.LOCALES))check(Boolean(table['fitting.legacy']&&table['fitting.shapeHint']),'localized controls '+lang);
const Gia=require(path.join(root,'js/gia-export.js')),exported=Gia.convertResultToGiaJson({image_size:{width:160,height:128},elements:P.drawingToElements(sample,160,128).elements},'shapes.png',1,{x:80,y:64});
check(exported.elements.length===4,'GIA keeps one image per shape');
check(exported.elements[1].image_asset_ref===100003,'GIA triangle asset retained');
console.log('PASS '+checks+' geometry, matte, localization and export checks');

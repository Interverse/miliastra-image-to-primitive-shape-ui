"use strict";
const assert=require('node:assert/strict');
const S=require('../../js/screen-sizing.js');
const original={image_size:{width:300,height:200},origin:{x:40,y:-20},config:{image_scale:.5,pixel_per_unit:2,unit_scale:.5,seed:42},mask:{enabled:true,shape_type:'ellipse',center:{x:20,y:-10},size:{width:150,height:100}},elements:[{id:7,type:'ellipse',center:{x:60,y:-30},relative:{x:20,y:-10},size:{rx:10,ry:20},rotation:{z:45},packed_color:4294967295}]};
const snapshot=JSON.stringify(original);
for(let device=0;device<4;device++){
 const setting={device,fraction:.25};
 const scale=S.factor(setting,150),out=S.payload(original,scale);
 assert.equal(out.elements[0].relative.x/out.elements[0].size.rx,2);
 assert.equal(out.origin.x+out.elements[0].relative.x,out.elements[0].center.x);
 assert.equal(out.mask.size.width/out.config.image_scale,300);
 assert.equal(out.image_size.width*out.config.image_scale,S.devices[device][0]*.25);
 assert.equal(out.config.pixel_per_unit*out.config.image_scale,1);
 assert.equal(out.elements[0].rotation.z,45);
 assert.equal(out.elements[0].packed_color,4294967295);
 assert.deepEqual(Object.keys(out),Object.keys(original));
 assert.deepEqual(Object.keys(out.config),Object.keys(original.config));
 assert.deepEqual(Object.keys(out.elements[0]),Object.keys(original.elements[0]));
}
assert.equal(JSON.stringify(original),snapshot);
assert.equal(S.payload(original,1),original);
assert.equal(S.factor(null,150),1);
const gia={elements:[{relative:{x:20,y:-10},size:{width:8,height:12},rotation:{z:5}}],image_bounds:{x:35,y:10,width:150,height:100},mask:original.mask};
const scaled=S.payload(gia,3);
assert.equal(scaled.image_bounds.width,450);
assert.equal(scaled.image_bounds.x,105);
assert.equal(scaled.elements[0].relative.x,60);
assert.equal(scaled.mask.center.y,-30);
console.log('PASS screen baselines, origin/shape/mask alignment, JSON layout and source immutability');

const fs=require('node:fs'),vm=require('node:vm');
const LOCALES=Object.fromEntries(['en','zh-CN','zh-TW','ja','ko','fr','de','es','pt','ru','th','vi','id','tr','it'].map(lang=>[lang,{}]));
vm.runInNewContext(fs.readFileSync(require.resolve('../../js/locales/screen-sizing.js'),'utf8'),{window:{LOCALES}});
for(const table of Object.values(LOCALES))for(const key of ['title','keyboard','mobile','controller','mobileController','hint','width','snap','reset','cancel','confirm','sync','syncNow'])assert.ok(table['screen.'+key]);
console.log('PASS screen sizing translations in all 15 languages');

const independent=S.session({device:0,fraction:.2,x:.3,y:.4},150);
independent.profiles[0].fraction=.4;
independent.profiles[1].fraction=.1;
independent.profiles[2].fraction=.3;
independent.profiles[3].fraction=.5;
for(const [device,expected] of [[0,640],[1,128],[2,576],[3,640]]){
 independent.device=device;
 assert.equal(S.width(independent,150),expected);
 assert.equal(S.payload(original,S.factor(independent,150)).image_size.width*S.payload(original,S.factor(independent,150)).config.image_scale,expected);
}
const cancelled=S.session(independent,150);
cancelled.profiles[1].fraction=.9;
assert.equal(independent.profiles[1].fraction,.1);
assert.equal(S.width({device:2,fraction:.25},150),480);
console.log('PASS independent device zoom, legacy sizing compatibility and isolated drafts');

const linked=S.session(null,320);
assert.equal(linked.sync,true);
linked.device=2;linked.profiles[2].fraction=.3;linked.profiles[0].x=.2;
S.syncZoom(linked);
for(const profile of linked.profiles)assert.equal(profile.fraction,.3);
assert.equal(linked.profiles[0].x,.2);
assert.equal(S.width({...linked,device:0},320),480);
assert.equal(S.width({...linked,device:2},320),576);
console.log('PASS synchronized zoom matches screen coverage without moving previews');

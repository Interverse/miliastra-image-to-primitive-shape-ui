'use strict';
/* APNG detection and timing (GIF timing is covered in run-animation.cjs). */
const assert=require('assert'),fs=require('fs'),path=require('path');
const Media=require('../../js/animation-media.js'),{apng,sample}=require('./apng-fixture.cjs');

(async()=>{
 const animated=sample(),still=sample({animated:false});
 assert.equal(Media.apngFrames(animated),3);
 assert.equal(Media.apngFrames(still),0,'a PNG without acTL is a still');
 assert.equal(Media.apngFrames(new Uint8Array([1,2,3])),0);
 const timing=Media.apngTiming(animated);
 assert.equal(timing.frames,3);assert.ok(Math.abs(timing.duration-(0.1+0.2+0.03))<1e-9,'fcTL delays sum; den 0 means 1/100 s');
 assert.equal(Media.timing('image/apng',animated).frames,3);
 assert.equal(Media.apngTiming(still),null);
 const zeroDelay=apng(1,1,[{rgba:new Uint8Array([1,2,3,255]),num:0,den:10},{rgba:new Uint8Array([4,5,6,255]),num:1,den:10}]);
 assert.equal(Media.apngTiming(zeroDelay),null,'zero delays leave timing to the decoder');
 const single=apng(1,1,[{rgba:new Uint8Array([1,2,3,255]),num:1,den:10}]);
 assert.ok(fs.readFileSync(path.join(__dirname,'fixtures/animation/moving.apng')).equals(animated),'browser fixture matches the generator');
 console.log('PASS APNG frame count and fcTL timing');

 const file=(bytes,name,type)=>new File([bytes],name,{type});
 const sniffed=await Media.sniff(file(animated,'walk.png','image/png'));
 assert.equal(sniffed.type,'image/apng');assert.equal(sniffed.name,'walk.png');assert.equal(sniffed.size,animated.length);
 assert.equal(Media.imageType(sniffed),'image/apng');
 const plain=file(still,'still.png','image/png');
 assert.strictEqual(await Media.sniff(plain),plain,'still PNGs are unchanged');
 assert.equal(Media.imageType(plain),null);
 assert.equal((await Media.sniff(file(still,'still.apng','image/apng'))).type,'image/png','a still .apng is a still image');
 assert.equal((await Media.sniff(file(single,'one.png',''))).type,'image/png','one-frame APNG is a still');
 assert.equal((await Media.sniff(file(animated,'walk.apng',''))).type,'image/apng','extension-only APNG is sniffed');
 assert.equal((await Media.sniff(file(animated.subarray(0,53),'cut.png','image/png'))).type,'image/apng','acTL alone decides; decoding reports damage');
 assert.equal((await Media.sniff(file(new Uint8Array([1,2,3]),'bad.png','image/png'))).type,'image/png');
 const jpeg=file(new Uint8Array([255,216,255]),'a.jpg','image/jpeg');assert.strictEqual(await Media.sniff(jpeg),jpeg);
 const gif=file(new Uint8Array([71,73,70]),'a.gif','');assert.equal(Media.imageType(gif),'image/gif');
 console.log('PASS APNG sniffing keeps still PNGs and retypes animated ones');
})().catch(error=>{console.error(error);process.exit(1);});

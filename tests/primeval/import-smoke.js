async function testFinishedImports({w,d,download,wait,check}){
 const $=id=>d.getElementById(id),count=()=>d.querySelectorAll('.job-status.done').length;
 const alerts=[],oldAlert=w.alert,NativeWorker=w.Worker;let workers=0;
 w.alert=message=>alerts.push(message);w.Worker=function(...args){workers++;return new NativeWorker(...args);};
 async function imported(action){const n=count();action();await wait(()=>count()>n||alerts.length);if(alerts.length)throw Error(alerts.join('\n'));check(count()===n+1,'import creates one finished job');}
 function drop(files,target=$('topbarStatus')){const data=new w.DataTransfer();for(const file of files)data.items.add(file);target.dispatchEvent(new w.DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}
 function paste(text,target=d.body){const data=new w.DataTransfer();data.setData('text/plain',text);const event=new w.ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});target.dispatchEvent(event);return event;}
 const cards=d.querySelectorAll('.job-card:has(.job-status.done)');cards[cards.length-1].querySelector('.job-actions button').click();
 const json=await(await download('btnExportJSON')).text(),css=await(await download('btnExportCSS')).text(),svg=await(await download('btnExportSVG')).text();
 const expected=JSON.parse(json);
 await imported(()=>drop([new w.File([json],'reopen.json',{type:'application/json'})]));
 const roundtrip=JSON.parse(await(await download('btnExportJSON')).text());
 check(roundtrip.elements.length===expected.elements.length,'JSON retains all shapes');
 check(roundtrip.elements.every((el,i)=>Math.abs(el.center.x-expected.elements[i].center.x)<1e-9&&Math.abs(el.center.y-expected.elements[i].center.y)<1e-9&&JSON.stringify(el.size)===JSON.stringify(expected.elements[i].size)&&el.packed_color===expected.elements[i].packed_color),'JSON geometry and game colours preserved');
 await imported(()=>paste(css));
 check(JSON.parse(await(await download('btnExportJSON')).text()).elements.length>=expected.elements.length,'pasted exported CSS reopens editable shapes');
 await imported(()=>drop([new w.File([svg],'reopen.svg',{type:'image/svg+xml'})],$('mainCanvas')));
 check(JSON.parse(await(await download('btnExportJSON')).text()).elements.length===expected.elements.length,'native exported SVG reopens all shapes');
 await imported(()=>paste(json));
 await imported(()=>paste(svg));
 await imported(()=>drop([new w.File([css],'reopen.css',{type:'text/css'})],$('exportFileName')));
 const editableJson=JSON.stringify({image_size:{width:40,height:40},config:{image_scale:1},origin:{x:20,y:-20},elements:[{type:'rectangle',center:{x:20,y:-20},relative:{x:0,y:0},size:{width:24,height:24},rotation:{z:0},color:'#3399ff',alpha:1}]});
 await imported(()=>paste(editableJson));
 check($('viewOriginal').hidden&&$('previewCompareHint').hidden&&$('showImage').parentElement.hidden&&!$('showImage').checked,'imported jobs show only the fitted preview without redundant Original controls');
 check(!$('previewCompare').hidden&&!$('viewFitted').hidden,'imported fitted preview remains available');
 await $('previewImg').decode();
 const importedThumb=$('previewImg').src,importedId=d.querySelectorAll('.job-card')[d.querySelectorAll('.job-card').length-1].dataset.jobId;
 const sample=d.createElement('canvas');sample.width=sample.height=1;sample.getContext('2d').drawImage($('previewImg'),0,0,1,1);
 check($('previewImg').naturalWidth===40&&sample.getContext('2d').getImageData(0,0,1,1).data[3]>0,'imported fitted thumbnail is populated with the current drawing');
 const fittedCard=d.querySelector('.job-card:has(.job-status.done)');fittedCard.querySelector('.job-actions button').click();
 check(!$('viewOriginal').hidden&&!$('showImage').parentElement.hidden,'fitted image jobs retain their genuine Original preview');
 $('showImage').checked=true;
 d.querySelector('[data-job-id="'+importedId+'"] .job-actions button').click();
 await $('previewImg').decode();
 check($('previewImg').src===importedThumb&&$('viewOriginal').hidden&&!$('showImage').checked,'switching jobs restores the imported thumbnail and clears stale source controls');
 $('viewOriginal').click();check($('viewFitted').getAttribute('aria-pressed')==='true','hidden Original cannot switch an imported job away from its drawing');
 const beforeDelete=JSON.parse(await(await download('btnExportJSON')).text()).elements.length;
 const canvas=$('mainCanvas'),rect=canvas.getBoundingClientRect();
 for(let i=0;i<2;i++)canvas.dispatchEvent(new w.MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
 check(!$('btnDeleteSel').disabled,'imported shape can be selected');$('btnDeleteSel').click();
 check(JSON.parse(await(await download('btnExportJSON')).text()).elements.length===beforeDelete-1,'imported shape can be deleted');$('btnUndo').click();
 check(JSON.parse(await(await download('btnExportJSON')).text()).elements.length===beforeDelete,'imported editing and undo retain shapes');
 $('clientLuaTemplateIndex').value='123';$('clientLuaTemplateIndex').dispatchEvent(new w.Event('input'));
 check((await(await download('btnExportClientLua')).text()).includes('root.enableMask=true'),'imported job exports packed masked Lua');
 for(const button of ['btnExportGIAOverlimit','btnExportClientGIAOverlimit','btnExportServerGIAOverlimit'])check((await download(button)).size>0,'imported job exports '+button);
 check((await download('btnExportPNG')).size>0&&(await download('btnExportSVG')).size>0,'imported job exports raster and vector');
 check(workers===0,'finished imports never start a fitting worker');
 const n=count();const typing=paste(json,$('exportFileName'));check(!typing.defaultPrevented&&count()===n,'text-field paste remains native');
 const beforeThumbs=d.querySelectorAll('.file-thumb').length;
 const blob=await(await fetch('fixtures/input.png')).blob();drop([new w.File([blob],'anywhere.png',{type:'image/png'})],d.body);
 check(d.querySelectorAll('.file-thumb').length===beforeThumbs+1&&$('viewUpload').classList.contains('active'),'raster file dropped outside upload zone becomes input image');
 const data=new w.DataTransfer();data.items.add(new w.File([blob],'overlay.png',{type:'image/png'}));
 d.body.dispatchEvent(new w.DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));check(!$('inputDropOverlay').hidden,'whole-page file drag shows overlay');
 d.body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check($('inputDropOverlay').hidden,'Escape clears drop overlay');
 drop([new w.File([blob],'conversion-zone.png',{type:'image/png'})],$('classicDropZone'));
 check(d.querySelectorAll('.file-thumb').length===beforeThumbs+2,'images also import from the conversion drop zone');

 for(const bad of [new w.File(['{"elements":[]}'],'invalid.json',{type:'application/json'}),new w.File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>window.importExecuted=true</script></svg>'],'unsafe.svg',{type:'image/svg+xml'}),new w.File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0 L10 10"/></svg>'],'path.svg',{type:'image/svg+xml'})]){
  const before=count(),errorCount=alerts.length;drop([bad]);await wait(()=>alerts.length>errorCount);check(count()===before,'unsupported or malformed file creates no partial job');
 }
 check(!w.importExecuted,'imported SVG scripts never execute');
 w.alert=oldAlert;w.Worker=NativeWorker;
}

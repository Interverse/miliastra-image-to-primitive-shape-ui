/* Locate the live static site whether tests are at root or in the ignored archive. */
const fs=require('node:fs'),path=require('node:path');
let folder=__dirname;
while(!fs.existsSync(path.join(folder,'index.html'))||!fs.existsSync(path.join(folder,'js/app.js'))){
  const parent=path.dirname(folder);if(parent===folder)throw Error('Could not locate the website root');folder=parent;
}
module.exports=folder;

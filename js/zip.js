/*
 * zip.js — minimal ZIP (STORE method) writer for "download all outputs".
 * Existing synchronous downloads use STORE; async frame exports use DEFLATE.
 */
"use strict";

const MiniZip = (() => {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, day };
  }

  /* files: [{name: string, data: Uint8Array}] → Blob */
  function build(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data instanceof Blob || file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const storedLength=data instanceof Blob?data.size:data.length,rawLength=file.rawLength??storedLength,method=file.method??0;
      if(data instanceof Blob&&file.crc===undefined)throw TypeError('Blob entries require a CRC.');
      const crc = file.crc??crc32(data);
      if(files.length>65535||nameBytes.length>65535||!Number.isSafeInteger(rawLength)||rawLength<0||rawLength>0xffffffff||storedLength>0xffffffff||offset+30+nameBytes.length+storedLength>0xffffffff)throw Error('ZIP size limit exceeded; no frames were removed.');

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);           // version needed
      local.setUint16(6, 0x0800, true);       // UTF-8 names
      local.setUint16(8, method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, storedLength, true);
      local.setUint32(22, rawLength, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, method, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, day, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, storedLength, true);
      cd.setUint32(24, rawLength, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + storedLength;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    if(offset+centralSize+22>0xffffffff)throw Error('ZIP size limit exceeded; no frames were removed.');

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  async function buildAsync(files,{signal,onProgress}={}){
    const prepared=[];
    for await(const file of files){
      signal?.throwIfAborted();const raw=file.data;let compressor=null;
      if(typeof CompressionStream!=='undefined'){try{compressor=new CompressionStream('deflate-raw');}catch{ /* Older browsers retain STORE. */ }}
      const data=compressor?await new Response(new Blob([raw]).stream().pipeThrough(compressor)).blob():new Blob([raw]);
      signal?.throwIfAborted();prepared.push({name:file.name,data,rawLength:raw.length,crc:crc32(raw),method:compressor?8:0});onProgress?.(prepared.length);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    signal?.throwIfAborted();return build(prepared);
  }
  return { build, buildAsync, crc32 };
})();
if(typeof module!=='undefined')module.exports=MiniZip;

/*
 * protoscan.js — minimal, independent protobuf reader for the .gia tests.
 *
 * Deliberately does NOT reuse js/gia.js internals: a component whose bytes
 * are compared against the reference should be read back by code that the
 * writer cannot influence.
 */
"use strict";

function readVarint(data, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= data.length) throw new Error("eof in varint");
    const b = data[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
}

function parse(data) {
  const fields = [];
  let pos = 0;
  while (pos < data.length) {
    const [key, p1] = readVarint(data, pos);
    pos = p1;
    const tag = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(data, pos);
      pos = p2;
      fields.push({ tag, wire, value: v });
    } else if (wire === 2) {
      const [len, p2] = readVarint(data, pos);
      pos = p2;
      fields.push({ tag, wire, data: data.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      fields.push({ tag, wire, raw: data.subarray(pos, pos + 4) });
      pos += 4;
    } else if (wire === 1) {
      fields.push({ tag, wire, raw: data.subarray(pos, pos + 8) });
      pos += 8;
    } else {
      throw new Error("wire " + wire);
    }
  }
  return fields;
}

const firstBytes = (fields, tag) => {
  const f = fields.find((x) => x.tag === tag && x.wire === 2);
  return f ? f.data : null;
};
const firstVarint = (fields, tag) => {
  const f = fields.find((x) => x.tag === tag && x.wire === 0);
  return f ? f.value : null;
};

function rootFields(giaBytes) {
  const data =
    giaBytes instanceof Uint8Array ? giaBytes : new Uint8Array(giaBytes);
  const contentLen =
    (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
  return parse(data.subarray(20, 20 + contentLen));
}

/* All resource records (primary + entries) as {name, class, bytes}. */
function resources(giaBytes) {
  const out = [];
  for (const f of rootFields(giaBytes)) {
    if ((f.tag !== 1 && f.tag !== 2) || f.wire !== 2) continue;
    const rf = parse(f.data);
    const nameBytes = firstBytes(rf, 3);
    out.push({
      primary: f.tag === 1,
      name: nameBytes ? Buffer.from(nameBytes).toString("utf8") : "",
      class: firstVarint(rf, 5),
      fields: rf,
      bytes: f.data,
    });
  }
  return out;
}

/* Raw bytes of one 505 component record, selected by its slot (field 501). */
function componentBytes(giaBytes, resourceName, slot) {
  const res = resources(giaBytes).find((r) => r.name === resourceName);
  if (!res) return null;
  const ui = firstBytes(res.fields, 19);
  if (!ui) return null;
  const content = firstBytes(parse(ui), 1);
  if (!content) return null;
  for (const f of parse(content)) {
    if (f.tag !== 505 || f.wire !== 2) continue;
    if (firstVarint(parse(f.data), 501) === slot) return f.data;
  }
  return null;
}

module.exports = { parse, readVarint, rootFields, resources, componentBytes };

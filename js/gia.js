/*
 * gia.js — Browser/Node port of the Python GIA (binary protobuf-like) writer.
 *
 * Ported byte-for-byte from:
 *   gia/json_to_gia_reconstructed.py   (convert_json_to_gia_bytes)
 *   gia/convert_to_classic.py          (convert_gia_bytes_to_classic)
 *   gia/convert_to_overlimit.py        (convert_gia_bytes_to_overlimit)
 *
 * Public API (global GIA, also module.exports in Node):
 *   GIA.convertJsonToGiaBytes(jsonData, baseGiaBytes, mode) -> Uint8Array
 *   GIA.toClassic(bytes)   -> Uint8Array
 *   GIA.toOverlimit(bytes) -> Uint8Array
 *   GIA.MODE_DECORATION, GIA.MODE_IMAGE
 *
 * All byte buffers are Uint8Array. Inputs are never mutated.
 */
var GIA = (function () {
  "use strict";

  var MODE_DECORATION = "decoration";
  var MODE_IMAGE = "image";

  var DEFAULT_IMAGE_ASSET_REFS = {
    rectangle: 100001,
    ellipse: 100002,
    triangle: 100003,
    four_point_star: 100004,
    five_point_star: 100005,
  };

  var WireType = {
    VARINT: 0,
    FIXED64: 1,
    LENGTH_DELIMITED: 2,
    START_GROUP: 3,
    END_GROUP: 4,
    FIXED32: 5,
  };

  // The uint64 sentinel written in image_settings.source_meta. Needs BigInt.
  var SENTINEL_U64 = 18446744073709551615n; // 2**64 - 1
  var TWO_POW_64 = 18446744073709551616n; // 2**64

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  var _floatBuf = new ArrayBuffer(4);
  var _floatView = new DataView(_floatBuf);
  var _utf8 = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  function encodeUtf8(str) {
    if (_utf8) return _utf8.encode(str);
    // Node fallback (older) — Buffer is a Uint8Array subclass.
    return Uint8Array.from(Buffer.from(str, "utf-8"));
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    return Buffer.from(bytes).toString("utf-8");
  }

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (Array.isArray(input)) return Uint8Array.from(input);
    throw new TypeError("Expected Uint8Array/ArrayBuffer");
  }

  // Python dict.get(key, default)
  function get(obj, key, def) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    return def;
  }

  // Python truthiness (empty dict / empty list / "" / 0 / None -> false)
  function pyTruthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (v === 0 || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return !!v;
  }

  // Python `a or b or c` — returns first truthy, else last.
  function pyOr() {
    for (var i = 0; i < arguments.length; i++) {
      if (pyTruthy(arguments[i])) return arguments[i];
    }
    return arguments[arguments.length - 1];
  }

  // Python round(): round-half-to-even, on the float value.
  function pyRound(x) {
    var fl = Math.floor(x);
    var frac = x - fl;
    if (frac < 0.5) return fl;
    if (frac > 0.5) return fl + 1;
    // exactly .5 -> round to even
    return fl % 2 === 0 ? fl : fl + 1;
  }

  // unsigned 32-bit modulo (mirror Python `x & 0xFFFFFFFF`)
  function u32(x) {
    var r = x % 4294967296;
    if (r < 0) r += 4294967296;
    return r;
  }

  function toBytesBE4(value) {
    // value fits in 32 bits (file sizes / lengths)
    return [
      Math.floor(value / 16777216) & 255,
      Math.floor(value / 65536) & 255,
      Math.floor(value / 256) & 255,
      value & 255,
    ];
  }

  function intFromBytesBE(bytes, start, len) {
    var v = 0;
    for (var i = 0; i < len; i++) {
      v = v * 256 + bytes[start + i];
    }
    return v;
  }

  // ------------------------------------------------------------------
  // ProtoReader
  // ------------------------------------------------------------------

  function ProtoReader(data) {
    this.data = data; // Uint8Array
    this.pos = 0;
  }
  ProtoReader.prototype.read_varint = function () {
    // Values here never exceed 2**53 for anything re-emitted from templates.
    var result = 0;
    var shift = 0;
    while (true) {
      if (this.pos >= this.data.length) {
        throw new RangeError("End of data while reading varint");
      }
      var byte = this.data[this.pos];
      this.pos += 1;
      // Use multiplication to stay safe past 32 bits.
      result += (byte & 127) * Math.pow(2, shift);
      if (!(byte & 128)) return result;
      shift += 7;
    }
  };
  ProtoReader.prototype.read_fixed32 = function () {
    if (this.pos + 4 > this.data.length) {
      throw new RangeError("End of data while reading fixed32");
    }
    var val = this.data.subarray(this.pos, this.pos + 4);
    this.pos += 4;
    return val;
  };
  ProtoReader.prototype.read_fixed64 = function () {
    if (this.pos + 8 > this.data.length) {
      throw new RangeError("End of data while reading fixed64");
    }
    var val = this.data.subarray(this.pos, this.pos + 8);
    this.pos += 8;
    return val;
  };
  ProtoReader.prototype.read_length_delimited = function () {
    var length = this.read_varint();
    if (this.pos + length > this.data.length) {
      throw new RangeError("End of data while reading length delimited");
    }
    var val = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return val;
  };
  ProtoReader.prototype.eof = function () {
    return this.pos >= this.data.length;
  };
  ProtoReader.prototype.read_tag = function () {
    if (this.eof()) return [null, null];
    var val = this.read_varint();
    var field_id = Math.floor(val / 8);
    var wire_type = val & 7;
    return [field_id, wire_type];
  };
  ProtoReader.prototype.read_field = function (wire_type) {
    if (wire_type === WireType.VARINT) return this.read_varint();
    if (wire_type === WireType.FIXED64) return this.read_fixed64();
    if (wire_type === WireType.LENGTH_DELIMITED)
      return this.read_length_delimited();
    if (wire_type === WireType.FIXED32) return this.read_fixed32();
    throw new Error("Unsupported wire type: " + wire_type);
  };

  // ------------------------------------------------------------------
  // ProtoWriter
  // ------------------------------------------------------------------

  function ProtoWriter() {
    this.buffer = []; // array of byte ints
  }
  ProtoWriter.prototype.extend = function (bytes) {
    var b = this.buffer;
    for (var i = 0; i < bytes.length; i++) b.push(bytes[i]);
  };
  ProtoWriter.prototype.write_varint = function (value) {
    var b = this.buffer;
    if (typeof value === "bigint") {
      var v = value;
      while (true) {
        var byte = Number(v & 127n);
        v >>= 7n;
        if (v !== 0n) b.push(byte | 128);
        else {
          b.push(byte);
          return;
        }
      }
    }
    // number path (non-negative integer, may exceed 2**31)
    var n = value;
    while (true) {
      var bt = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b.push(bt | 128);
      else {
        b.push(bt);
        return;
      }
    }
  };
  ProtoWriter.prototype.write_tag = function (field_id, wire_type) {
    this.write_varint(field_id * 8 + wire_type);
  };
  ProtoWriter.prototype.write_int32 = function (field_id, value) {
    this.write_tag(field_id, WireType.VARINT);
    if (typeof value === "bigint") {
      var bv = value;
      if (bv < 0n) bv += TWO_POW_64;
      this.write_varint(bv);
      return;
    }
    if (value < 0) {
      this.write_varint(BigInt(value) + TWO_POW_64);
    } else {
      this.write_varint(value);
    }
  };
  ProtoWriter.prototype.write_int64 = ProtoWriter.prototype.write_int32;
  ProtoWriter.prototype.write_bool = function (field_id, value) {
    this.write_tag(field_id, WireType.VARINT);
    this.write_varint(value ? 1 : 0);
  };
  ProtoWriter.prototype.write_float = function (field_id, value) {
    this.write_tag(field_id, WireType.FIXED32);
    _floatView.setFloat32(0, value, true);
    this.buffer.push(
      _floatView.getUint8(0),
      _floatView.getUint8(1),
      _floatView.getUint8(2),
      _floatView.getUint8(3)
    );
  };
  ProtoWriter.prototype.write_string = function (field_id, value) {
    var encoded = encodeUtf8(value);
    this.write_tag(field_id, WireType.LENGTH_DELIMITED);
    this.write_varint(encoded.length);
    this.extend(encoded);
  };
  ProtoWriter.prototype.write_bytes = function (field_id, value) {
    this.write_tag(field_id, WireType.LENGTH_DELIMITED);
    this.write_varint(value.length);
    this.extend(value);
  };
  ProtoWriter.prototype.write_message = function (field_id, writer) {
    var data = writer.buffer;
    this.write_tag(field_id, WireType.LENGTH_DELIMITED);
    this.write_varint(data.length);
    this.extend(data);
  };
  ProtoWriter.prototype.get_bytes = function () {
    return Uint8Array.from(this.buffer);
  };

  // ------------------------------------------------------------------
  // Parsers
  // ------------------------------------------------------------------

  function parse_resource_entry(data) {
    var reader = new ProtoReader(data);
    var info = { class: 0, guid: 0, name: "" };
    while (!reader.eof()) {
      var t = reader.read_tag();
      var tag = t[0],
        wire = t[1];
      if (tag === null) return info;
      var val = reader.read_field(wire);
      if (tag === 5 && wire === WireType.VARINT) {
        info["class"] = val;
      } else if (tag === 3 && wire === WireType.LENGTH_DELIMITED) {
        info["name"] = decodeUtf8(val);
      } else if (tag === 1 && wire === WireType.LENGTH_DELIMITED) {
        var sub = new ProtoReader(val);
        while (!sub.eof()) {
          var st = sub.read_tag();
          var sub_tag = st[0],
            sub_wire = st[1];
          var sub_val = sub.read_field(sub_wire);
          if (sub_tag === 4 && sub_wire === WireType.VARINT) {
            info["guid"] = sub_val;
          }
        }
      }
    }
    return info;
  }

  function parse_primary_resource(data) {
    var reader = new ProtoReader(data);
    var fields = [];
    while (!reader.eof()) {
      var t = reader.read_tag();
      var tag = t[0],
        wire = t[1];
      if (tag === null) return fields;
      if (wire === WireType.LENGTH_DELIMITED) {
        var length = reader.read_varint();
        var content = reader.data.subarray(reader.pos, reader.pos + length);
        reader.pos += length;
        fields.push({ tag: tag, wire: wire, data: content });
      } else if (wire === WireType.VARINT) {
        var v = reader.read_varint();
        fields.push({ tag: tag, wire: wire, value: v });
      } else if (wire === WireType.FIXED32) {
        fields.push({ tag: tag, wire: wire, raw: reader.read_fixed32() });
      } else if (wire === WireType.FIXED64) {
        fields.push({ tag: tag, wire: wire, raw: reader.read_fixed64() });
      }
    }
    return fields;
  }

  function check_locator_guid(data) {
    var reader = new ProtoReader(data);
    while (!reader.eof()) {
      var t = reader.read_tag();
      var tag = t[0],
        wire = t[1];
      var val = reader.read_field(wire);
      if (tag === 4 && wire === WireType.VARINT) return val;
    }
    return 0;
  }

  function parse_message_fields(data) {
    var reader = new ProtoReader(data);
    var fields = [];
    while (!reader.eof()) {
      var t = reader.read_tag();
      var tag = t[0],
        wire = t[1];
      if (tag === null) return fields;
      if (wire === WireType.LENGTH_DELIMITED) {
        var length = reader.read_varint();
        var content = reader.data.subarray(reader.pos, reader.pos + length);
        reader.pos += length;
        fields.push({ tag: tag, wire: wire, data: content });
      } else if (wire === WireType.VARINT) {
        fields.push({ tag: tag, wire: wire, value: reader.read_varint() });
      } else if (wire === WireType.FIXED32) {
        fields.push({ tag: tag, wire: wire, raw: reader.read_fixed32() });
      } else if (wire === WireType.FIXED64) {
        fields.push({ tag: tag, wire: wire, raw: reader.read_fixed64() });
      }
    }
    return fields;
  }

  function build_message(fields) {
    var writer = new ProtoWriter();
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var tag = f.tag;
      var wire = f.wire;
      if (wire === WireType.LENGTH_DELIMITED) {
        var data = f.data;
        writer.write_tag(tag, WireType.LENGTH_DELIMITED);
        writer.write_varint(data.length);
        writer.extend(data);
      } else if (wire === WireType.VARINT) {
        writer.write_tag(tag, WireType.VARINT);
        writer.write_varint(f.value);
      } else if (wire === WireType.FIXED32) {
        writer.write_tag(tag, WireType.FIXED32);
        writer.extend(f.raw);
      } else if (wire === WireType.FIXED64) {
        writer.write_tag(tag, WireType.FIXED64);
        writer.extend(f.raw);
      }
    }
    return writer.get_bytes();
  }

  function encode_packed_varints(values) {
    var w = new ProtoWriter();
    for (var i = 0; i < values.length; i++) {
      w.write_varint(Math.trunc(values[i]));
    }
    return w.get_bytes();
  }

  function patch_prefab_guid_list(prefab_bytes, decoration_guids) {
    var prefab_fields = parse_message_fields(prefab_bytes);
    for (var a = 0; a < prefab_fields.length; a++) {
      var pf = prefab_fields[a];
      if (pf.tag !== 1 || pf.wire !== WireType.LENGTH_DELIMITED) continue;
      var inner_fields = parse_message_fields(pf.data);
      for (var b = 0; b < inner_fields.length; b++) {
        var inner_f = inner_fields[b];
        if (inner_f.wire !== WireType.LENGTH_DELIMITED) continue;
        var comp_fields = parse_message_fields(inner_f.data);
        var component_id = null;
        var payload_50 = null;
        for (var c = 0; c < comp_fields.length; c++) {
          var cf = comp_fields[c];
          if (cf.tag === 1 && cf.wire === WireType.VARINT) component_id = cf.value;
          if (cf.tag === 50 && cf.wire === WireType.LENGTH_DELIMITED)
            payload_50 = cf;
        }
        if (component_id !== 40 || payload_50 === null) continue;
        var p50_fields = parse_message_fields(payload_50.data);
        for (var d = 0; d < p50_fields.length; d++) {
          var p50_f = p50_fields[d];
          if (p50_f.tag === 501 && p50_f.wire === WireType.LENGTH_DELIMITED) {
            p50_f.data = encode_packed_varints(decoration_guids);
            payload_50.data = build_message(p50_fields);
            inner_f.data = build_message(comp_fields);
            pf.data = build_message(inner_fields);
            return build_message(prefab_fields);
          }
        }
      }
    }
    return prefab_bytes;
  }

  // ------------------------------------------------------------------
  // Decoration payload builders
  // ------------------------------------------------------------------

  function create_decoration_payload(
    guid,
    name,
    type_id,
    parent_guid,
    pos,
    scale,
    rot_z,
    rot_y
  ) {
    if (rot_z === undefined) rot_z = 0.0;
    if (rot_y === undefined) rot_y = 0.0;

    var inner = new ProtoWriter();
    inner.write_int64(1, guid);
    inner.write_int64(2, type_id);
    inner.write_int32(3, 1);

    var c4_name = new ProtoWriter();
    c4_name.write_int32(1, 1);
    var p11 = new ProtoWriter();
    p11.write_string(1, name);
    c4_name.write_message(11, p11);
    inner.write_message(4, c4_name);

    var c4_parent = new ProtoWriter();
    c4_parent.write_int32(1, 40);
    var p50 = new ProtoWriter();
    var map_entry = new ProtoWriter();
    map_entry.write_int32(1, 502);
    map_entry.write_int64(2, parent_guid);
    p50.write_message(502, map_entry);
    c4_parent.write_message(50, p50);
    inner.write_message(4, c4_parent);

    var c5_trans = new ProtoWriter();
    c5_trans.write_int32(1, 1);
    var p11_trans = new ProtoWriter();

    var vec_pos = new ProtoWriter();
    vec_pos.write_float(1, pos["x"]);
    vec_pos.write_float(2, pos["y"]);
    vec_pos.write_float(3, 0.0);
    p11_trans.write_message(1, vec_pos);

    rot_z = Number(pyOr(rot_z, 0.0));
    rot_y = Number(pyOr(rot_y, 0.0));

    if (Math.abs(rot_z) < 1e-6 && Math.abs(rot_y) < 1e-6) {
      p11_trans.write_bytes(2, new Uint8Array(0));
    } else {
      var vec_rot = new ProtoWriter();
      vec_rot.write_float(3, rot_z);
      vec_rot.write_float(2, rot_y);
      p11_trans.write_message(2, vec_rot);
    }

    var vec_scale = new ProtoWriter();
    vec_scale.write_float(1, scale["x"]);
    vec_scale.write_float(2, scale["y"]);
    vec_scale.write_float(3, 1.0);
    p11_trans.write_message(3, vec_scale);

    c5_trans.write_message(11, p11_trans);
    inner.write_message(5, c5_trans);

    var c5_active = new ProtoWriter();
    c5_active.write_int32(1, 5);
    var p15 = new ProtoWriter();
    p15.write_int32(1, 1);
    p15.write_int32(2, 1);
    c5_active.write_message(15, p15);
    inner.write_message(5, c5_active);

    var c5_unk = new ProtoWriter();
    c5_unk.write_int32(1, 2);
    if (type_id === 10005009) {
      var p12 = new ProtoWriter();
      p12.write_bytes(2, new Uint8Array([0x08, 0xea, 0x90, 0xd8, 0x2f]));
      c5_unk.write_message(12, p12);
    } else {
      c5_unk.write_message(12, new ProtoWriter());
    }
    inner.write_message(5, c5_unk);

    inner.write_message(11, new ProtoWriter());

    var decor_def = new ProtoWriter();
    decor_def.write_message(1, inner);
    return decor_def;
  }

  function create_resource_entry_stub(guid, name, decoration_payload) {
    var entry = new ProtoWriter();
    var ident = new ProtoWriter();
    ident.write_int32(2, 1);
    ident.write_int32(3, 14);
    ident.write_int64(4, guid);
    entry.write_message(1, ident);
    entry.write_string(3, name);
    entry.write_int32(5, 28);
    entry.write_message(21, decoration_payload);
    return entry;
  }

  function create_reference_locator(guid, kind) {
    if (kind === undefined) kind = 14;
    var loc = new ProtoWriter();
    loc.write_int32(2, 1);
    loc.write_int32(3, kind);
    loc.write_int64(4, guid);
    return loc;
  }

  // ------------------------------------------------------------------
  // Image payload builders
  // ------------------------------------------------------------------

  function _build_asset_info(guid) {
    var info = new ProtoWriter();
    info.write_int32(2, 1);
    info.write_int32(3, 8);
    info.write_int64(4, guid);
    return info;
  }

  function _find_varint(fields, tag, def) {
    if (def === undefined) def = null;
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (field.tag === tag && field.wire === WireType.VARINT)
        return field.value;
    }
    return def;
  }

  function _build_vector3(x, y, z) {
    var w = new ProtoWriter();
    w.write_float(1, x);
    w.write_float(2, y);
    w.write_float(3, z);
    return w;
  }

  function _build_vector2(x, y) {
    var w = new ProtoWriter();
    w.write_float(501, x);
    w.write_float(502, y);
    return w;
  }

  function _build_rotation(z_angle) {
    if (Math.abs(z_angle) < 1e-6) return new ProtoWriter();
    var w = new ProtoWriter();
    w.write_float(3, z_angle);
    return w;
  }

  function _build_rect_transform(
    offset_x,
    offset_y,
    size_x,
    size_y,
    pivot_x,
    pivot_y,
    rot_z
  ) {
    var w = new ProtoWriter();
    w.write_message(501, _build_vector3(1.0, 1.0, 1.0));
    w.write_message(502, _build_vector2(0.5, 0.5));
    w.write_message(503, _build_vector2(0.5, 0.5));
    w.write_message(504, _build_vector2(offset_x, offset_y));
    w.write_message(505, _build_vector2(size_x, size_y));
    w.write_message(506, _build_vector2(pivot_x, pivot_y));
    w.write_message(508, _build_rotation(rot_z));
    return w;
  }

  function _build_platform(
    platform_type,
    offset_x,
    offset_y,
    size_x,
    size_y,
    pivot_x,
    pivot_y,
    rot_z
  ) {
    var w = new ProtoWriter();
    w.write_int32(501, platform_type);
    w.write_message(
      502,
      _build_rect_transform(
        offset_x,
        offset_y,
        size_x,
        size_y,
        pivot_x,
        pivot_y,
        rot_z
      )
    );
    return w;
  }

  function _build_multi_platform(
    offset_x,
    offset_y,
    size_x,
    size_y,
    pivot_x,
    pivot_y,
    rot_z
  ) {
    var w = new ProtoWriter();
    for (var pt = 0; pt < 4; pt++) {
      w.write_message(
        501,
        _build_platform(
          pt,
          offset_x,
          offset_y,
          size_x,
          size_y,
          pivot_x,
          pivot_y,
          rot_z
        )
      );
    }
    w.write_int32(502, 9);
    w.write_int32(504, 1);
    return w;
  }

  function _build_transform_data(
    offset_x,
    offset_y,
    size_x,
    size_y,
    guid,
    pivot_x,
    pivot_y,
    rot_z
  ) {
    var w = new ProtoWriter();
    var builtin = new ProtoWriter();
    var builtin_empty_mp = new ProtoWriter();
    builtin.write_message(12, builtin_empty_mp);
    builtin.write_int32(501, 2);
    w.write_message(11, builtin);

    var details = new ProtoWriter();
    var details_transform = new ProtoWriter();
    details_transform.write_message(
      12,
      _build_multi_platform(
        offset_x,
        offset_y,
        size_x,
        size_y,
        pivot_x,
        pivot_y,
        rot_z
      )
    );
    details_transform.write_int32(501, 2);
    details.write_message(13, details_transform);
    details.write_int32(501, 4);
    details.write_int32(502, 12);
    details.write_int32(503, 1);
    details.write_message(504, _build_asset_info(guid));
    w.write_message(503, details);
    w.write_int32(501, 1);
    w.write_int32(502, 12);
    return w;
  }

  function _build_field14_data(guid) {
    var w = new ProtoWriter();
    var field14_inner = new ProtoWriter();
    field14_inner.write_bytes(15, new Uint8Array(0));
    field14_inner.write_int32(501, 5);
    w.write_message(14, field14_inner);
    w.write_int32(501, 4);
    w.write_int32(502, 23);

    var details = new ProtoWriter();
    var details_field14 = new ProtoWriter();
    details_field14.write_bytes(15, new Uint8Array(0));
    details_field14.write_int32(501, 5);
    details.write_message(14, details_field14);
    details.write_int32(501, 5);
    details.write_int32(502, 23);
    details.write_int32(503, 1);
    details.write_message(504, _build_asset_info(guid));
    w.write_message(503, details);
    return w;
  }

  function _build_image_settings_data(image_asset_ref, packed_color, guid) {
    var w = new ProtoWriter();
    w.write_bytes(31, new Uint8Array(0));
    w.write_int32(501, 21);
    w.write_int32(502, 38);

    var details = new ProtoWriter();
    var img_settings = new ProtoWriter();
    img_settings.write_int32(2, image_asset_ref);
    var source_meta = new ProtoWriter();
    source_meta.write_int64(501, SENTINEL_U64);
    img_settings.write_message(3, source_meta);
    img_settings.write_int32(4, packed_color);
    img_settings.write_bytes(6, new Uint8Array(0));
    img_settings.write_bytes(10, new Uint8Array(0));
    details.write_message(31, img_settings);
    details.write_int32(501, 22);
    details.write_int32(502, 38);
    details.write_int32(503, 1);
    details.write_message(504, _build_asset_info(guid));
    w.write_message(503, details);
    return w;
  }

  function _build_mask_settings_data(
    position_x,
    position_y,
    size_x,
    size_y,
    shape_type,
    enabled,
    guid
  ) {
    var w = new ProtoWriter();
    w.write_bytes(46, new Uint8Array(0));
    w.write_int32(501, 38);
    w.write_int32(502, 56);

    var details = new ProtoWriter();
    var mask_settings = new ProtoWriter();
    mask_settings.write_message(1, _build_vector2(position_x, position_y));
    mask_settings.write_message(2, _build_vector2(size_x, size_y));
    mask_settings.write_int32(3, Math.trunc(shape_type));
    mask_settings.write_bool(4, !!enabled);
    details.write_message(47, mask_settings);
    details.write_int32(501, 40);
    details.write_int32(502, 56);
    details.write_int32(503, 1);
    details.write_message(504, _build_asset_info(guid));
    w.write_message(503, details);
    return w;
  }

  function _build_name_data(name) {
    if (name === undefined) name = "";
    var w = new ProtoWriter();
    var name_inner = new ProtoWriter();
    if (name) {
      name_inner.write_string(501, name);
    }
    w.write_message(12, name_inner);
    w.write_int32(501, 2);
    w.write_int32(502, 15);
    return w;
  }

  // ------------------------------------------------------------------
  // Normalizers
  // ------------------------------------------------------------------

  // Mirror ntpath.basename / splitext just enough for group names.
  function _ntBasename(p) {
    // Strip drive (e.g. "C:")
    var rest = p;
    if (rest.length >= 2 && rest.charAt(1) === ":") {
      rest = rest.slice(2);
    }
    var idx = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
    return idx >= 0 ? rest.slice(idx + 1) : rest;
  }

  function _splitextStem(base) {
    // os.path.splitext: ext begins at the last dot that is not a leading dot.
    var i = base.length - 1;
    var lastDot = -1;
    while (i >= 0) {
      if (base.charAt(i) === ".") {
        lastDot = i;
        break;
      }
      i--;
    }
    if (lastDot <= 0) return base; // no dot, or leading-dot only
    // ensure not all leading dots before it
    var j = 0;
    while (j < base.length && base.charAt(j) === ".") j++;
    if (lastDot < j) return base;
    return base.slice(0, lastDot);
  }

  function _pyStrip(s) {
    // Python str.strip() — strips ASCII + common unicode whitespace.
    // JS trim covers the standard cases used here.
    return s.replace(/^\s+/, "").replace(/\s+$/, "");
  }

  function _normalize_group_name(name, fallback) {
    if (fallback === undefined) fallback = "素材组";
    if (typeof name !== "string") return fallback;
    var raw = _pyStrip(name);
    if (!raw) return fallback;
    var base_name = _ntBasename(raw);
    var stem = _splitextStem(base_name);
    var normalized = _pyStrip(stem) || _pyStrip(base_name);
    return normalized || fallback;
  }

  function _order_elements_for_image_mode(elements) {
    var foreground = [];
    var background = [];
    var list = elements || [];
    for (var i = 0; i < list.length; i++) {
      var element = list[i];
      if (get(element, "is_background", undefined)) {
        background.push(element);
      } else {
        foreground.push(element);
      }
    }
    var reversed = foreground.slice().reverse();
    return background.concat(reversed);
  }

  // Identical algorithm to _order_elements_for_image_mode (mirrors the Python).
  var _storage_order_elements_for_image_mode = _order_elements_for_image_mode;

  function create_ui_image_payload(opts) {
    var guid = opts.guid;
    var index = opts.index;
    var parent_guid = opts.parent_guid;
    var offset_x = opts.offset_x;
    var offset_y = opts.offset_y;
    var size_x = opts.size_x;
    var size_y = opts.size_y;
    var image_asset_ref =
      opts.image_asset_ref === undefined ? 100002 : opts.image_asset_ref;
    var packed_color =
      opts.packed_color === undefined ? 2164260863 : opts.packed_color;
    var rot_z = opts.rot_z === undefined ? 0.0 : opts.rot_z;
    var pivot_x = opts.pivot_x === undefined ? 0.5 : opts.pivot_x;
    var pivot_y = opts.pivot_y === undefined ? 0.5 : opts.pivot_y;
    var name = opts.name === undefined ? "" : opts.name;

    var content = new ProtoWriter();
    content.write_int64(501, guid);

    var info_guid = new ProtoWriter();
    var guid_wrapper = new ProtoWriter();
    guid_wrapper.write_int64(501, guid);
    info_guid.write_message(11, guid_wrapper);
    info_guid.write_int32(501, 1);
    info_guid.write_int32(502, 5);
    content.write_message(502, info_guid);

    var info_index = new ProtoWriter();
    var index_wrapper = new ProtoWriter();
    index_wrapper.write_int32(501, index);
    info_index.write_message(12, index_wrapper);
    info_index.write_int32(501, 2);
    info_index.write_int32(502, 6);
    content.write_message(502, info_index);

    content.write_int64(504, parent_guid);
    content.write_message(505, _build_name_data(name));
    content.write_message(505, _build_field14_data(guid));
    content.write_message(
      505,
      _build_transform_data(
        offset_x,
        offset_y,
        size_x,
        size_y,
        guid,
        pivot_x,
        pivot_y,
        rot_z
      )
    );
    content.write_message(
      505,
      _build_image_settings_data(image_asset_ref, packed_color, guid)
    );
    return content;
  }

  function create_ui_image_entry(guid, name, ui_content_payload) {
    var entry = new ProtoWriter();
    var ident = new ProtoWriter();
    ident.write_int32(2, 1);
    ident.write_int32(3, 8);
    ident.write_int64(4, guid);
    entry.write_message(1, ident);
    entry.write_int32(5, 15);
    var ui = new ProtoWriter();
    ui.write_message(1, ui_content_payload);
    entry.write_message(19, ui);
    return entry;
  }

  // ------------------------------------------------------------------
  // GIA root parse / rebuild
  // ------------------------------------------------------------------

  function _parse_gia_root_fields(file_data) {
    var header = file_data.subarray(0, 20);
    var content_len = intFromBytesBE(header, 16, 4);
    var content = file_data.subarray(20, 20 + content_len);
    var tail = file_data.subarray(20 + content_len, 24 + content_len);
    var reader = new ProtoReader(content);
    var root_fields = [];
    while (!reader.eof()) {
      var t = reader.read_tag();
      var tag = t[0],
        wire = t[1];
      if (tag === null) break;
      if (wire === WireType.LENGTH_DELIMITED) {
        root_fields.push([tag, wire, reader.read_length_delimited()]);
      } else if (wire === WireType.VARINT) {
        root_fields.push([tag, wire, reader.read_varint()]);
      } else if (wire === WireType.FIXED32) {
        root_fields.push([tag, wire, reader.read_fixed32()]);
      } else if (wire === WireType.FIXED64) {
        root_fields.push([tag, wire, reader.read_fixed64()]);
      }
    }
    return { header: header, content_len: content_len, root_fields: root_fields, tail: tail };
  }

  function _isBytes(v) {
    return v instanceof Uint8Array;
  }

  function _rebuild_gia(
    header,
    content_len,
    root_fields,
    tail,
    new_entries,
    pr_writer_bytes,
    removed_class
  ) {
    var final_bundle = new ProtoWriter();
    final_bundle.write_tag(1, WireType.LENGTH_DELIMITED);
    final_bundle.write_varint(pr_writer_bytes.length);
    final_bundle.extend(pr_writer_bytes);

    for (var i = 0; i < root_fields.length; i++) {
      var tag = root_fields[i][0];
      var val = root_fields[i][2];
      if (tag === 2) {
        if (_isBytes(val)) {
          var info = parse_resource_entry(val);
          if (info["class"] !== removed_class) {
            final_bundle.write_tag(2, WireType.LENGTH_DELIMITED);
            final_bundle.write_varint(val.length);
            final_bundle.extend(val);
          }
        }
      } else if (tag !== 1 && tag !== 2) {
        if (_isBytes(val)) {
          final_bundle.write_tag(tag, WireType.LENGTH_DELIMITED);
          final_bundle.write_varint(val.length);
          final_bundle.extend(val);
        } else if (typeof val === "number") {
          final_bundle.write_tag(tag, WireType.VARINT);
          final_bundle.write_varint(val);
        }
      }
    }

    for (var j = 0; j < new_entries.length; j++) {
      final_bundle.write_message(2, new_entries[j]);
    }

    var new_content = final_bundle.get_bytes();
    var new_len = new_content.length;
    var new_file_size = 20 + new_len;

    var out = [];
    pushAll(out, toBytesBE4(new_file_size));
    for (var k = 4; k < 16; k++) out.push(header[k]);
    pushAll(out, toBytesBE4(new_len));
    for (var m = 0; m < new_content.length; m++) out.push(new_content[m]);
    for (var n = 0; n < tail.length; n++) out.push(tail[n]);
    return Uint8Array.from(out);
  }

  function pushAll(arr, items) {
    for (var i = 0; i < items.length; i++) arr.push(items[i]);
  }

  function _rebuild_primary_resource_decoration(
    pr_fields,
    removed_guids,
    new_refs,
    new_decoration_guids
  ) {
    var pr_writer = new ProtoWriter();
    var inserted_new_refs = false;
    for (var i = 0; i < pr_fields.length; i++) {
      var f = pr_fields[i];
      if (f.tag === 2) {
        var ref_guid = check_locator_guid(f.data);
        if (removed_guids.has(ref_guid)) {
          if (!inserted_new_refs) {
            for (var r = 0; r < new_refs.length; r++)
              pr_writer.write_message(2, new_refs[r]);
            inserted_new_refs = true;
          }
          continue;
        }
        pr_writer.write_tag(2, WireType.LENGTH_DELIMITED);
        pr_writer.write_varint(f.data.length);
        pr_writer.extend(f.data);
      } else if ("data" in f) {
        if (f.tag === 11) {
          var patched_prefab = patch_prefab_guid_list(
            f.data,
            new_decoration_guids
          );
          pr_writer.write_tag(11, WireType.LENGTH_DELIMITED);
          pr_writer.write_varint(patched_prefab.length);
          pr_writer.extend(patched_prefab);
        } else {
          pr_writer.write_tag(f.tag, WireType.LENGTH_DELIMITED);
          pr_writer.write_varint(f.data.length);
          pr_writer.extend(f.data);
        }
      } else if ("value" in f) {
        pr_writer.write_tag(f.tag, WireType.VARINT);
        pr_writer.write_varint(f.value);
      } else if ("raw" in f) {
        pr_writer.write_tag(f.tag, f.wire);
        pr_writer.extend(f.raw);
      }
    }
    if (!inserted_new_refs) {
      for (var s = 0; s < new_refs.length; s++)
        pr_writer.write_message(2, new_refs[s]);
    }
    return pr_writer.get_bytes();
  }

  function _normalize_mask_shape_type(shape_type) {
    if (typeof shape_type === "string") {
      var lowered = _pyStrip(shape_type).toLowerCase();
      if (lowered === "rect" || lowered === "rectangle") return 1;
      if (lowered === "circle" || lowered === "ellipse") return 2;
    }
    var n = Number(shape_type);
    if (isNaN(n)) return 1;
    return Math.trunc(n);
  }

  function _normalize_element_shape_type(shape_type) {
    if (typeof shape_type !== "string") return shape_type;
    var lowered = _pyStrip(shape_type).toLowerCase();
    var aliases = {
      rect: "rectangle",
      rectangle: "rectangle",
      circle: "ellipse",
      ellipse: "ellipse",
      triangle: "triangle",
      tri: "triangle",
      four_point_star: "four_point_star",
      "four-point-star": "four_point_star",
      "four point star": "four_point_star",
      "4_point_star": "four_point_star",
      "4-point-star": "four_point_star",
      "4 point star": "four_point_star",
      "4star": "four_point_star",
      star4: "four_point_star",
      "四角星": "four_point_star",
      five_point_star: "five_point_star",
      "five-point-star": "five_point_star",
      "five point star": "five_point_star",
      "5_point_star": "five_point_star",
      "5-point-star": "five_point_star",
      "5 point star": "five_point_star",
      "5star": "five_point_star",
      star5: "five_point_star",
      "五角星": "five_point_star",
    };
    return Object.prototype.hasOwnProperty.call(aliases, lowered)
      ? aliases[lowered]
      : lowered;
  }

  function _normalize_mask_settings(mask_settings) {
    if (!pyTruthy(mask_settings)) return null;
    var center = pyOr(
      get(mask_settings, "position", undefined),
      get(mask_settings, "center", undefined),
      {}
    );
    var size = pyOr(get(mask_settings, "size", undefined), {});
    var size_x = get(size, "x", get(size, "width", 0));
    var size_y = get(size, "y", get(size, "height", 0));
    return {
      position_x: Number(get(center, "x", 0.0)),
      position_y: Number(get(center, "y", 0.0)),
      size_x: Number(size_x),
      size_y: Number(size_y),
      shape_type: _normalize_mask_shape_type(get(mask_settings, "shape_type", 1)),
      enabled: !!get(mask_settings, "enabled", true),
    };
  }

  function _color_to_packed(color, alpha, fallback) {
    if (typeof color === "number" && Number.isInteger(color)) {
      return u32(color);
    }
    var alpha_value = alpha;
    var alpha_int;
    if (alpha_value === null || alpha_value === undefined) {
      alpha_int = (fallback >>> 24) & 255;
    } else if (
      typeof alpha_value === "number" &&
      alpha_value >= 0.0 &&
      alpha_value <= 1.0
    ) {
      // mirror: isinstance(alpha, float) and 0<=x<=1
      alpha_int = Math.trunc(
        Math.max(0, Math.min(255, pyRound(alpha_value * 255.0)))
      );
    } else {
      alpha_int = Math.trunc(
        Math.max(0, Math.min(255, pyRound(Number(alpha_value))))
      );
    }
    if (typeof color === "string") {
      var value = _pyStrip(color).replace(/^#+/, "");
      if (value.length === 3) {
        var doubled = "";
        for (var i = 0; i < value.length; i++) doubled += value[i] + value[i];
        value = doubled;
      }
      if (value.length === 6) {
        var rgb = parseInt(value, 16);
        if (isNaN(rgb)) return fallback; // int(value,16) would raise in Python
        return u32(alpha_int * 16777216 + rgb);
      }
      return fallback;
    }
    if (Array.isArray(color) && color.length >= 3) {
      var red = Math.trunc(Math.max(0, Math.min(255, pyRound(Number(color[0])))));
      var green = Math.trunc(Math.max(0, Math.min(255, pyRound(Number(color[1])))));
      var blue = Math.trunc(Math.max(0, Math.min(255, pyRound(Number(color[2])))));
      if (color.length >= 4) {
        var alpha_component = color[3];
        if (
          typeof alpha_component === "number" &&
          alpha_component >= 0.0 &&
          alpha_component <= 1.0
        ) {
          alpha_int = Math.trunc(
            Math.max(0, Math.min(255, pyRound(alpha_component * 255.0)))
          );
        } else {
          alpha_int = Math.trunc(
            Math.max(0, Math.min(255, pyRound(Number(alpha_component))))
          );
        }
      }
      return u32(
        alpha_int * 16777216 + red * 65536 + green * 256 + blue
      );
    }
    return fallback;
  }

  function _patch_ui_content_children(
    ui_content_data,
    new_child_guids,
    parent_guid,
    mask_settings,
    group_name
  ) {
    var fields = parse_message_fields(ui_content_data);
    var new_fields = [];
    var children_written = false;
    var mask_written = false;
    var name_written = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag === 503 && f.wire === WireType.VARINT) {
        if (!children_written) {
          for (var g = 0; g < new_child_guids.length; g++) {
            new_fields.push({
              tag: 503,
              wire: WireType.VARINT,
              value: new_child_guids[g],
            });
          }
          children_written = true;
        }
        continue;
      }
      if (f.tag === 505 && f.wire === WireType.LENGTH_DELIMITED) {
        var data_fields = parse_message_fields(f.data);
        var field502 = _find_varint(data_fields, 502);
        if (mask_settings !== null && mask_settings !== undefined && field502 === 56) {
          new_fields.push({
            tag: 505,
            wire: WireType.LENGTH_DELIMITED,
            data: _build_mask_settings_data(
              mask_settings.position_x,
              mask_settings.position_y,
              mask_settings.size_x,
              mask_settings.size_y,
              mask_settings.shape_type,
              mask_settings.enabled,
              parent_guid
            ).get_bytes(),
          });
          mask_written = true;
          continue;
        }
        if (group_name && field502 === 15) {
          new_fields.push({
            tag: 505,
            wire: WireType.LENGTH_DELIMITED,
            data: _build_name_data(group_name).get_bytes(),
          });
          name_written = true;
          continue;
        }
        new_fields.push(f);
        continue;
      }
      new_fields.push(f);
    }
    if (!children_written) {
      for (var h = 0; h < new_child_guids.length; h++) {
        new_fields.push({
          tag: 503,
          wire: WireType.VARINT,
          value: new_child_guids[h],
        });
      }
    }
    if (mask_settings !== null && mask_settings !== undefined && !mask_written) {
      new_fields.push({
        tag: 505,
        wire: WireType.LENGTH_DELIMITED,
        data: _build_mask_settings_data(
          mask_settings.position_x,
          mask_settings.position_y,
          mask_settings.size_x,
          mask_settings.size_y,
          mask_settings.shape_type,
          mask_settings.enabled,
          parent_guid
        ).get_bytes(),
      });
    }
    if (group_name && !name_written) {
      new_fields.push({
        tag: 505,
        wire: WireType.LENGTH_DELIMITED,
        data: _build_name_data(group_name).get_bytes(),
      });
    }
    return build_message(new_fields);
  }

  function _patch_primary_resource_image(
    pr_fields,
    removed_guids,
    new_refs,
    new_child_guids,
    parent_guid,
    mask_settings,
    group_name
  ) {
    var pr_writer = new ProtoWriter();
    var inserted_new_refs = false;
    var resource_name_written = false;
    for (var i = 0; i < pr_fields.length; i++) {
      var f = pr_fields[i];
      if (f.tag === 2) {
        var ref_guid = check_locator_guid(f.data);
        if (removed_guids.has(ref_guid)) {
          if (!inserted_new_refs) {
            for (var r = 0; r < new_refs.length; r++)
              pr_writer.write_message(2, new_refs[r]);
            inserted_new_refs = true;
          }
          continue;
        }
        pr_writer.write_tag(2, WireType.LENGTH_DELIMITED);
        pr_writer.write_varint(f.data.length);
        pr_writer.extend(f.data);
      } else if (f.tag === 19) {
        var ui_fields = parse_message_fields(f.data);
        var new_ui_fields = [];
        for (var u = 0; u < ui_fields.length; u++) {
          var uf = ui_fields[u];
          if (uf.tag === 1 && uf.wire === WireType.LENGTH_DELIMITED) {
            var patched_content = _patch_ui_content_children(
              uf.data,
              new_child_guids,
              parent_guid,
              mask_settings,
              group_name
            );
            new_ui_fields.push({
              tag: 1,
              wire: WireType.LENGTH_DELIMITED,
              data: patched_content,
            });
          } else {
            new_ui_fields.push(uf);
          }
        }
        var patched_ui = build_message(new_ui_fields);
        pr_writer.write_tag(19, WireType.LENGTH_DELIMITED);
        pr_writer.write_varint(patched_ui.length);
        pr_writer.extend(patched_ui);
      } else if (
        f.tag === 3 &&
        f.wire === WireType.LENGTH_DELIMITED &&
        group_name
      ) {
        pr_writer.write_tag(3, WireType.LENGTH_DELIMITED);
        var encoded = encodeUtf8(group_name);
        pr_writer.write_varint(encoded.length);
        pr_writer.extend(encoded);
        resource_name_written = true;
      } else if ("data" in f) {
        pr_writer.write_tag(f.tag, WireType.LENGTH_DELIMITED);
        pr_writer.write_varint(f.data.length);
        pr_writer.extend(f.data);
      } else if ("value" in f) {
        pr_writer.write_tag(f.tag, WireType.VARINT);
        pr_writer.write_varint(f.value);
      } else if ("raw" in f) {
        pr_writer.write_tag(f.tag, f.wire);
        pr_writer.extend(f.raw);
      }
    }
    if (!inserted_new_refs) {
      for (var s = 0; s < new_refs.length; s++)
        pr_writer.write_message(2, new_refs[s]);
    }
    if (group_name && !resource_name_written) {
      pr_writer.write_string(3, group_name);
    }
    return pr_writer.get_bytes();
  }

  // ------------------------------------------------------------------
  // Top-level conversion
  // ------------------------------------------------------------------

  function convertJsonToGiaBytes(json_data, baseGiaBytes, mode) {
    if (mode === undefined) mode = MODE_DECORATION;
    var file_data = toUint8(baseGiaBytes);
    var parsed = _parse_gia_root_fields(file_data);
    if (mode === MODE_IMAGE) {
      return _convert_image_mode(
        json_data,
        parsed.header,
        parsed.content_len,
        parsed.root_fields,
        parsed.tail
      );
    }
    return _convert_decoration_mode(
      json_data,
      parsed.header,
      parsed.content_len,
      parsed.root_fields,
      parsed.tail
    );
  }

  function _convert_decoration_mode(
    json_data,
    header,
    content_len,
    root_fields,
    tail
  ) {
    var removed_guids = new Set();
    var i, tag, val, info, f;
    for (i = 0; i < root_fields.length; i++) {
      tag = root_fields[i][0];
      val = root_fields[i][2];
      if (tag !== 2) continue;
      if (!_isBytes(val)) continue;
      info = parse_resource_entry(val);
      if (info["class"] !== 28) continue;
      removed_guids.add(info["guid"]);
    }

    var parent_guid = 0;
    var pr_data = null;
    for (i = 0; i < root_fields.length; i++) {
      if (root_fields[i][0] === 1 && _isBytes(root_fields[i][2])) {
        pr_data = root_fields[i][2];
        break;
      }
    }
    var pr_fields = parse_primary_resource(pr_data);
    for (i = 0; i < pr_fields.length; i++) {
      if (pr_fields[i].tag === 1) {
        parent_guid = check_locator_guid(pr_fields[i].data);
        break;
      }
    }

    var existing_guids = new Set();
    for (i = 0; i < root_fields.length; i++) {
      tag = root_fields[i][0];
      val = root_fields[i][2];
      if (tag === 1 && _isBytes(val)) {
        existing_guids.add(check_locator_guid(val));
      } else if (tag === 2 && _isBytes(val)) {
        info = parse_resource_entry(val);
        if (info["guid"]) existing_guids.add(info["guid"]);
      }
    }
    var reserved_guids = new Set();
    existing_guids.forEach(function (g) {
      if (!removed_guids.has(g)) reserved_guids.add(g);
    });
    var next_guid = 1073749460;

    var new_decor_entries = [];
    var new_refs = [];
    var new_decoration_guids = [];

    var base_circle_x = 1.0,
      base_circle_y = 1.0;
    var base_rect_x = 0.5,
      base_rect_y = 10.0;

    var badge_type_ids = new Set([
      20001281, 20001282, 20001283, 20001284, 20001285, 20001286, 20001287,
    ]);

    var elements = json_data && json_data.elements ? json_data.elements : [];
    var ordered_elements = elements.slice().reverse();

    for (i = 0; i < ordered_elements.length; i++) {
      var element = ordered_elements[i];
      var shape_type = _normalize_element_shape_type(
        get(element, "type", undefined)
      );
      var center = pyOr(
        get(element, "relative", undefined),
        get(element, "center", undefined),
        {}
      );
      var size = pyOr(get(element, "size", undefined), {});
      var rot = pyOr(get(element, "rotation", undefined), {});
      var rot_z =
        rot !== null && typeof rot === "object" && !Array.isArray(rot)
          ? get(rot, "z", 0.0)
          : rot;
      var element_type_id = get(element, "type_id", 0);
      var rot_z_add = get(element, "rot_z", 0.0);
      var rot_y_add = get(element, "rot_y_add", 0.0);

      while (reserved_guids.has(next_guid)) next_guid += 1;
      var new_guid = next_guid;
      reserved_guids.add(new_guid);
      next_guid += 1;

      var name = String(i + 1);
      var type_id = 0;
      var sx = 1.0,
        sy = 1.0;
      var final_rot_z = rot_z;
      var final_rot_y = 0.0;

      if (shape_type === "ellipse") {
        type_id = element_type_id ? element_type_id : 10005009;
        var rx = Number(get(size, "rx", 1.0));
        var ry = Number(get(size, "ry", 1.0));
        sx = (rx * 2.0) / base_circle_x;
        sy = (ry * 2.0) / base_circle_y;
        if (badge_type_ids.has(type_id)) {
          final_rot_z = rot_z + rot_z_add;
          final_rot_y = rot_y_add;
          var base_badge_x = 0.3,
            base_badge_y = 0.3;
          sx = (rx * 2.0) / base_badge_x;
          sy = (ry * 2.0) / base_badge_y;
        }
      } else if (
        shape_type === "rectangle" ||
        shape_type === "triangle" ||
        shape_type === "four_point_star" ||
        shape_type === "five_point_star"
      ) {
        type_id = element_type_id ? element_type_id : 20002129;
        var w = Number(get(size, "width", 1.0));
        var h = Number(get(size, "height", 1.0));
        sx = w / base_rect_x;
        sy = h / base_rect_y;
      }

      sx = Math.max(0.0, Math.min(Number(sx), 50.0));
      sy = Math.max(0.0, Math.min(Number(sy), 50.0));
      var pos = {
        x: Number(get(center, "x", 0)),
        y: Number(get(center, "y", 0)),
      };
      var scale = { x: sx, y: sy };

      var payload = create_decoration_payload(
        new_guid,
        name,
        type_id,
        parent_guid,
        pos,
        scale,
        final_rot_z,
        final_rot_y
      );
      var entry = create_resource_entry_stub(new_guid, name, payload);
      new_decor_entries.push(entry);
      new_decoration_guids.push(new_guid);
      new_refs.push(create_reference_locator(new_guid, 14));
    }

    var pr_bytes = _rebuild_primary_resource_decoration(
      pr_fields,
      removed_guids,
      new_refs,
      new_decoration_guids
    );
    return _rebuild_gia(
      header,
      content_len,
      root_fields,
      tail,
      new_decor_entries,
      pr_bytes,
      28
    );
  }

  function _convert_image_mode(
    json_data,
    header,
    content_len,
    root_fields,
    tail
  ) {
    var group_name = _normalize_group_name(
      json_data && Object.prototype.hasOwnProperty.call(json_data, "group_name")
        ? json_data.group_name
        : ""
    );
    var removed_guids = new Set();
    var i, tag, val, info;
    for (i = 0; i < root_fields.length; i++) {
      tag = root_fields[i][0];
      val = root_fields[i][2];
      if (tag !== 2) continue;
      if (!_isBytes(val)) continue;
      info = parse_resource_entry(val);
      if (info["class"] !== 15) continue;
      removed_guids.add(info["guid"]);
    }

    var parent_guid = 0;
    var pr_data = null;
    for (i = 0; i < root_fields.length; i++) {
      if (root_fields[i][0] === 1 && _isBytes(root_fields[i][2])) {
        pr_data = root_fields[i][2];
        break;
      }
    }
    var pr_fields = parse_primary_resource(pr_data);
    for (i = 0; i < pr_fields.length; i++) {
      if (pr_fields[i].tag === 1) {
        parent_guid = check_locator_guid(pr_fields[i].data);
        break;
      }
    }

    var existing_guids = new Set();
    for (i = 0; i < root_fields.length; i++) {
      tag = root_fields[i][0];
      val = root_fields[i][2];
      if (tag === 1 && _isBytes(val)) {
        existing_guids.add(check_locator_guid(val));
      } else if (tag === 2 && _isBytes(val)) {
        info = parse_resource_entry(val);
        if (info["guid"]) existing_guids.add(info["guid"]);
      }
    }
    var reserved_guids = new Set();
    existing_guids.forEach(function (g) {
      if (!removed_guids.has(g)) reserved_guids.add(g);
    });

    var next_guid;
    if (removed_guids.size > 0) {
      var mx = -Infinity;
      removed_guids.forEach(function (g) {
        if (g > mx) mx = g;
      });
      next_guid = mx + 1;
    } else {
      next_guid = 1073749460;
    }
    while (reserved_guids.has(next_guid)) next_guid += 1;

    var new_image_entries = [];
    var new_refs = [];
    var new_child_guids = [];

    var default_packed_color = 2164260863;
    var mask_settings = _normalize_mask_settings(
      json_data ? json_data.mask : undefined
    );

    var elements = json_data && json_data.elements ? json_data.elements : [];
    var ordered_elements = _order_elements_for_image_mode(elements);
    var serialized_elements = _storage_order_elements_for_image_mode(elements);
    var indexed_items = [];

    for (i = 0; i < ordered_elements.length; i++) {
      var element = ordered_elements[i];
      var shape_type = _normalize_element_shape_type(
        get(element, "type", undefined)
      );
      var center = pyOr(
        get(element, "relative", undefined),
        get(element, "center", undefined),
        {}
      );
      var size = pyOr(get(element, "size", undefined), {});
      var rot = pyOr(get(element, "rotation", undefined), {});
      var rot_z =
        rot !== null && typeof rot === "object" && !Array.isArray(rot)
          ? get(rot, "z", 0.0)
          : rot;

      while (reserved_guids.has(next_guid)) next_guid += 1;
      var new_guid = next_guid;
      reserved_guids.add(new_guid);
      next_guid += 1;

      var name = String(i + 1);
      var offset_x = Number(get(center, "x", 0));
      var offset_y = Number(get(center, "y", 0));

      var size_x, size_y;
      if (shape_type === "ellipse") {
        var rx = Number(get(size, "rx", 1.0));
        var ry = Number(get(size, "ry", 1.0));
        size_x = rx * 2.0;
        size_y = ry * 2.0;
      } else if (
        shape_type === "rectangle" ||
        shape_type === "triangle" ||
        shape_type === "four_point_star" ||
        shape_type === "five_point_star"
      ) {
        size_x = Number(get(size, "width", 1.0));
        size_y = Number(get(size, "height", 1.0));
      } else {
        size_x = Number(get(size, "width", 1.0));
        size_y = Number(get(size, "height", 1.0));
      }

      var image_asset_ref = Math.trunc(
        Number(
          get(
            element,
            "image_asset_ref",
            Object.prototype.hasOwnProperty.call(
              DEFAULT_IMAGE_ASSET_REFS,
              shape_type
            )
              ? DEFAULT_IMAGE_ASSET_REFS[shape_type]
              : 100002
          )
        )
      );
      // Python: int(element.get("packed_color", default)) — a present-but-None
      // value raises TypeError in the original (this is how the currently
      // broken decoration→GIA export fails upstream); replicate the error
      // instead of coercing null to 0.
      var rawPackedColor = get(element, "packed_color", default_packed_color);
      if (rawPackedColor === null) {
        throw new TypeError(
          "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'"
        );
      }
      var packed_color = Math.trunc(Number(rawPackedColor));
      packed_color = _color_to_packed(
        get(element, "color", undefined),
        get(element, "alpha", undefined),
        packed_color
      );
      var index = i + 2;

      var ui_content = create_ui_image_payload({
        guid: new_guid,
        index: index,
        parent_guid: parent_guid,
        offset_x: offset_x,
        offset_y: offset_y,
        size_x: size_x,
        size_y: size_y,
        image_asset_ref: image_asset_ref,
        packed_color: packed_color,
        rot_z: rot_z,
        pivot_x: 0.5,
        pivot_y: 0.5,
        name: name,
      });

      indexed_items.push({
        element: element, // identity key (mirror Python id(element))
        guid: new_guid,
        name: name,
        entry: create_ui_image_entry(new_guid, name, ui_content),
        ref: create_reference_locator(new_guid, 8),
      });
    }

    // Pair by index (ordered vs serialized). Both orderings are identical,
    // so element-by-reference lookup yields items[i]. Mirrors Python's
    // id(element) map keyed association.
    for (i = 0; i < serialized_elements.length; i++) {
      var el = serialized_elements[i];
      var idx = ordered_elements.indexOf(el);
      if (idx < 0) continue;
      var item = indexed_items[idx];
      new_image_entries.push(item.entry);
      new_child_guids.push(item.guid);
      new_refs.push(item.ref);
    }

    var pr_bytes = _patch_primary_resource_image(
      pr_fields,
      removed_guids,
      new_refs,
      new_child_guids,
      parent_guid,
      mask_settings,
      group_name
    );
    return _rebuild_gia(
      header,
      content_len,
      root_fields,
      tail,
      new_image_entries,
      pr_bytes,
      15
    );
  }

  // ------------------------------------------------------------------
  // convert_to_classic / convert_to_overlimit
  // ------------------------------------------------------------------

  function _read_varint_at(data, offset) {
    var result = 0;
    var shift = 0;
    while (true) {
      if (offset >= data.length)
        throw new RangeError("End of data while reading varint");
      var byte = data[offset];
      offset += 1;
      result += (byte & 0x7f) * Math.pow(2, shift);
      if (!(byte & 0x80)) return [result, offset];
      shift += 7;
    }
  }

  function _skip_proto_value(data, offset, wire_type) {
    if (wire_type === 0) {
      return _read_varint_at(data, offset)[1];
    }
    if (wire_type === 1) return offset + 8;
    if (wire_type === 2) {
      var r = _read_varint_at(data, offset);
      return r[1] + r[0];
    }
    if (wire_type === 5) return offset + 4;
    throw new Error("Unsupported wire type " + wire_type);
  }

  function toClassic(input) {
    var data = toUint8(input);
    if (data.length < 20) throw new Error("File too small");

    var content_len = intFromBytesBE(data, 16, 4);
    if (content_len < 0 || data.length < content_len + 20)
      throw new Error("Invalid GIA content length");

    // bytearray(data[20:20+content_len]) — copy, we mutate it locally.
    var content = Array.prototype.slice.call(
      data.subarray(20, 20 + content_len)
    );
    var tail_magic = data.subarray(20 + content_len);

    var offset = 0;
    var insert_pos = content.length;
    var remove_ranges = [];

    while (offset < content.length) {
      var start_pos = offset;
      var key;
      try {
        var kr = _read_varint_at(content, offset);
        key = kr[0];
        offset = kr[1];
      } catch (e) {
        break;
      }

      var field_id = Math.floor(key / 8);
      var wire_type = key & 0x07;

      if (field_id === 5) {
        insert_pos = start_pos;
      }

      var end_pos;
      try {
        end_pos = _skip_proto_value(content, offset, wire_type);
      } catch (e2) {
        break;
      }

      if (field_id === 4) {
        remove_ranges.push([start_pos, end_pos]);
        if (start_pos < insert_pos) insert_pos = start_pos;
      }

      offset = end_pos;
    }

    for (var i = remove_ranges.length - 1; i >= 0; i--) {
      content.splice(
        remove_ranges[i][0],
        remove_ranges[i][1] - remove_ranges[i][0]
      );
    }

    var removed_before_insert = 0;
    for (var j = 0; j < remove_ranges.length; j++) {
      if (remove_ranges[j][0] < insert_pos)
        removed_before_insert += remove_ranges[j][1] - remove_ranges[j][0];
    }
    insert_pos = Math.max(0, insert_pos - removed_before_insert);
    content.splice(insert_pos, 0, 0x20, 0x01);

    var new_content_len = content.length;
    var new_file_size_field = new_content_len + 20;

    var out = [];
    pushAll(out, toBytesBE4(new_file_size_field));
    for (var k = 4; k < 16; k++) out.push(data[k]);
    pushAll(out, toBytesBE4(new_content_len));
    pushAll(out, content);
    for (var m = 0; m < tail_magic.length; m++) out.push(tail_magic[m]);
    return Uint8Array.from(out);
  }

  function toOverlimit(input) {
    var data = toUint8(input);
    if (data.length < 20) throw new Error("File too small");

    var content_len = intFromBytesBE(data, 16, 4);
    if (data.length < content_len + 20)
      throw new Error("Invalid GIA content length");

    var content = Array.prototype.slice.call(
      data.subarray(20, 20 + content_len)
    );
    var tail_magic = data.subarray(20 + content_len);

    var offset = 0;
    var remove_ranges = [];

    while (offset < content.length) {
      var start_pos = offset;
      var key;
      try {
        var kr = _read_varint_at(content, offset);
        key = kr[0];
        offset = kr[1];
      } catch (e) {
        break;
      }

      var field_id = Math.floor(key / 8);
      var wire_type = key & 0x07;

      if (field_id === 4 && wire_type === 0) {
        var er = _read_varint_at(content, offset);
        var end_pos = er[1];
        remove_ranges.push([start_pos, end_pos]);
        offset = end_pos;
        continue;
      }

      if (wire_type === 0) {
        offset = _read_varint_at(content, offset)[1];
      } else if (wire_type === 1) {
        offset += 8;
      } else if (wire_type === 2) {
        var lr = _read_varint_at(content, offset);
        offset = lr[1] + lr[0];
      } else if (wire_type === 5) {
        offset += 4;
      } else {
        throw new Error("Unknown wire type " + wire_type + " at offset " + offset);
      }
    }

    if (remove_ranges.length === 0) {
      // Field 4 not found, return original data unmodified (a copy).
      return Uint8Array.from(data);
    }

    for (var i = remove_ranges.length - 1; i >= 0; i--) {
      content.splice(
        remove_ranges[i][0],
        remove_ranges[i][1] - remove_ranges[i][0]
      );
    }

    var new_content_len = content.length;
    var new_file_size_field = new_content_len + 20;

    var out = [];
    pushAll(out, toBytesBE4(new_file_size_field));
    for (var k = 4; k < 16; k++) out.push(data[k]);
    pushAll(out, toBytesBE4(new_content_len));
    pushAll(out, content);
    for (var m = 0; m < tail_magic.length; m++) out.push(tail_magic[m]);
    return Uint8Array.from(out);
  }

  return {
    MODE_DECORATION: MODE_DECORATION,
    MODE_IMAGE: MODE_IMAGE,
    convertJsonToGiaBytes: convertJsonToGiaBytes,
    toClassic: toClassic,
    toOverlimit: toOverlimit,
  };
})();

if (typeof module !== "undefined") module.exports = GIA;

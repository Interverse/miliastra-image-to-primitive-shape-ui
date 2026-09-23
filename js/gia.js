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
  var MODE_IMAGE = "image"; // Server Control Template image group
  var MODE_CLIENT_IMAGE = "client_image"; // Client Control Template image group

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

  /* ── hierarchy order, as *indices* into the source element list ──────
   *
   * `elements` is in painter order: elements[0] is drawn first and ends up
   * at the bottom. Every other consumer in this project relies on that —
   * the canvas preview, the SVG export and the CSS export all paint
   * `renderOrderedElements()` (background, then foreground, unreversed) and
   * are visually correct.
   *
   * The two control templates composite their children in OPPOSITE
   * directions, so each gets its own permutation:
   *
   *   Server: the writer emits background, then foreground REVERSED —
   *           i.e. the last-painted (topmost) primitive is child #1. This
   *           is byte-verified against the original Python writer, so the
   *           Server format must render its hierarchy back-to-front:
   *           earlier child = drawn later = on top.
   *
   *   Client: earlier in the hierarchy is rendered FIRST and is therefore
   *           BEHIND later siblings. The hierarchy is the painter order
   *           itself, unreversed.
   *
   * Index permutations (rather than element references) keep this exact
   * even if the same element object appears twice in the list. */
  function _split_indices(elements) {
    var foreground = [];
    var background = [];
    var list = elements || [];
    for (var i = 0; i < list.length; i++) {
      if (get(list[i], "is_background", undefined)) background.push(i);
      else foreground.push(i);
    }
    return { foreground: foreground, background: background };
  }

  function _order_indices_for_image_mode(elements) {
    var split = _split_indices(elements);
    return split.background.concat(split.foreground.slice().reverse());
  }

  function _order_indices_for_client_image_mode(elements) {
    var split = _split_indices(elements);
    return split.background.concat(split.foreground);
  }

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

  // ══════════════════════════════════════════════════════════════════
  // Logical Image Representation (shared by the Server and Client
  // serializers)
  //
  //   image processing → logical image representation → Server .gia
  //   image processing → logical image representation → Client .gia
  //
  // `buildImageScene` is the single place where a result payload is turned
  // into positioned, sized, coloured image objects; neither serializer may
  // re-derive any of it. In particular the image/resource ID table
  // (DEFAULT_IMAGE_ASSET_REFS + each element's `image_asset_ref`) is
  // resolved here exactly once, so a given element always maps to the same
  // ID in both outputs.
  // ══════════════════════════════════════════════════════════════════

  var DEFAULT_PACKED_COLOR = 2164260863; // 0x80FFFFFF

  /* Resolve one element into the shared object model. Mirrors the original
   * Python writer's per-element arithmetic exactly — the Server serializer
   * is byte-compared against it, so nothing here may change. */
  function _build_image_object(element, i) {
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
    var rawPackedColor = get(element, "packed_color", DEFAULT_PACKED_COLOR);
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

    return {
      element: element, // identity key (mirror Python id(element))
      shape_type: shape_type,
      name: String(i + 1),
      index: i + 2,
      offset_x: Number(get(center, "x", 0)),
      offset_y: Number(get(center, "y", 0)),
      size_x: size_x,
      size_y: size_y,
      rot_z: rot_z,
      image_asset_ref: image_asset_ref,
      packed_color: packed_color,
    };
  }

  /* ── The Client container is always an image ─────────────────────────
   *
   * Reverse-engineered from assets/client_mask_off_template.gia and
   * assets/client_mask_template.gia — the same object exported twice with
   * the in-game mask toggled. The only difference between them is one
   * varint, `505[slot 74 / type 97].503.85.501`: present ⇒ mask on, absent
   * ⇒ mask off. Everything else, including the container's image settings,
   * is byte-identical.
   *
   * So a Client masking parent is just an ordinary image that happens to
   * have children and a toggle. Generated output therefore ALWAYS gives the
   * group an image parent, sized to the source image rectangle, tinted
   * fully transparent so it is never drawn, with the toggle OFF — the
   * player turns it on in game and the group clips exactly to the source
   * image. Because the parent's rect carries an offset, every child offset
   * is compensated by that much, once. See docs/client-gia-format.md §11. */

  // Tint on the parent image: ARGB alpha 0, so it clips (when toggled on)
  // without ever being drawn. Taken verbatim from both references.
  var CLIENT_PARENT_HIDDEN_COLOR = 16777215; // 0x00FFFFFF

  function _rect_of_elements(objects) {
    if (!objects.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < objects.length; i++) {
      var o = objects[i];
      var hw = Math.abs(Number(o.size_x) || 0) / 2;
      var hh = Math.abs(Number(o.size_y) || 0) / 2;
      minX = Math.min(minX, o.offset_x - hw);
      maxX = Math.max(maxX, o.offset_x + hw);
      minY = Math.min(minY, o.offset_y - hh);
      maxY = Math.max(maxY, o.offset_y + hh);
    }
    if (!isFinite(minX) || !isFinite(minY)) return null;
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /* The parent image's rect. `image_bounds` (from gia-export.js) is the
   * source image rectangle and is what the toggle is meant to clip to;
   * the other two are fallbacks for payloads assembled by hand. */
  function _build_client_container(json_data, mask_settings, objects) {
    var bounds = json_data && json_data.image_bounds;
    var rect = null;
    if (
      bounds &&
      isFinite(Number(bounds.width)) &&
      isFinite(Number(bounds.height)) &&
      Number(bounds.width) > 0 &&
      Number(bounds.height) > 0
    ) {
      rect = {
        x: Number(bounds.x) || 0,
        y: Number(bounds.y) || 0,
        width: Number(bounds.width),
        height: Number(bounds.height),
      };
    } else if (
      mask_settings &&
      Number(mask_settings.size_x) > 0 &&
      Number(mask_settings.size_y) > 0
    ) {
      rect = {
        x: Number(mask_settings.position_x) || 0,
        y: Number(mask_settings.position_y) || 0,
        width: Number(mask_settings.size_x),
        height: Number(mask_settings.size_y),
      };
    } else {
      rect = _rect_of_elements(objects) || { x: 0, y: 0, width: 0, height: 0 };
    }

    return {
      offset_x: rect.x,
      offset_y: rect.y,
      size_x: rect.width,
      size_y: rect.height,
      // The parent is the source image rectangle, so: rectangle resource,
      // from the one shared ID table.
      image_asset_ref: DEFAULT_IMAGE_ASSET_REFS.rectangle,
      packed_color: CLIENT_PARENT_HIDDEN_COLOR,
      // Off by default — the mask is a toggle the player owns. A payload
      // may pre-enable it, which is the same one-varint difference the two
      // references differ by.
      mask_enabled: !!(json_data && json_data.client_mask_enabled),
    };
  }

  /* The logical scene both serializers consume.
   *
   *   scene.objects       — Server hierarchy order (child #1 = topmost).
   *   scene.clientObjects — Client hierarchy order (child #1 = bottom-most,
   *                         i.e. painter order), because the Client
   *                         renderer draws earlier siblings first.
   *
   * Both arrays describe the SAME primitives with the same geometry,
   * colour and image IDs; only `index` (the sibling position) and the array
   * order differ. `name` is deliberately stable across the two, so a given
   * primitive carries the same label in both files and the outputs stay
   * comparable. */
  function buildImageScene(json_data) {
    var elements = json_data && json_data.elements ? json_data.elements : [];
    var ordered = _order_elements_for_image_mode(elements);
    var serialized = _storage_order_elements_for_image_mode(elements);
    var objects = [];
    var i;
    for (i = 0; i < ordered.length; i++) {
      objects.push(_build_image_object(ordered[i], i));
    }

    // Map each source element position to its Server hierarchy position, so
    // the Client can reuse the same names while re-ordering the hierarchy.
    var serverOrderIdx = _order_indices_for_image_mode(elements);
    var serverPosOf = new Array(elements.length);
    for (i = 0; i < serverOrderIdx.length; i++) serverPosOf[serverOrderIdx[i]] = i;

    var mask = _normalize_mask_settings(json_data ? json_data.mask : undefined);
    var clientContainer = _build_client_container(json_data, mask, objects);

    var clientOrderIdx = _order_indices_for_client_image_mode(elements);
    var clientObjects = [];
    for (i = 0; i < clientOrderIdx.length; i++) {
      var sourceIdx = clientOrderIdx[i];
      var base = objects[serverPosOf[sourceIdx]];
      var copy = {};
      for (var k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) copy[k] = base[k];
      }
      copy.index = i + 2; // sibling position in the Client hierarchy
      copy.sourceIndex = sourceIdx;
      copy.serverIndex = base.index;
      // Child offsets are relative to the parent image's rect, so they
      // shift by its offset. Applied exactly once, here, never again at
      // serialization.
      copy.offset_x = base.offset_x - clientContainer.offset_x;
      copy.offset_y = base.offset_y - clientContainer.offset_y;
      copy.parentOffsetX = clientContainer.offset_x;
      copy.parentOffsetY = clientContainer.offset_y;
      clientObjects.push(copy);
    }

    var group_name = _normalize_group_name(
      json_data && Object.prototype.hasOwnProperty.call(json_data, "group_name")
        ? json_data.group_name
        : ""
    );

    // The Client container node, modelled explicitly rather than being
    // conjured during serialization.
    clientContainer.name = group_name;
    clientContainer.is_mask = clientContainer.mask_enabled;
    clientContainer.children = clientObjects;

    return {
      group_name: group_name,
      mask: mask,
      clientContainer: clientContainer,
      elements: elements,
      ordered: ordered,
      serialized: serialized,
      objects: objects,
      clientObjects: clientObjects,
    };
  }

  // ------------------------------------------------------------------
  // Shared container/GUID plumbing
  // ------------------------------------------------------------------

  var UI_IMAGE_CLASS = 15; // per-image child resource class (server + client)

  function _collect_entry_guids_of_class(root_fields, cls) {
    var out = new Set();
    for (var i = 0; i < root_fields.length; i++) {
      if (root_fields[i][0] !== 2) continue;
      var val = root_fields[i][2];
      if (!_isBytes(val)) continue;
      var info = parse_resource_entry(val);
      if (info["class"] !== cls) continue;
      out.add(info["guid"]);
    }
    return out;
  }

  function _find_primary_resource(root_fields) {
    var pr_data = null;
    for (var i = 0; i < root_fields.length; i++) {
      if (root_fields[i][0] === 1 && _isBytes(root_fields[i][2])) {
        pr_data = root_fields[i][2];
        break;
      }
    }
    var fields = parse_primary_resource(pr_data);
    var guid = 0;
    for (var j = 0; j < fields.length; j++) {
      if (fields[j].tag === 1) {
        guid = check_locator_guid(fields[j].data);
        break;
      }
    }
    var cls = null;
    for (var k = 0; k < fields.length; k++) {
      if (fields[k].tag === 5 && fields[k].wire === WireType.VARINT) {
        cls = fields[k].value;
        break;
      }
    }
    return { data: pr_data, fields: fields, guid: guid, resourceClass: cls };
  }

  /* GUID allocation: reuse the removed image GUIDs' range, never collide
   * with a GUID the template still references. */
  function _make_guid_allocator(root_fields, removed_guids) {
    var existing_guids = new Set();
    for (var i = 0; i < root_fields.length; i++) {
      var tag = root_fields[i][0];
      var val = root_fields[i][2];
      if (tag === 1 && _isBytes(val)) {
        existing_guids.add(check_locator_guid(val));
      } else if (tag === 2 && _isBytes(val)) {
        var info = parse_resource_entry(val);
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

    return {
      reserved: reserved_guids,
      next: function () {
        while (reserved_guids.has(next_guid)) next_guid += 1;
        var g = next_guid;
        reserved_guids.add(g);
        next_guid += 1;
        return g;
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // Client Control Template serializer
  //
  // Reverse-engineered from assets/client_image_template.gia (the supplied
  // working reference: "Image Container" → Square, Circle). See
  // docs/client-gia-format.md for the full field survey.
  //
  // What the two templates share
  //   • 20-byte header + 4-byte trailer container, root fields 1/2/3/5.
  //   • The per-image child resource class (15) and its reference locators
  //     (kind 8).
  //   • The rect-transform layout: 501 scale3, 502 anchorMin, 503 anchorMax,
  //     504 anchoredPosition, 505 sizeDelta, 506 pivot, 508 rotation — the
  //     reference's Circle sits at anchoredPosition.x ≈ +100 relative to the
  //     Square, which is what pins this down.
  //   • Component slots 1 (transform, type 12) and 2 (name, type 15).
  //   • Image/resource IDs (100001 Square, 100002 Circle, …).
  //
  // What differs
  //   • Container resource class: server 61, client 70.
  //   • Image settings: server slot 21 / type 38, payload field 31
  //     {2: id, 3: source_meta, 4: colour}; client slot 73 / type 96,
  //     payload field 84 {502: colour, 503: id}.
  //   • The server's "field14" component is slot 4 / type 23; the client's
  //     is slot 4 / type 86 with a different inner shape.
  //   • The container's child list is a packed varint field in the client
  //     and a repeated varint field in the server template.
  //   • Client-only components: slot 63/type 83, 67/type 90, 68/type 91
  //     (container), 74/type 97 (children). Their payloads are identical
  //     across Square and Circle, so they are carried over verbatim.
  //   • No mask component exists in the client reference (see MASK note).
  //
  // Generation strategy: the reference file IS the template. Its container
  // is kept and re-pointed; one of its image children is used as a
  // prototype that is cloned per element and patched in place, so every
  // byte whose purpose is still unknown survives untouched.
  // ══════════════════════════════════════════════════════════════════

  var CLIENT_CONTAINER_CLASS = 70; // server image container is class 61
  var SERVER_CONTAINER_CLASS = 61;

  // Component type ids (field 502 of a 505 component record).
  var COMPONENT_TYPE = {
    TRANSFORM: 12, // shared
    NAME: 15, // shared
    SERVER_FIELD14: 23,
    SERVER_IMAGE: 38,
    SERVER_MASK: 56,
    CLIENT_FIELD14: 86,
    CLIENT_IMAGE: 96,
    CLIENT_IMAGE_EXTRA: 97,
  };

  // Components that must never appear in Client Control Template output.
  var SERVER_ONLY_COMPONENT_TYPES = [
    COMPONENT_TYPE.SERVER_FIELD14,
    COMPONENT_TYPE.SERVER_IMAGE,
    COMPONENT_TYPE.SERVER_MASK,
  ];

  // Payload field numbers inside a client component's detail record.
  var CLIENT_TRANSFORM_FIELD = 13;
  var CLIENT_IMAGE_FIELD = 84;
  var CLIENT_IMAGE_COLOR_FIELD = 502;
  var CLIENT_IMAGE_REF_FIELD = 503;
  var NAME_PAYLOAD_FIELD = 12;
  // Image-extra payload; field 501 inside it is the mask flag — the single
  // structural difference between the masked and unmasked references.
  var CLIENT_IMAGE_EXTRA_FIELD = 85;
  var CLIENT_MASK_FLAG_FIELD = 501;

  // ------------------------------------------------------------------
  // Small message-editing helpers (preserve everything not named)
  // ------------------------------------------------------------------

  function _writer_from_bytes(bytes) {
    return { buffer: Array.prototype.slice.call(bytes) };
  }

  function _msg_set_varint(data, tag, value) {
    var fields = parse_message_fields(data);
    var found = false;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag === tag && fields[i].wire === WireType.VARINT) {
        fields[i] = { tag: tag, wire: WireType.VARINT, value: value };
        found = true;
        break;
      }
    }
    if (!found) fields.push({ tag: tag, wire: WireType.VARINT, value: value });
    return build_message(fields);
  }

  function _msg_set_bytes(data, tag, payload) {
    var fields = parse_message_fields(data);
    var found = false;
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag === tag && fields[i].wire === WireType.LENGTH_DELIMITED) {
        fields[i] = { tag: tag, wire: WireType.LENGTH_DELIMITED, data: payload };
        found = true;
        break;
      }
    }
    if (!found)
      fields.push({ tag: tag, wire: WireType.LENGTH_DELIMITED, data: payload });
    return build_message(fields);
  }

  function _msg_delete_field(data, tag) {
    var fields = parse_message_fields(data);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag !== tag) out.push(fields[i]);
    }
    return out.length === fields.length ? data : build_message(out);
  }

  function _lenField(tag, data) {
    return { tag: tag, wire: WireType.LENGTH_DELIMITED, data: data };
  }

  function _varField(tag, value) {
    return { tag: tag, wire: WireType.VARINT, value: value };
  }

  /* Re-point an asset-info locator ({2: 1, 3: 8, 4: guid}) at the cloned
   * object. Anything that is not this exact prototype's locator is left
   * alone. */
  function _client_repoint_locator(data, proto_guid, new_guid) {
    if (check_locator_guid(data) !== proto_guid) return data;
    return _msg_set_varint(data, 4, new_guid);
  }

  // ------------------------------------------------------------------
  // Prototype cloning
  // ------------------------------------------------------------------

  function _client_patch_rect_transform(rt_bytes, obj) {
    var fields = parse_message_fields(rt_bytes);
    var out = [];
    var wrote_offset = false;
    var wrote_size = false;
    var wrote_rot = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag === 504 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(
          _lenField(504, _build_vector2(obj.offset_x, obj.offset_y).get_bytes())
        );
        wrote_offset = true;
        continue;
      }
      if (f.tag === 505 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(
          _lenField(505, _build_vector2(obj.size_x, obj.size_y).get_bytes())
        );
        wrote_size = true;
        continue;
      }
      if (f.tag === 508 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(508, _build_rotation(obj.rot_z).get_bytes()));
        wrote_rot = true;
        continue;
      }
      out.push(f);
    }
    if (!wrote_offset)
      out.push(
        _lenField(504, _build_vector2(obj.offset_x, obj.offset_y).get_bytes())
      );
    if (!wrote_size)
      out.push(
        _lenField(505, _build_vector2(obj.size_x, obj.size_y).get_bytes())
      );
    if (!wrote_rot)
      out.push(_lenField(508, _build_rotation(obj.rot_z).get_bytes()));
    return build_message(out);
  }

  /* The transform is stored once per platform variant (4 of them in both
   * templates); every variant carries the same rect transform. */
  function _client_patch_multi_platform(mp_bytes, obj) {
    var fields = parse_message_fields(mp_bytes);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag !== 501 || f.wire !== WireType.LENGTH_DELIMITED) {
        out.push(f);
        continue;
      }
      var pf = parse_message_fields(f.data);
      var po = [];
      for (var j = 0; j < pf.length; j++) {
        var g = pf[j];
        if (g.tag === 502 && g.wire === WireType.LENGTH_DELIMITED) {
          po.push(_lenField(502, _client_patch_rect_transform(g.data, obj)));
        } else {
          po.push(g);
        }
      }
      out.push(_lenField(501, build_message(po)));
    }
    return build_message(out);
  }

  function _client_patch_transform_payload(data, obj) {
    var fields = parse_message_fields(data);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag === 12 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(12, _client_patch_multi_platform(f.data, obj)));
      } else {
        out.push(f);
      }
    }
    return build_message(out);
  }

  /* Mirror ProtoWriter.write_int32: a negative int is written as its
   * two's-complement 64-bit value, not as a raw (never-terminating) varint. */
  function _asWireVarint(value) {
    if (typeof value === "bigint") return value < 0n ? value + TWO_POW_64 : value;
    return value < 0 ? BigInt(value) + TWO_POW_64 : value;
  }

  function _client_patch_image_payload(data, obj) {
    var patched = _msg_set_varint(
      data,
      CLIENT_IMAGE_COLOR_FIELD,
      _asWireVarint(obj.packed_color)
    );
    return _msg_set_varint(
      patched,
      CLIENT_IMAGE_REF_FIELD,
      _asWireVarint(obj.image_asset_ref)
    );
  }

  function _client_name_payload(name) {
    var w = new ProtoWriter();
    if (name) w.write_string(501, name);
    return w.get_bytes();
  }

  /* Patch one component record (a 505 field) and its detail sub-record. */
  function _client_patch_component(comp_bytes, proto_guid, new_guid, obj) {
    var fields = parse_message_fields(comp_bytes);
    var type = _find_varint(fields, 502);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wire !== WireType.LENGTH_DELIMITED) {
        out.push(f);
        continue;
      }
      if (f.tag === 503) {
        out.push(
          _lenField(
            503,
            _client_patch_component_detail(f.data, proto_guid, new_guid, obj, type)
          )
        );
        continue;
      }
      if (type === COMPONENT_TYPE.NAME && f.tag === NAME_PAYLOAD_FIELD) {
        out.push(_lenField(f.tag, _client_name_payload(obj.name)));
        continue;
      }
      out.push(f);
    }
    return build_message(out);
  }

  function _client_patch_component_detail(
    detail_bytes,
    proto_guid,
    new_guid,
    obj,
    type
  ) {
    var fields = parse_message_fields(detail_bytes);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.wire !== WireType.LENGTH_DELIMITED) {
        out.push(f);
        continue;
      }
      if (f.tag === 504) {
        out.push(
          _lenField(504, _client_repoint_locator(f.data, proto_guid, new_guid))
        );
        continue;
      }
      if (f.tag === 503) {
        // nested detail (not present in the reference, handled defensively)
        out.push(
          _lenField(
            503,
            _client_patch_component_detail(f.data, proto_guid, new_guid, obj, type)
          )
        );
        continue;
      }
      if (type === COMPONENT_TYPE.TRANSFORM && f.tag === CLIENT_TRANSFORM_FIELD) {
        out.push(_lenField(f.tag, _client_patch_transform_payload(f.data, obj)));
        continue;
      }
      if (type === COMPONENT_TYPE.CLIENT_IMAGE && f.tag === CLIENT_IMAGE_FIELD) {
        out.push(_lenField(f.tag, _client_patch_image_payload(f.data, obj)));
        continue;
      }
      if (
        type === COMPONENT_TYPE.CLIENT_IMAGE_EXTRA &&
        f.tag === CLIENT_IMAGE_EXTRA_FIELD
      ) {
        // The mask toggle: present ⇒ on, absent ⇒ off. Set or clear it
        // explicitly so the result does not depend on which reference the
        // template came from; every other field in the payload is left
        // exactly as the template had it.
        out.push(
          _lenField(
            f.tag,
            obj.is_mask
              ? _msg_set_varint(f.data, CLIENT_MASK_FLAG_FIELD, 1)
              : _msg_delete_field(f.data, CLIENT_MASK_FLAG_FIELD)
          )
        );
        continue;
      }
      if (type === COMPONENT_TYPE.NAME && f.tag === NAME_PAYLOAD_FIELD) {
        out.push(_lenField(f.tag, _client_name_payload(obj.name)));
        continue;
      }
      out.push(f);
    }
    return build_message(out);
  }

  /* The 502 "info" records: slot 1 holds the object GUID, slot 2 its
   * sibling index. Other slots (e.g. the container's slot 4 ancestor list)
   * are template data and are copied through. */
  function _client_patch_info(info_bytes, new_guid, index) {
    var fields = parse_message_fields(info_bytes);
    var slot = _find_varint(fields, 501);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (slot === 1 && f.tag === 11 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(11, _msg_set_varint(f.data, 501, new_guid)));
        continue;
      }
      if (slot === 2 && f.tag === 12 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(12, _msg_set_varint(f.data, 501, index)));
        continue;
      }
      out.push(f);
    }
    return build_message(out);
  }

  function _client_patch_child_content(
    proto_content,
    proto_guid,
    new_guid,
    parent_guid,
    obj
  ) {
    var fields = parse_message_fields(proto_content);
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag === 501 && f.wire === WireType.VARINT) {
        out.push(_varField(501, new_guid));
        continue;
      }
      if (f.tag === 504 && f.wire === WireType.VARINT) {
        out.push(_varField(504, parent_guid));
        continue;
      }
      if (f.tag === 502 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(502, _client_patch_info(f.data, new_guid, obj.index)));
        continue;
      }
      if (f.tag === 505 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(
          _lenField(505, _client_patch_component(f.data, proto_guid, new_guid, obj))
        );
        continue;
      }
      out.push(f);
    }
    return build_message(out);
  }

  function _client_build_entry(proto_entry_fields, new_guid, name, content_bytes) {
    var out = [];
    for (var i = 0; i < proto_entry_fields.length; i++) {
      var f = proto_entry_fields[i];
      if (f.tag === 1 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(1, _msg_set_varint(f.data, 4, new_guid)));
        continue;
      }
      if (f.tag === 3 && f.wire === WireType.LENGTH_DELIMITED) {
        out.push(_lenField(3, encodeUtf8(name)));
        continue;
      }
      if (f.tag === 19 && f.wire === WireType.LENGTH_DELIMITED) {
        var uf = parse_message_fields(f.data);
        var uo = [];
        for (var j = 0; j < uf.length; j++) {
          var g = uf[j];
          if (g.tag === 1 && g.wire === WireType.LENGTH_DELIMITED) {
            uo.push(_lenField(1, content_bytes));
          } else {
            uo.push(g);
          }
        }
        out.push(_lenField(19, build_message(uo)));
        continue;
      }
      out.push(f);
    }
    return build_message(out);
  }

  // ------------------------------------------------------------------
  // Container (primary resource) patching
  // ------------------------------------------------------------------

  /* Patch the container's object content. `mask_obj` is non-null only when
   * the container is acting as a mask; it then also carries the mask
   * shape's image ID, the mask rect as the container's own transform, the
   * transparent tint and the mask flag — all applied through the same
   * component patcher the children use, so unknown components survive. */
  function _client_patch_container_content(
    content,
    group_name,
    child_guids,
    container_guid,
    mask_obj
  ) {
    var fields = parse_message_fields(content);
    var out = [];
    var children_written = false;
    var name_written = false;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      // Drop every existing child list, in either wire form, so no stale
      // GUID survives; re-emit one packed list in the template's position.
      if (f.tag === 503) {
        if (!children_written) {
          if (child_guids.length)
            out.push(_lenField(503, encode_packed_varints(child_guids)));
          children_written = true;
        }
        continue;
      }
      if (f.tag === 505 && f.wire === WireType.LENGTH_DELIMITED) {
        var cf = parse_message_fields(f.data);
        var ctype = _find_varint(cf, 502);
        if (mask_obj) {
          // Name, transform, image settings and the mask flag all go
          // through the shared component patcher.
          out.push(
            _lenField(
              505,
              _client_patch_component(f.data, container_guid, container_guid, mask_obj)
            )
          );
          if (ctype === COMPONENT_TYPE.NAME) name_written = true;
          continue;
        }
        if (group_name && ctype === COMPONENT_TYPE.NAME) {
          var co = [];
          for (var j = 0; j < cf.length; j++) {
            var g = cf[j];
            if (
              g.tag === NAME_PAYLOAD_FIELD &&
              g.wire === WireType.LENGTH_DELIMITED
            ) {
              co.push(_lenField(g.tag, _client_name_payload(group_name)));
            } else {
              co.push(g);
            }
          }
          out.push(_lenField(505, build_message(co)));
          name_written = true;
          continue;
        }
      }
      out.push(f);
    }
    if (!children_written && child_guids.length) {
      out.push(_lenField(503, encode_packed_varints(child_guids)));
    }
    if (group_name && !name_written) {
      out.push(_lenField(505, _build_name_data(group_name).get_bytes()));
    }
    return build_message(out);
  }

  function _client_patch_primary_resource(
    pr_fields,
    removed_guids,
    new_refs,
    new_child_guids,
    group_name,
    container_guid,
    mask_obj
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
            new_ui_fields.push(
              _lenField(
                1,
                _client_patch_container_content(
                  uf.data,
                  group_name,
                  new_child_guids,
                  container_guid,
                  mask_obj
                )
              )
            );
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
        pr_writer.write_string(3, group_name);
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
  // Prototype discovery
  // ------------------------------------------------------------------

  function _client_read_entry_image_ref(content) {
    var fields = parse_message_fields(content);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.tag !== 505 || f.wire !== WireType.LENGTH_DELIMITED) continue;
      var cf = parse_message_fields(f.data);
      if (_find_varint(cf, 502) !== COMPONENT_TYPE.CLIENT_IMAGE) continue;
      var detail = null;
      for (var j = 0; j < cf.length; j++) {
        if (cf[j].tag === 503 && cf[j].wire === WireType.LENGTH_DELIMITED)
          detail = cf[j].data;
      }
      if (!detail) continue;
      var df = parse_message_fields(detail);
      for (var k = 0; k < df.length; k++) {
        if (
          df[k].tag === CLIENT_IMAGE_FIELD &&
          df[k].wire === WireType.LENGTH_DELIMITED
        ) {
          return _find_varint(
            parse_message_fields(df[k].data),
            CLIENT_IMAGE_REF_FIELD
          );
        }
      }
    }
    return null;
  }

  /* Pick the image child that every generated object is cloned from. The
   * reference's Square and Circle are byte-identical apart from name,
   * GUID, image ID and anchoredPosition, so the choice only has to be
   * deterministic; the rectangle is preferred so the un-patched bytes come
   * from the un-offset object. */
  function _client_find_prototype(root_fields) {
    var candidates = [];
    for (var i = 0; i < root_fields.length; i++) {
      if (root_fields[i][0] !== 2) continue;
      var val = root_fields[i][2];
      if (!_isBytes(val)) continue;
      var info = parse_resource_entry(val);
      if (info["class"] !== UI_IMAGE_CLASS) continue;
      var fields = parse_message_fields(val);
      var ui = null;
      for (var j = 0; j < fields.length; j++) {
        if (fields[j].tag === 19 && fields[j].wire === WireType.LENGTH_DELIMITED)
          ui = fields[j].data;
      }
      if (!ui) continue;
      var content = null;
      var uf = parse_message_fields(ui);
      for (var k = 0; k < uf.length; k++) {
        if (uf[k].tag === 1 && uf[k].wire === WireType.LENGTH_DELIMITED)
          content = uf[k].data;
      }
      if (!content) continue;
      candidates.push({
        guid: info["guid"],
        name: info["name"],
        entryFields: fields,
        content: content,
        imageRef: _client_read_entry_image_ref(content),
      });
    }
    if (!candidates.length) return null;
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].imageRef === DEFAULT_IMAGE_ASSET_REFS.rectangle)
        return candidates[c];
    }
    return candidates[0];
  }

  // ------------------------------------------------------------------
  // Client conversion entry point
  // ------------------------------------------------------------------

  /* The generated container is an image parent, so the template's must be
   * one too — its image and image-extra components are cloned, never
   * synthesized. (The mask toggle inside them is ours to set.) */
  function _client_template_container(pr_fields) {
    for (var i = 0; i < pr_fields.length; i++) {
      if (pr_fields[i].tag !== 19 || !("data" in pr_fields[i])) continue;
      var content = _find_bytes(parse_message_fields(pr_fields[i].data), 1);
      if (!content) continue;
      return _decodeObjectContent(content);
    }
    return null;
  }

  function _convert_client_image_mode(
    json_data,
    header,
    content_len,
    root_fields,
    tail
  ) {
    var scene = buildImageScene(json_data);
    var group_name = scene.group_name;
    var container = scene.clientContainer;

    var primary = _find_primary_resource(root_fields);
    if (!primary.data) {
      throw new Error("Client GIA template has no primary resource");
    }
    if (primary.resourceClass !== CLIENT_CONTAINER_CLASS) {
      throw new Error(
        "Client GIA template container is class " +
          primary.resourceClass +
          ", expected " +
          CLIENT_CONTAINER_CLASS +
          (primary.resourceClass === SERVER_CONTAINER_CLASS
            ? " (this is a Server Control Template)"
            : "")
      );
    }

    var templateContainer = _client_template_container(primary.fields);
    if (!templateContainer || !(templateContainer.imageAssetRef > 0)) {
      throw new Error(
        "Client GIA template's container is not an image parent — use " +
          "assets/client_mask_off_template.gia"
      );
    }
    if (
      !isFinite(container.offset_x) ||
      !isFinite(container.offset_y) ||
      !isFinite(container.size_x) ||
      !isFinite(container.size_y)
    ) {
      throw new Error("Client parent image has a non-finite transform");
    }
    if (scene.clientObjects.length && !(container.size_x > 0 && container.size_y > 0)) {
      throw new Error(
        "Client parent image is " +
          container.size_x +
          "×" +
          container.size_y +
          " — toggling the mask on would clip the whole image away"
      );
    }

    var removed_guids = _collect_entry_guids_of_class(root_fields, UI_IMAGE_CLASS);
    var prototype = _client_find_prototype(root_fields);
    if (!prototype) {
      throw new Error(
        "Client GIA template has no image child to use as a prototype"
      );
    }

    var allocator = _make_guid_allocator(root_fields, removed_guids);
    var parent_guid = primary.guid;

    // Client hierarchy order: earlier siblings are rendered first and are
    // therefore BEHIND later ones, so the children go out in painter order
    // (scene.clientObjects) — the reverse of the Server hierarchy. Entry
    // order, GUID allocation, the sibling index and the container's child
    // list all follow this one order, so nothing can disagree about
    // compositing.
    var new_entries = [];
    var new_child_guids = [];
    var new_refs = [];
    for (var i = 0; i < scene.clientObjects.length; i++) {
      var obj = scene.clientObjects[i];
      var new_guid = allocator.next();
      var content = _client_patch_child_content(
        prototype.content,
        prototype.guid,
        new_guid,
        parent_guid,
        obj
      );
      new_entries.push(
        _writer_from_bytes(
          _client_build_entry(
            prototype.entryFields,
            new_guid,
            obj.name,
            content
          )
        )
      );
      new_child_guids.push(new_guid);
      new_refs.push(create_reference_locator(new_guid, 8));
    }

    // The container is always an image parent: source-image rect,
    // invisible tint, mask toggle off unless explicitly asked for.
    var container_obj = {
      name: group_name,
      is_mask: !!container.mask_enabled,
      offset_x: container.offset_x,
      offset_y: container.offset_y,
      size_x: container.size_x,
      size_y: container.size_y,
      rot_z: 0.0,
      image_asset_ref: container.image_asset_ref,
      packed_color: container.packed_color,
    };

    var pr_bytes = _client_patch_primary_resource(
      primary.fields,
      removed_guids,
      new_refs,
      new_child_guids,
      group_name,
      parent_guid,
      container_obj
    );
    return _rebuild_gia(
      header,
      content_len,
      root_fields,
      tail,
      new_entries,
      pr_bytes,
      UI_IMAGE_CLASS
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Structural decoder — diagnostics, validation and tests
  //
  // `describeGia` decodes either flavour into one shared model so a Server
  // and a Client file can be compared field by field instead of byte by
  // byte. `tools/gia-diff.js` and the client validator both run on it.
  // ══════════════════════════════════════════════════════════════════

  var COMPONENT_TYPE_NAMES = {
    12: "transform",
    15: "name",
    23: "server:field14",
    38: "server:image-settings",
    56: "server:mask-settings",
    83: "client:unknown-83",
    86: "client:field14",
    90: "client:unknown-90",
    91: "client:unknown-91",
    96: "client:image-settings",
    97: "client:image-extra",
  };

  function _readFloat32(raw) {
    _floatView.setUint8(0, raw[0]);
    _floatView.setUint8(1, raw[1]);
    _floatView.setUint8(2, raw[2]);
    _floatView.setUint8(3, raw[3]);
    return _floatView.getFloat32(0, true);
  }

  function _find_fixed32(fields, tag) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag === tag && fields[i].wire === WireType.FIXED32)
        return _readFloat32(fields[i].raw);
    }
    return null;
  }

  function _find_bytes(fields, tag) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag === tag && fields[i].wire === WireType.LENGTH_DELIMITED)
        return fields[i].data;
    }
    return null;
  }

  function _find_all_bytes(fields, tag) {
    var out = [];
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].tag === tag && fields[i].wire === WireType.LENGTH_DELIMITED)
        out.push(fields[i].data);
    }
    return out;
  }

  /* Absent float fields mean zero — the in-game editor omits defaults while
   * this writer always emits them, so normalize before comparing. */
  function _readVector2(data) {
    if (data === null || data === undefined) return { x: 0, y: 0 };
    var f = parse_message_fields(data);
    return { x: _find_fixed32(f, 501) || 0, y: _find_fixed32(f, 502) || 0 };
  }

  function _readVector3(data) {
    if (data === null || data === undefined) return { x: 0, y: 0, z: 0 };
    var f = parse_message_fields(data);
    return {
      x: _find_fixed32(f, 1) || 0,
      y: _find_fixed32(f, 2) || 0,
      z: _find_fixed32(f, 3) || 0,
    };
  }

  function _readRotationZ(data) {
    if (data === null || data === undefined) return 0;
    return _find_fixed32(parse_message_fields(data), 3) || 0;
  }

  function _decodeRectTransform(rt) {
    var f = parse_message_fields(rt);
    return {
      scale: _readVector3(_find_bytes(f, 501)),
      anchorMin: _readVector2(_find_bytes(f, 502)),
      anchorMax: _readVector2(_find_bytes(f, 503)),
      offset: _readVector2(_find_bytes(f, 504)),
      size: _readVector2(_find_bytes(f, 505)),
      pivot: _readVector2(_find_bytes(f, 506)),
      rotationZ: _readRotationZ(_find_bytes(f, 508)),
    };
  }

  function _decodeTransformComponent(detail) {
    var df = parse_message_fields(detail);
    var payload = _find_bytes(df, CLIENT_TRANSFORM_FIELD);
    if (!payload) return null;
    var pf = parse_message_fields(payload);
    var mp = _find_bytes(pf, 12);
    if (!mp) return null;
    var mpf = parse_message_fields(mp);
    var platforms = _find_all_bytes(mpf, 501);
    var rects = [];
    for (var i = 0; i < platforms.length; i++) {
      var plf = parse_message_fields(platforms[i]);
      var rt = _find_bytes(plf, 502);
      if (rt) rects.push(_decodeRectTransform(rt));
    }
    if (!rects.length) return null;
    var agree = true;
    var first = JSON.stringify(rects[0]);
    for (var j = 1; j < rects.length; j++) {
      if (JSON.stringify(rects[j]) !== first) {
        agree = false;
        break;
      }
    }
    var out = rects[0];
    out.platformCount = platforms.length;
    out.platformDiscriminator = _find_varint(mpf, 502);
    out.platformsAgree = agree;
    return out;
  }

  function _decodeServerImageComponent(detail) {
    var df = parse_message_fields(detail);
    var payload = _find_bytes(df, 31);
    if (!payload) return null;
    var pf = parse_message_fields(payload);
    return {
      imageAssetRef: _find_varint(pf, 2),
      packedColor: _find_varint(pf, 4),
    };
  }

  function _decodeClientImageComponent(detail) {
    var df = parse_message_fields(detail);
    var payload = _find_bytes(df, CLIENT_IMAGE_FIELD);
    if (!payload) return null;
    var pf = parse_message_fields(payload);
    return {
      imageAssetRef: _find_varint(pf, CLIENT_IMAGE_REF_FIELD),
      packedColor: _find_varint(pf, CLIENT_IMAGE_COLOR_FIELD),
    };
  }

  /* The mask flag lives in the image-extra component's payload. It is the
   * ONLY structural difference between the masked and unmasked references,
   * and it appears on exactly one object: the parent that does the
   * clipping. */
  function _decodeClientImageExtra(detail) {
    var df = parse_message_fields(detail);
    var payload = _find_bytes(df, CLIENT_IMAGE_EXTRA_FIELD);
    if (!payload) return null;
    var pf = parse_message_fields(payload);
    var extraTags = [];
    for (var i = 0; i < pf.length; i++) extraTags.push(pf[i].tag);
    return {
      maskFlag: _find_varint(pf, CLIENT_MASK_FLAG_FIELD),
      payloadTags: extraTags,
    };
  }

  function _decodeServerMaskComponent(detail) {
    var df = parse_message_fields(detail);
    var payload = _find_bytes(df, 47);
    if (!payload) return null;
    var pf = parse_message_fields(payload);
    return {
      position: _readVector2(_find_bytes(pf, 1)),
      size: _readVector2(_find_bytes(pf, 2)),
      shapeType: _find_varint(pf, 3),
      enabled: _find_varint(pf, 4) === 1,
    };
  }

  function _decodeObjectContent(content) {
    var f = parse_message_fields(content);
    var out = {
      guid: _find_varint(f, 501),
      parentGuid: _find_varint(f, 504),
      index: null,
      childGuids: [],
      components: [],
      componentTypes: [],
      transform: null,
      imageAssetRef: null,
      packedColor: null,
      mask: null,
      isMask: false,
      maskFlag: null,
      infoSlots: [],
    };

    for (var i = 0; i < f.length; i++) {
      var fld = f[i];
      if (fld.tag === 503) {
        if (fld.wire === WireType.VARINT) {
          out.childGuids.push(fld.value);
        } else if (fld.wire === WireType.LENGTH_DELIMITED) {
          var r = new ProtoReader(fld.data);
          while (!r.eof()) out.childGuids.push(r.read_varint());
        }
        continue;
      }
      if (fld.tag === 502 && fld.wire === WireType.LENGTH_DELIMITED) {
        var inf = parse_message_fields(fld.data);
        var slot = _find_varint(inf, 501);
        out.infoSlots.push({ slot: slot, type: _find_varint(inf, 502) });
        if (slot === 2) {
          var idxMsg = _find_bytes(inf, 12);
          if (idxMsg) out.index = _find_varint(parse_message_fields(idxMsg), 501);
        }
        continue;
      }
      if (fld.tag !== 505 || fld.wire !== WireType.LENGTH_DELIMITED) continue;

      var cf = parse_message_fields(fld.data);
      var type = _find_varint(cf, 502);
      var detail = _find_bytes(cf, 503);
      var detailFields = detail ? parse_message_fields(detail) : [];
      var comp = {
        slot: _find_varint(cf, 501),
        type: type,
        typeName: COMPONENT_TYPE_NAMES[type] || "unknown",
        payloadTags: [],
        detailSlot: detail ? _find_varint(detailFields, 501) : null,
        detailType: detail ? _find_varint(detailFields, 502) : null,
        known: Object.prototype.hasOwnProperty.call(COMPONENT_TYPE_NAMES, type),
      };
      for (var t = 0; t < cf.length; t++) {
        if (cf[t].tag < 500) comp.payloadTags.push(cf[t].tag);
      }
      out.components.push(comp);
      out.componentTypes.push(type);

      if (type === COMPONENT_TYPE.NAME) {
        var nameMsg = _find_bytes(cf, NAME_PAYLOAD_FIELD);
        if (nameMsg) {
          var nb = _find_bytes(parse_message_fields(nameMsg), 501);
          out.componentName = nb ? decodeUtf8(nb) : "";
        }
      } else if (type === COMPONENT_TYPE.TRANSFORM && detail) {
        out.transform = _decodeTransformComponent(detail);
      } else if (type === COMPONENT_TYPE.SERVER_IMAGE && detail) {
        var si = _decodeServerImageComponent(detail);
        if (si) {
          out.imageAssetRef = si.imageAssetRef;
          out.packedColor = si.packedColor;
        }
      } else if (type === COMPONENT_TYPE.CLIENT_IMAGE && detail) {
        var ci = _decodeClientImageComponent(detail);
        if (ci) {
          out.imageAssetRef = ci.imageAssetRef;
          out.packedColor = ci.packedColor;
        }
      } else if (type === COMPONENT_TYPE.CLIENT_IMAGE_EXTRA && detail) {
        var ce = _decodeClientImageExtra(detail);
        if (ce) {
          out.isMask = ce.maskFlag === 1;
          out.maskFlag = ce.maskFlag;
          out.imageExtraTags = ce.payloadTags;
        }
      } else if (type === COMPONENT_TYPE.SERVER_MASK && detail) {
        out.mask = _decodeServerMaskComponent(detail);
      }
    }
    return out;
  }

  function _decodeResource(bytes, isPrimary) {
    var fields = parse_message_fields(bytes);
    var info = parse_resource_entry(bytes);
    var obj = {
      role: isPrimary ? "container" : "child",
      resourceClass: info["class"],
      resourceName: info["name"],
      guid: info["guid"],
      byteLength: bytes.length,
      referenceGuids: [],
      fieldTags: [],
    };
    for (var i = 0; i < fields.length; i++) {
      obj.fieldTags.push(fields[i].tag);
      if (fields[i].tag === 2 && fields[i].wire === WireType.LENGTH_DELIMITED) {
        obj.referenceGuids.push(check_locator_guid(fields[i].data));
      }
    }
    var ui = _find_bytes(fields, 19);
    if (ui) {
      var content = _find_bytes(parse_message_fields(ui), 1);
      if (content) {
        var decoded = _decodeObjectContent(content);
        for (var k in decoded) {
          if (Object.prototype.hasOwnProperty.call(decoded, k)) obj[k] = decoded[k];
        }
      }
    }
    obj.hasDecorationPayload = !!_find_bytes(fields, 21);
    return obj;
  }

  function describeGia(input) {
    var data = toUint8(input);
    var parsed = _parse_gia_root_fields(data);
    var out = {
      byteLength: data.length,
      header: {
        fileSizeField: intFromBytesBE(parsed.header, 0, 4),
        middleHex: Array.prototype.map
          .call(parsed.header.subarray(4, 16), function (b) {
            return (b < 16 ? "0" : "") + b.toString(16);
          })
          .join(""),
        contentLength: parsed.content_len,
      },
      tailHex: Array.prototype.map
        .call(parsed.tail, function (b) {
          return (b < 16 ? "0" : "") + b.toString(16);
        })
        .join(""),
      rootTags: [],
      sourcePath: null,
      version: null,
      isClassic: false,
      container: null,
      children: [],
    };

    for (var i = 0; i < parsed.root_fields.length; i++) {
      var tag = parsed.root_fields[i][0];
      var val = parsed.root_fields[i][2];
      out.rootTags.push(tag);
      if (tag === 1 && _isBytes(val)) {
        out.container = _decodeResource(val, true);
      } else if (tag === 2 && _isBytes(val)) {
        out.children.push(_decodeResource(val, false));
      } else if (tag === 3 && _isBytes(val)) {
        out.sourcePath = decodeUtf8(val);
      } else if (tag === 4) {
        out.isClassic = true;
      } else if (tag === 5 && _isBytes(val)) {
        out.version = decodeUtf8(val);
      }
    }

    var cls = out.container ? out.container.resourceClass : null;
    out.templateKind =
      cls === CLIENT_CONTAINER_CLASS
        ? "client"
        : cls === SERVER_CONTAINER_CLASS
        ? "server"
        : "unknown";
    out.containerClass = cls;
    out.maskRelationships = _describeMaskRelationships(out);
    return out;
  }

  /* Mask relationships, resolved to a human-readable tree. A Client mask is
   * a parent→children relationship carried by the masking object, so the
   * "content" of a mask is simply its child list. */
  function _describeMaskRelationships(model) {
    var out = [];
    var all = [];
    if (model.container) all.push(model.container);
    for (var i = 0; i < model.children.length; i++) all.push(model.children[i]);

    var byGuid = Object.create(null);
    for (var g = 0; g < all.length; g++) byGuid[all[g].guid] = all[g];

    for (var n = 0; n < all.length; n++) {
      var node = all[n];
      if (node.isMask) {
        var content = [];
        for (var c = 0; c < (node.childGuids || []).length; c++) {
          var kid = byGuid[node.childGuids[c]];
          content.push({
            guid: node.childGuids[c],
            name: kid ? kid.resourceName : null,
            resolved: !!kid,
            imageAssetRef: kid ? kid.imageAssetRef : null,
            transform: kid ? kid.transform : null,
          });
        }
        out.push({
          kind: "client",
          via: "parent→children (hierarchy); no GUID reference either way",
          maskGuid: node.guid,
          maskName: node.resourceName,
          maskImageAssetRef: node.imageAssetRef,
          maskPackedColor: node.packedColor,
          maskGraphicVisible: ((node.packedColor >>> 24) & 255) !== 0,
          maskTransform: node.transform,
          maskFlagField: "505[type 97].503.85.501",
          content: content,
        });
      }
      if (node.mask) {
        out.push({
          kind: "server",
          via: "mask-settings component on the container (own geometry)",
          maskGuid: node.guid,
          maskName: node.resourceName,
          settings: node.mask,
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Client output validation
  // ------------------------------------------------------------------

  /* Runs before a Client Image download is offered. `expected` is optional:
   *   {groupName, objects}  — the scene the bytes were generated from. */
  function validateClientImage(input, expected) {
    var errors = [];
    var warnings = [];
    var model = null;
    try {
      model = describeGia(input);
    } catch (e) {
      return {
        ok: false,
        errors: ["Generated file does not parse: " + (e && e.message)],
        warnings: warnings,
        model: null,
      };
    }
    expected = expected || {};

    if (!model.container) {
      errors.push("No container (primary resource) in the generated file");
      return { ok: false, errors: errors, warnings: warnings, model: model };
    }

    var container = model.container;
    if (container.resourceClass !== CLIENT_CONTAINER_CLASS) {
      errors.push(
        "Container resource class is " +
          container.resourceClass +
          ", expected the Client Control Template class " +
          CLIENT_CONTAINER_CLASS
      );
    }
    if (container.resourceName === "Image Container") {
      errors.push(
        'Container is still named "Image Container" — it must take the image name'
      );
    }
    if (!container.resourceName) {
      errors.push("Container has no name");
    }
    if (expected.groupName && container.resourceName !== expected.groupName) {
      errors.push(
        'Container name is "' +
          container.resourceName +
          '", expected "' +
          expected.groupName +
          '"'
      );
    }
    if (container.componentName !== undefined && container.componentName !== container.resourceName) {
      errors.push(
        "Container resource name and name component disagree (" +
          container.resourceName +
          " vs " +
          container.componentName +
          ")"
      );
    }

    var childGuids = container.childGuids || [];
    var entryGuids = [];
    var seen = Object.create(null);
    for (var i = 0; i < model.children.length; i++) {
      var child = model.children[i];
      var label = 'child "' + child.resourceName + '"';
      if (child.resourceClass !== UI_IMAGE_CLASS) {
        errors.push(label + " has class " + child.resourceClass + ", expected " + UI_IMAGE_CLASS);
      }
      if (!child.guid) {
        errors.push(label + " has no GUID");
      } else if (seen[child.guid]) {
        errors.push("Duplicate GUID " + child.guid + " (" + label + ")");
      } else {
        seen[child.guid] = true;
      }
      if (child.guid === container.guid) {
        errors.push(label + " reuses the container GUID " + container.guid);
      }
      if (child.parentGuid !== container.guid) {
        errors.push(
          label + " points at parent " + child.parentGuid + ", expected " + container.guid
        );
      }
      if (!child.transform) {
        errors.push(label + " has no transform");
      } else {
        var tvals = [
          child.transform.offset.x,
          child.transform.offset.y,
          child.transform.size.x,
          child.transform.size.y,
          child.transform.rotationZ,
        ];
        for (var t = 0; t < tvals.length; t++) {
          if (!isFinite(tvals[t])) {
            errors.push(label + " has a non-finite transform value");
            break;
          }
        }
      }
      if (
        !(typeof child.imageAssetRef === "number" && child.imageAssetRef > 0)
      ) {
        errors.push(label + " has no valid image ID (got " + child.imageAssetRef + ")");
      }
      if (
        !(typeof child.packedColor === "number" && child.packedColor >= 0)
      ) {
        errors.push(label + " has no valid packed colour");
      }
      for (var s = 0; s < SERVER_ONLY_COMPONENT_TYPES.length; s++) {
        if (child.componentTypes.indexOf(SERVER_ONLY_COMPONENT_TYPES[s]) >= 0) {
          errors.push(
            label +
              " carries Server-only component type " +
              SERVER_ONLY_COMPONENT_TYPES[s]
          );
        }
      }
      entryGuids.push(child.guid);
    }

    for (var c = 0; c < SERVER_ONLY_COMPONENT_TYPES.length; c++) {
      if (
        (container.componentTypes || []).indexOf(SERVER_ONLY_COMPONENT_TYPES[c]) >= 0
      ) {
        errors.push(
          "Container carries Server-only component type " +
            SERVER_ONLY_COMPONENT_TYPES[c]
        );
      }
    }

    // Child list / entry list / reference list must agree exactly.
    if (childGuids.length !== entryGuids.length) {
      errors.push(
        "Container lists " +
          childGuids.length +
          " children but the file has " +
          entryGuids.length +
          " image entries"
      );
    }
    for (var g = 0; g < childGuids.length; g++) {
      if (entryGuids.indexOf(childGuids[g]) < 0) {
        errors.push("Dangling child reference: GUID " + childGuids[g] + " has no entry");
      }
    }
    for (var e = 0; e < entryGuids.length; e++) {
      if (childGuids.indexOf(entryGuids[e]) < 0) {
        errors.push("Image entry " + entryGuids[e] + " is not listed as a container child");
      }
    }
    var refs = container.referenceGuids || [];
    for (var r = 0; r < entryGuids.length; r++) {
      if (refs.indexOf(entryGuids[r]) < 0) {
        errors.push("Image entry " + entryGuids[r] + " has no container reference locator");
      }
    }

    // Compositing order. The container's child list IS the render order —
    // earlier siblings are drawn first and sit behind later ones — so it
    // must match the expected painter order exactly, and the sibling index
    // stored on each child must agree with its position in that list.
    var entryByGuid = Object.create(null);
    for (var b = 0; b < model.children.length; b++) {
      entryByGuid[model.children[b].guid] = model.children[b];
    }
    for (var p = 0; p < childGuids.length; p++) {
      var listed = entryByGuid[childGuids[p]];
      if (!listed) continue; // already reported as dangling
      if (listed.index !== p + 2) {
        errors.push(
          'Image object "' +
            listed.resourceName +
            '" is at hierarchy position ' +
            p +
            " but carries sibling index " +
            listed.index +
            " (expected " +
            (p + 2) +
            ") — render order is ambiguous"
        );
      }
    }

    if (expected.objects) {
      if (expected.objects.length !== model.children.length) {
        errors.push(
          "Generated " +
            model.children.length +
            " image objects, expected " +
            expected.objects.length
        );
      } else {
        var byName = Object.create(null);
        for (var m = 0; m < model.children.length; m++) {
          byName[model.children[m].resourceName] = model.children[m];
        }
        for (var o = 0; o < expected.objects.length; o++) {
          var want = expected.objects[o];
          var got = byName[want.name];
          if (!got) {
            errors.push('Expected image object "' + want.name + '" is missing');
            continue;
          }
          if (got.imageAssetRef !== want.image_asset_ref) {
            errors.push(
              'Image object "' +
                want.name +
                '" has ID ' +
                got.imageAssetRef +
                ", expected " +
                want.image_asset_ref
            );
          }
          // expected.objects is in Client hierarchy (painter) order.
          if (childGuids.length === expected.objects.length) {
            var atPos = entryByGuid[childGuids[o]];
            if (atPos && atPos.resourceName !== want.name) {
              errors.push(
                "Hierarchy position " +
                  o +
                  ' holds "' +
                  atPos.resourceName +
                  '" but the render order requires "' +
                  want.name +
                  '" — overlapping primitives would composite in the wrong order'
              );
            }
          }
        }
      }
    }

    // ── the parent image and the mask toggle ──────────────────────────
    // Every Client group gets an image parent sized to the source image,
    // so the in-game mask toggle clips to exactly what the source shows.
    // The toggle itself is off unless the caller asked for it.
    var wantMask = !!(expected.container && expected.container.mask_enabled);

    if (!(typeof container.imageAssetRef === "number" && container.imageAssetRef > 0)) {
      errors.push(
        "The container is not an image parent (image ID " +
          container.imageAssetRef +
          ") — the in-game mask toggle would have nothing to clip to"
      );
    }
    if (((container.packedColor >>> 24) & 255) !== 0) {
      warnings.push(
        "The parent image is not fully transparent, so it will be drawn" +
          " behind the group instead of only clipping when toggled on."
      );
    }
    if (container.isMask !== wantMask) {
      errors.push(
        wantMask
          ? "The mask toggle should be on but the container does not carry it"
          : "The mask toggle should be off by default but the container carries it"
      );
    }
    for (var mc = 0; mc < model.children.length; mc++) {
      if (model.children[mc].isMask) {
        errors.push(
          'Image object "' +
            model.children[mc].resourceName +
            '" carries the mask toggle — only the parent may mask'
        );
      }
    }
    if (!container.transform) {
      errors.push("The container has no transform");
    } else {
      var mt = container.transform;
      var mvals = [mt.offset.x, mt.offset.y, mt.size.x, mt.size.y];
      for (var mv = 0; mv < mvals.length; mv++) {
        if (!isFinite(mvals[mv])) {
          errors.push("The parent image rect has a non-finite value");
          break;
        }
      }
      if (model.children.length && !(mt.size.x > 0 && mt.size.y > 0)) {
        errors.push(
          "The parent image rect is " +
            mt.size.x +
            "×" +
            mt.size.y +
            " — toggling the mask on would clip the whole image away"
        );
      }
      if (expected.container) {
        if (
          Math.abs(mt.size.x - expected.container.size_x) > 1e-3 ||
          Math.abs(mt.size.y - expected.container.size_y) > 1e-3
        ) {
          errors.push(
            "Parent image is " +
              mt.size.x +
              "×" +
              mt.size.y +
              ", expected the source image rect " +
              expected.container.size_x +
              "×" +
              expected.container.size_y
          );
        }
        if (
          Math.abs(mt.offset.x - expected.container.offset_x) > 1e-3 ||
          Math.abs(mt.offset.y - expected.container.offset_y) > 1e-3
        ) {
          errors.push(
            "Parent image is at (" +
              mt.offset.x +
              ", " +
              mt.offset.y +
              "), expected (" +
              expected.container.offset_x +
              ", " +
              expected.container.offset_y +
              ")"
          );
        }
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings, model: model };
  }

  // ------------------------------------------------------------------
  // Top-level conversion
  // ------------------------------------------------------------------

  /* `baseGiaBytes` is the template to build on. MODE_CLIENT_IMAGE wants
   * assets/client_mask_off_template.gia — an image-parent container with
   * the mask toggle off, which is the shape every Client export takes. */
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
    if (mode === MODE_CLIENT_IMAGE) {
      return _convert_client_image_mode(
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
    var scene = buildImageScene(json_data);
    var group_name = scene.group_name;
    var mask_settings = scene.mask;

    var removed_guids = _collect_entry_guids_of_class(root_fields, UI_IMAGE_CLASS);
    var i;

    var primary = _find_primary_resource(root_fields);
    var pr_fields = primary.fields;
    var parent_guid = primary.guid;

    var allocator = _make_guid_allocator(root_fields, removed_guids);

    var new_image_entries = [];
    var new_refs = [];
    var new_child_guids = [];

    var ordered_elements = scene.ordered;
    var serialized_elements = scene.serialized;
    var indexed_items = [];

    for (i = 0; i < scene.objects.length; i++) {
      var obj = scene.objects[i];
      var new_guid = allocator.next();

      var ui_content = create_ui_image_payload({
        guid: new_guid,
        index: obj.index,
        parent_guid: parent_guid,
        offset_x: obj.offset_x,
        offset_y: obj.offset_y,
        size_x: obj.size_x,
        size_y: obj.size_y,
        image_asset_ref: obj.image_asset_ref,
        packed_color: obj.packed_color,
        rot_z: obj.rot_z,
        pivot_x: 0.5,
        pivot_y: 0.5,
        name: obj.name,
      });

      indexed_items.push({
        element: obj.element, // identity key (mirror Python id(element))
        guid: new_guid,
        name: obj.name,
        entry: create_ui_image_entry(new_guid, obj.name, ui_content),
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
    MODE_CLIENT_IMAGE: MODE_CLIENT_IMAGE,
    SERVER_CONTAINER_CLASS: SERVER_CONTAINER_CLASS,
    CLIENT_CONTAINER_CLASS: CLIENT_CONTAINER_CLASS,
    UI_IMAGE_CLASS: UI_IMAGE_CLASS,
    COMPONENT_TYPE: COMPONENT_TYPE,
    DEFAULT_IMAGE_ASSET_REFS: DEFAULT_IMAGE_ASSET_REFS,
    convertJsonToGiaBytes: convertJsonToGiaBytes,
    buildImageScene: buildImageScene,
    describeGia: describeGia,
    validateClientImage: validateClientImage,
    toClassic: toClassic,
    toOverlimit: toOverlimit,
  };
})();

if (typeof module !== "undefined") module.exports = GIA;

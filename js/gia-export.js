/*
 * gia-export.js — exact port of server.py's _convert_result_to_gia_bytes
 * glue (result data → json_data for the GIA writer). Kept as a standalone
 * module so the parity suite can byte-compare it against the Python
 * original in Node.
 *
 * NOTE: server.py builds fresh element dicts and does NOT forward
 * `is_background` — the writer therefore never sees the flag from the web
 * pipeline. Preserve that behavior exactly.
 */
"use strict";

const GiaExport = (() => {

  const DEFAULT_IMAGE_ASSET_REFS = { rectangle: 100001, ellipse: 100002, triangle: 100003 };

  /* server.py _derive_upload_image_name + _export_basename */
  function exportBasename(imageName) {
    const base = String(imageName || "").trim().split(/[\\/]/).pop() || "";
    const stem = base.replace(/\.[^.]*$/, "").trim();
    if (stem) return stem;
    return String(imageName || "").trim() || "shaper_result";
  }

  function convertResultToGiaJson(resultData, cfg, imageName, originX, originY) {
    cfg = cfg || {};
    const pixelPerUnit = Number(
      (resultData.config && resultData.config.pixel_per_unit) || cfg.primitive_size || 1.0
    );
    const originUnitsX = originX / pixelPerUnit;
    const originUnitsY = -originY / pixelPerUnit;

    const elements = [];
    for (const element of resultData.elements || []) {
      let shapeType = element.type;
      if (shapeType === "circle") shapeType = "ellipse";
      else if (shapeType === "rect") shapeType = "rectangle";

      // Python: rotation = element.get("rotation", {}) or {} — a numeric
      // rotation (fill background element uses 0.0) is falsy → {}
      const rawRotation = element.rotation;
      const rotation = (rawRotation && typeof rawRotation === "object") ? rawRotation : {};
      const center = element.center || {};
      const exported = {
        type: shapeType,
        relative: {
          x: Number(center.x || 0) - originUnitsX,
          y: Number(center.y || 0) - originUnitsY,
        },
        size: element.size !== undefined ? element.size : {},
        rotation,
        color: element.color !== undefined ? element.color : null,
        alpha: element.alpha !== undefined ? element.alpha : null,
        packed_color: element.packed_color !== undefined ? element.packed_color : null,
        primitive_type: element.primitive_type,
        image_type: element.image_type,
        image_asset_ref: element.image_asset_ref !== undefined
          ? element.image_asset_ref
          : (DEFAULT_IMAGE_ASSET_REFS[shapeType] !== undefined ? DEFAULT_IMAGE_ASSET_REFS[shapeType] : 100002),
      };
      if (element.type_id !== undefined && element.type_id !== null) {
        exported.type_id = Math.trunc(element.type_id);
      } else if (element.element_type_id !== undefined && element.element_type_id !== null) {
        exported.type_id = Math.trunc(element.element_type_id);
      }
      if (element.element_type_id !== undefined && element.element_type_id !== null) {
        exported.element_type_id = Math.trunc(element.element_type_id);
      }
      if (rotation.y !== undefined && rotation.y !== null) {
        exported.rot_y_add = Number(rotation.y || 0);
      }
      elements.push(exported);
    }

    let maskCfg = null;
    const maskData = resultData.mask || null;
    if (maskData && Object.keys(maskData).length) {
      const maskCenter = maskData.center || {};
      const maskSize = maskData.size || {};
      maskCfg = {
        enabled: Boolean(maskData.enabled),
        shape_type: maskData.shape_type !== undefined ? maskData.shape_type : "rectangle",
        center: {
          x: Number(maskCenter.x || 0) - originUnitsX,
          y: Number(maskCenter.y || 0) - originUnitsY,
        },
        size: {
          width: Number(maskSize.width || 0),
          height: Number(maskSize.height || 0),
        },
      };
    }

    /* The source image rectangle, in the same local space as each element's
     * `relative` offset. The Client exporter makes this the group's parent
     * image, so toggling the in-game mask clips exactly to the source
     * image. The Server writer ignores the key. */
    const imageSize = resultData.image_size || {};
    const imageWidth = Number(imageSize.width || 0);
    const imageHeight = Number(imageSize.height || 0);
    const imageBounds = {
      x: imageWidth / 2 / pixelPerUnit - originUnitsX,
      y: -(imageHeight / 2) / pixelPerUnit - originUnitsY,
      width: imageWidth / pixelPerUnit,
      height: imageHeight / pixelPerUnit,
    };

    return {
      elements,
      mask: maskCfg,
      image_bounds: imageBounds,
      group_name: exportBasename(imageName),
    };
  }

  // Asset Groups clip to the source image by default. Apply this only at
  // the Asset Group export boundary: Client/Server exports share the source
  // JSON and have separate masking semantics.
  function withAssetGroupMask(json) {
    const bounds = json.image_bounds;
    if (!bounds || !(bounds.width > 0 && bounds.height > 0)) {
      throw new Error("Asset Group mask requires valid source image bounds");
    }
    return { ...json, mask: { enabled: true, shape_type: "rectangle",
      center: { x: bounds.x, y: bounds.y },
      size: { width: bounds.width, height: bounds.height } } };
  }

  return { convertResultToGiaJson, withAssetGroupMask, exportBasename, DEFAULT_IMAGE_ASSET_REFS };
})();

if (typeof module !== "undefined") module.exports = GiaExport;

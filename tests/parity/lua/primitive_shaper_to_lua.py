import json
import math
import sys
from pathlib import Path


ELLIPSE = 1
RECTANGLE = 2
TRIANGLE = 3


def round_nearest(value):
    if value >= 0:
        return math.floor(value + 0.5)

    return math.ceil(value - 0.5)


def quantize_to_tenths(value):
    return round_nearest(float(value) * 10)


def format_number(value):
    if float(value).is_integer():
        return str(int(value))

    return ("%.4f" % float(value)).rstrip("0").rstrip(".")


def convert_json_to_lua(source_path, output_path):
    source_path = Path(source_path)
    output_path = Path(output_path)

    data = json.loads(
        source_path.read_text(encoding="utf-8")
    )

    image_scale = float(
        data.get("config", {}).get("image_scale", 1) or 1
    )

    original_width = float(data["image_size"]["width"])
    original_height = float(data["image_size"]["height"])

    source_width = original_width * image_scale
    source_height = original_height * image_scale

    primitives = []

    ellipse_count = 0
    rectangle_count = 0
    triangle_count = 0

    for element in data["elements"]:
        element_type = element["type"]

        if element_type == "ellipse":
            type_code = ELLIPSE

            extent_x = float(element["size"]["rx"])
            extent_y = float(element["size"]["ry"])

            ellipse_count += 1

        elif element_type == "rectangle":
            type_code = RECTANGLE

            extent_x = float(element["size"]["width"]) * 0.5
            extent_y = float(element["size"]["height"]) * 0.5

            rectangle_count += 1

        elif element_type == "triangle":
            type_code = TRIANGLE

            extent_x = float(element["size"]["width"]) * 0.5
            extent_y = float(element["size"]["height"]) * 0.5

            triangle_count += 1

        else:
            raise ValueError(
                "Unsupported primitive type: "
                + str(element_type)
            )

        primitives.append(
            (
                type_code,

                quantize_to_tenths(
                    element["relative"]["x"]
                ),

                quantize_to_tenths(
                    element["relative"]["y"]
                ),

                quantize_to_tenths(extent_x),
                quantize_to_tenths(extent_y),

                quantize_to_tenths(
                    element["rotation"]["z"]
                ),

                int(element["packed_color"]),
            )
        )

    lines = [
        "return {",

        f'    name = "{data["image_name"]}",',

        (
            "    sourceWidth = "
            + format_number(source_width)
            + ","
        ),

        (
            "    sourceHeight = "
            + format_number(source_height)
            + ","
        ),

        (
            "    originalWidth = "
            + format_number(original_width)
            + ","
        ),

        (
            "    originalHeight = "
            + format_number(original_height)
            + ","
        ),

        "    circleAsset = 100002,",
        "    rectangleAsset = 100001,",
        "    triangleAsset = 100003,",

        f"    primitiveCount = {len(primitives)},",
        f"    ellipseCount = {ellipse_count},",
        f"    rectangleCount = {rectangle_count},",
        f"    triangleCount = {triangle_count},",

        "    primitives = {",
    ]

    for primitive in primitives:
        lines.append(
            "        {"
            + ",".join(
                str(value)
                for value in primitive
            )
            + "},"
        )

    lines.extend(
        [
            "    },",
            "}",
            "",
        ]
    )

    output_path.write_text(
        "\n".join(lines),
        encoding="utf-8",
    )

    print(f"Converted {source_path.name}")
    print(f"  Total: {len(primitives)}")
    print(f"  Ellipses: {ellipse_count}")
    print(f"  Rectangles: {rectangle_count}")
    print(f"  Triangles: {triangle_count}")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: python primitive_shaper_to_lua.py "
            "input.json output.lua"
        )

    convert_json_to_lua(
        sys.argv[1],
        sys.argv[2],
    )

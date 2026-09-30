local PrimitiveImage = {}

local configuredImageTemplate = nil

local ELLIPSE = 1
local RECTANGLE = 2
local TRIANGLE = 3

local DEFAULT_CIRCLE_ASSET = 100002
local DEFAULT_RECTANGLE_ASSET = 100001
local DEFAULT_TRIANGLE_ASSET = 100003

local function Clamp(value, minimum, maximum)
    return math.max(minimum, math.min(value, maximum))
end

local function Round(value)
    return math.floor(value + 0.5)
end

local function DecodeColor(packedColor, opacity)
    local alpha = math.floor(packedColor / 16777216)
    local rgb = packedColor - alpha * 16777216

    local red = math.floor(rgb / 65536)
    local greenBlue = rgb - red * 65536
    local green = math.floor(greenBlue / 256)
    local blue = greenBlue - green * 256

    alpha = Clamp(
        Round(alpha * Clamp(tonumber(opacity) or 1, 0, 1)),
        0,
        255
    )

    return Color.FromRGBA(red, green, blue, alpha)
end

local function ResolveSize(sourceWidth, sourceHeight, props)
    local width = tonumber(props.width)
    local height = tonumber(props.height)

    if width == nil and height == nil then
        width = sourceWidth
        height = sourceHeight
    elseif height == nil then
        height = width * sourceHeight / sourceWidth
    elseif width == nil then
        width = height * sourceWidth / sourceHeight
    end

    return width, height
end

local function ConfigureControlRect(control, x, y, width, height, rotation)
    control:SetAnchorMin(0.5, 0.5)
    control:SetAnchorMax(0.5, 0.5)
    control:SetPivot(0.5, 0.5)
    control:SetSizeDelta(width, height)
    control:SetAnchoredPosition(x, y)

    if rotation ~= nil then
        control:SetLocalRotation(0, 0, rotation)
    end
end

local function CreateImageControl(templateIndex, parent, imageAsset, color)
    local control = game.InstantiateClientUIControl(templateIndex, parent)

    assert(
        control ~= nil,
        "PrimitiveImage failed to instantiate the configured Image Control Template"
    )

    control:SetActive(true)
    control:SetVisible(true)
    control:SetImage(Enum.ImageSource.StaticReference, imageAsset)
    control.imageColor = color
    control.imageType = Enum.ImageType.Stretch

    return control
end

function PrimitiveImage.Configure(imageTemplateIndex)
    assert(
        type(imageTemplateIndex) == "number",
        "PrimitiveImage.Configure requires an Image Control Template index"
    )

    configuredImageTemplate = imageTemplateIndex
end

function PrimitiveImage.Create(parent, art, props)
    assert(parent ~= nil, "PrimitiveImage.Create requires a parent UI control")
    assert(type(art) == "table", "PrimitiveImage.Create requires converted image data")
    assert(type(art.primitives) == "table", "Converted image data is missing primitives")

    props = props or {}

    local imageTemplate = tonumber(props.imageTemplate) or configuredImageTemplate

    assert(
        imageTemplate ~= nil,
        "PrimitiveImage has no Image Control Template. Call PrimitiveImage.Configure(templateIndex) first, or pass imageTemplate in props."
    )

    local sourceWidth = tonumber(art.sourceWidth) or 1
    local sourceHeight = tonumber(art.sourceHeight) or 1
    local width, height = ResolveSize(sourceWidth, sourceHeight, props)

    local rectangleAsset = tonumber(art.rectangleAsset) or DEFAULT_RECTANGLE_ASSET
    local circleAsset = tonumber(art.circleAsset) or DEFAULT_CIRCLE_ASSET
    local triangleAsset = tonumber(art.triangleAsset) or DEFAULT_TRIANGLE_ASSET

    local transparent = Color.FromRGBA(255, 255, 255, 0)

    local root = CreateImageControl(
        imageTemplate,
        parent,
        rectangleAsset,
        transparent
    )

    ConfigureControlRect(
        root,
        tonumber(props.x) or 0,
        tonumber(props.y) or 0,
        width,
        height,
        tonumber(props.rotation)
    )

    if props.clip == true then
        root.enableMask = true
        root.enableSoftEdge = false
        root.reverseMaskArea = false
    else
        root.enableMask = false
    end

    local canvas = CreateImageControl(
        imageTemplate,
        root,
        rectangleAsset,
        transparent
    )

    ConfigureControlRect(
        canvas,
        0,
        0,
        sourceWidth,
        sourceHeight,
        nil
    )

    local mirrorX = props.mirrorX == true and -1 or 1
    local mirrorY = props.mirrorY == true and -1 or 1

    local function ApplyCanvasScale(targetWidth, targetHeight)
        canvas:SetLocalScale(
            targetWidth / sourceWidth * mirrorX,
            targetHeight / sourceHeight * mirrorY,
            1
        )
    end

    ApplyCanvasScale(width, height)

    local opacity = Clamp(tonumber(props.opacity) or 1, 0, 1)
    local quality = Clamp(tonumber(props.quality) or 1, 0.01, 1)

    local primitiveLimit = math.max(
        1,
        math.min(
            #art.primitives,
            math.floor(#art.primitives * quality + 0.5)
        )
    )

    local controls = {}

    for index = 1, primitiveLimit do
        local primitive = art.primitives[index]

        local primitiveType = primitive[1]
        local centerX = primitive[2] * 0.1
        local centerY = primitive[3] * 0.1
        local extentX = primitive[4] * 0.1
        local extentY = primitive[5] * 0.1
        local rotationZ = primitive[6] * 0.1
        local packedColor = primitive[7]

        local imageAsset

        if primitiveType == ELLIPSE then
            imageAsset = circleAsset
        elseif primitiveType == RECTANGLE then
            imageAsset = rectangleAsset
        elseif primitiveType == TRIANGLE then
            imageAsset = triangleAsset
        else
            error(
                "PrimitiveImage encountered unsupported primitive type "
                .. tostring(primitiveType)
            )
        end

        local control = CreateImageControl(
            imageTemplate,
            canvas,
            imageAsset,
            DecodeColor(packedColor, opacity)
        )

        ConfigureControlRect(
            control,
            centerX,
            centerY,
            extentX * 2,
            extentY * 2,
            rotationZ
        )

        control:SetSiblingIndex(index - 1)
        controls[index] = control
    end

    local object = {
        root = root,
        canvas = canvas,
        controls = controls,
        art = art,
        width = width,
        height = height,
        primitiveCount = primitiveLimit,
    }

    function object:SetVisible(visible)
        self.root:SetVisible(visible == true)
        return self
    end

    function object:SetPosition(x, y)
        self.root:SetAnchoredPosition(
            tonumber(x) or 0,
            tonumber(y) or 0
        )

        return self
    end

    function object:SetSize(newWidth, newHeight)
        newWidth = tonumber(newWidth) or self.width
        newHeight = tonumber(newHeight)

        if newHeight == nil then
            newHeight = newWidth * sourceHeight / sourceWidth
        end

        self.width = newWidth
        self.height = newHeight

        self.root:SetSizeDelta(newWidth, newHeight)
        ApplyCanvasScale(newWidth, newHeight)

        return self
    end

    function object:Destroy()
        if self.root ~= nil and self.root.alive then
            game.DestroyClientUIControl(self.root)
        end

        self.root = nil
        self.canvas = nil
        self.controls = {}
    end

    return object
end

return PrimitiveImage

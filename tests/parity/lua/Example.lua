local PrimitiveImage = require("PrimitiveImage")
local MyImage = require("MyImage")

local IMAGE_TEMPLATE_INDEX = 1234567890

local artwork = nil

function OnStart()
    PrimitiveImage.Configure(IMAGE_TEMPLATE_INDEX)

    artwork = PrimitiveImage.Create(
        script.object,
        MyImage,
        {
            width = 600,
        }
    )
end

function OnDestroy()
    if artwork ~= nil then
        artwork:Destroy()
        artwork = nil
    end
end

use image::{DynamicImage, GenericImageView, Pixel, RgbImage, imageops};
use primeval_core::Color;

/// Resize an opaque image so its longest side is at most `max_size`,
/// preserving aspect ratio, and return its RGB channels. Consumes the image
/// so the full-resolution pixels are freed as soon as the thumbnail exists.
///
/// 8-bit RGB is resampled directly; other formats are resampled as 8-bit
/// RGBA, every channel independently, and the alpha channel is dropped at
/// thumbnail size.
///
/// Neither side drops below 2 pixels: the engine needs a working canvas of
/// at least 2 x 2, and callers reject inputs smaller than that.
pub(crate) fn thumbnail(image: DynamicImage, max_size: u32) -> RgbImage {
    let (width, height) = image.dimensions();
    if width <= max_size && height <= max_size {
        return image.into_rgb8();
    }

    // The quotient is at most `max_size`, so the casts back to u32 are exact.
    let scaled = |side: u32, longest: u32| {
        ((u64::from(max_size) * u64::from(side) / u64::from(longest)) as u32).max(2)
    };
    let (new_width, new_height) = if width >= height {
        (max_size, scaled(height, width))
    } else {
        (scaled(width, height), max_size)
    };

    let filter = imageops::FilterType::CatmullRom;
    match image {
        DynamicImage::ImageRgb8(pixels) => imageops::resize(&pixels, new_width, new_height, filter),
        other => DynamicImage::ImageRgba8(imageops::resize(&other, new_width, new_height, filter))
            .into_rgb8(),
    }
}

/// Compute the alpha-weighted mean color of an image as an opaque background.
///
/// Each channel is `sum(a * c) / sum(a)`, rounded down. A fully transparent
/// image yields white. Reads the decoded pixels in place; 8-bit RGB and RGBA
/// skip the per-pixel conversion.
pub(crate) fn average_background(image: &DynamicImage) -> Color {
    let mut sums = [0u64; 4];
    let mut add = |[r, g, b, a]: [u8; 4]| {
        let a = u64::from(a);
        sums[0] += u64::from(r) * a;
        sums[1] += u64::from(g) * a;
        sums[2] += u64::from(b) * a;
        sums[3] += a;
    };
    match image {
        DynamicImage::ImageRgb8(pixels) => {
            pixels.pixels().for_each(|pixel| {
                let [r, g, b] = pixel.0;
                add([r, g, b, 255]);
            });
        }
        DynamicImage::ImageRgba8(pixels) => pixels.pixels().for_each(|pixel| add(pixel.0)),
        other => other
            .pixels()
            .for_each(|(_, _, pixel)| add(pixel.to_rgba().0)),
    }
    let [r, g, b, weight] = sums;
    if weight == 0 {
        return Color::new(255, 255, 255, 255);
    }
    // Each quotient is a weighted mean of u8 values, so it fits in u8.
    Color::new(
        (r / weight) as u8,
        (g / weight) as u8,
        (b / weight) as u8,
        255,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn thumbnail_keeps_both_sides_at_least_two_pixels() {
        let banner = DynamicImage::ImageRgb8(RgbImage::from_pixel(2000, 5, Rgb([0, 0, 0])));
        let resized = thumbnail(banner, 256);
        assert_eq!(resized.dimensions(), (256, 2));

        let column = DynamicImage::ImageRgb8(RgbImage::from_pixel(2, 10_000, Rgb([0, 0, 0])));
        let resized = thumbnail(column, 100);
        assert_eq!(resized.dimensions(), (2, 100));
    }

    /// Resampling the RGB channels alone gives the RGB channels of the
    /// opaque RGBA resampling, for 8-bit RGB and for every other format.
    #[test]
    fn thumbnail_matches_the_rgb_channels_of_rgba_resampling() {
        let rgb = RgbImage::from_fn(97, 61, |x, y| {
            let noise = (x * 7919 + y * 104_729) % 251;
            Rgb([(x * 5) as u8, (y * 4) as u8, noise as u8])
        });
        let opaque_rgba = DynamicImage::ImageRgb8(rgb.clone()).into_rgba8();
        let luma = DynamicImage::ImageLuma8(DynamicImage::ImageRgb8(rgb.clone()).into_luma8());
        for (input, max_size) in [
            (DynamicImage::ImageRgb8(rgb.clone()), 32),
            (DynamicImage::ImageRgb8(rgb), 60),
            (DynamicImage::ImageRgba8(opaque_rgba), 32),
            (luma, 45),
        ] {
            let (width, height) = thumbnail(input.clone(), max_size).dimensions();
            let expected =
                imageops::resize(&input, width, height, imageops::FilterType::CatmullRom);
            let expected = DynamicImage::ImageRgba8(expected).into_rgb8();
            assert_eq!(thumbnail(input, max_size), expected, "max_size {max_size}");
        }
    }

    #[test]
    fn average_background_reads_rgb_and_rgba_without_conversion() {
        let rgb = DynamicImage::ImageRgb8(RgbImage::from_fn(2, 1, |x, _| {
            if x == 0 {
                Rgb([10, 20, 30])
            } else {
                Rgb([30, 40, 50])
            }
        }));
        assert_eq!(average_background(&rgb), Color::new(20, 30, 40, 255));

        let luma = DynamicImage::ImageLumaA8(image::GrayAlphaImage::from_fn(2, 1, |x, _| {
            if x == 0 {
                image::LumaA([100, 255])
            } else {
                image::LumaA([0, 0])
            }
        }));
        assert_eq!(average_background(&luma), Color::new(100, 100, 100, 255));
    }
}

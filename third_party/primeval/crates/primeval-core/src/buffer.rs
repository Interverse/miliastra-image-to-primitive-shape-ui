/// The smallest width and height of a [`Buffer`] built through the public
/// API: the engine's search needs a canvas of at least 2 x 2 pixels, so a
/// [`Model`](crate::Model) cannot be created for anything smaller.
const MIN_PUBLIC_SIDE: u32 = 2;

/// Bytes per pixel: the engine works in opaque RGB, with no alpha channel.
pub(crate) const BYTES_PER_PIXEL: usize = 3;

/// A contiguous, opaque RGB pixel buffer with no row padding.
///
/// Pixels are stored in row-major order as `[R, G, B]` triples.
/// The total byte length is always exactly `width * height * 3`; every
/// constructor checks this with a hard assertion or rejects the input, and the
/// unsafe NEON scoring kernels rely on it. Buffers built through the public API
/// ([`Buffer::from_rgb`]) are also at least 2 x 2 pixels.
#[derive(Clone, Debug)]
pub struct Buffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Buffer {
    /// Creates a zero-filled buffer of the given dimensions.
    ///
    /// # Panics
    ///
    /// Panics if `width * height * 3` overflows `usize`.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn new(width: u32, height: u32) -> Self {
        let len = pixel_byte_len(width, height);
        Self::from_parts(width, height, vec![0u8; len])
    }

    /// Creates a buffer filled with the RGB channels of a single color; its
    /// alpha is ignored.
    ///
    /// # Panics
    ///
    /// Panics if `width * height * 3` overflows `usize`.
    #[must_use]
    pub(crate) fn new_from_color(width: u32, height: u32, color: crate::Color) -> Self {
        let len = pixel_byte_len(width, height);
        let pixels = [color.r, color.g, color.b].repeat(len / BYTES_PER_PIXEL);
        Self::from_parts(width, height, pixels)
    }

    /// Assembles a buffer, asserting the length invariant
    /// `pixels.len() == width * height * 3` that the NEON kernels rely on.
    fn from_parts(width: u32, height: u32, pixels: Vec<u8>) -> Self {
        assert_eq!(
            pixels.len(),
            pixel_byte_len(width, height),
            "buffer pixel length must be width * height * 3"
        );
        Self {
            width,
            height,
            pixels,
        }
    }

    /// Returns the buffer width in pixels.
    #[must_use]
    #[inline]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Returns the buffer height in pixels.
    #[must_use]
    #[inline]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Returns the raw pixel bytes: row-major `[R, G, B]` triples, with
    /// no row padding.
    #[must_use]
    #[inline]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Returns a mutable reference to the raw pixel bytes.
    #[inline]
    pub(crate) fn pixels_mut(&mut self) -> &mut [u8] {
        &mut self.pixels
    }

    /// Returns the byte offset of pixel `(x, y)` in the pixel slice.
    ///
    /// No bounds checking is performed — the caller is responsible for
    /// ensuring `x` and `y` are within the buffer dimensions.
    #[must_use]
    #[inline]
    pub(crate) fn pix_offset(&self, x: i32, y: i32) -> usize {
        (y as usize * self.width as usize + x as usize) * BYTES_PER_PIXEL
    }

    /// Creates a buffer from raw row-major RGB bytes, three per pixel.
    ///
    /// The engine works in opaque RGB: composite any transparent image onto
    /// an opaque background before building its buffer.
    ///
    /// Returns `None` unless both sides are at least 2 pixels (the smallest
    /// canvas the engine supports) and `pixels.len()` is exactly
    /// `width * height * 3`.
    #[must_use]
    pub fn from_rgb(width: u32, height: u32, pixels: Vec<u8>) -> Option<Self> {
        if width < MIN_PUBLIC_SIDE || height < MIN_PUBLIC_SIDE {
            return None;
        }
        let len = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(BYTES_PER_PIXEL)?;
        (pixels.len() == len).then(|| Self::from_parts(width, height, pixels))
    }
}

/// Computes the required byte length for a buffer, panicking on overflow.
fn pixel_byte_len(width: u32, height: u32) -> usize {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(BYTES_PER_PIXEL))
        .expect("buffer pixel byte length must not overflow usize")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Color;

    #[test]
    fn new_creates_correct_size() {
        let buf = Buffer::new(10, 20);
        assert_eq!(buf.width(), 10);
        assert_eq!(buf.height(), 20);
        assert_eq!(buf.pixels().len(), 10 * 20 * 3);
    }

    #[test]
    fn new_is_zeroed() {
        let buf = Buffer::new(3, 3);
        assert!(buf.pixels().iter().all(|&b| b == 0));
    }

    #[test]
    fn new_from_color_fills_the_rgb_channels() {
        let c = Color::new(10, 20, 30, 128);
        let buf = Buffer::new_from_color(2, 2, c);
        assert_eq!(buf.pixels().len(), 2 * 2 * 3);
        for chunk in buf.pixels().as_chunks::<3>().0 {
            assert_eq!(*chunk, [10, 20, 30]);
        }
    }

    #[test]
    fn pix_offset_computes_correctly() {
        let buf = Buffer::new(10, 10);
        // Pixel (0, 0) -> offset 0
        assert_eq!(buf.pix_offset(0, 0), 0);
        // Pixel (1, 0) -> offset 3
        assert_eq!(buf.pix_offset(1, 0), 3);
        // Pixel (0, 1) -> offset 10*3 = 30
        assert_eq!(buf.pix_offset(0, 1), 30);
        // Pixel (3, 2) -> (2*10 + 3)*3 = 69
        assert_eq!(buf.pix_offset(3, 2), 69);
    }

    #[test]
    fn from_rgb_keeps_dimensions_and_pixels() {
        let pixels: Vec<u8> = (0..18).collect();
        let buf = Buffer::from_rgb(3, 2, pixels.clone()).expect("valid length");
        assert_eq!((buf.width(), buf.height()), (3, 2));
        assert_eq!(buf.pixels(), pixels.as_slice());
    }

    #[test]
    fn from_rgb_rejects_wrong_length() {
        assert!(Buffer::from_rgb(3, 2, vec![0; 17]).is_none());
        assert!(Buffer::from_rgb(3, 2, vec![0; 19]).is_none());
        // The RGBA length of the same image is rejected too.
        assert!(Buffer::from_rgb(3, 2, vec![0; 24]).is_none());
        assert!(Buffer::from_rgb(u32::MAX, u32::MAX, Vec::new()).is_none());
    }

    #[test]
    fn from_rgb_rejects_sides_below_two() {
        assert!(Buffer::from_rgb(0, 0, Vec::new()).is_none());
        assert!(Buffer::from_rgb(0, 5, Vec::new()).is_none());
        assert!(Buffer::from_rgb(1, 1, vec![0; 3]).is_none());
        assert!(Buffer::from_rgb(1, 5, vec![0; 15]).is_none());
        assert!(Buffer::from_rgb(5, 1, vec![0; 15]).is_none());
        assert!(Buffer::from_rgb(2, 2, vec![0; 12]).is_some());
    }

    #[test]
    fn zero_dimension_buffer() {
        let buf = Buffer::new(0, 0);
        assert_eq!(buf.pixels().len(), 0);
    }
}

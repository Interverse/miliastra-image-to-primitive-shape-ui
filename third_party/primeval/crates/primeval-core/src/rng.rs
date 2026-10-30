//! Deterministic RNG support for reproducible shape generation.
//!
//! Wraps `ChaCha8Rng` to provide a seedable, platform-independent
//! random number generator.

use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

/// Creates a deterministic RNG seeded from the given value, for tests and
/// benches that drive a [`crate::worker::WorkerCtx`] directly.
///
/// Two calls with the same seed will always produce the same sequence,
/// regardless of platform.
#[cfg(any(test, feature = "bench"))]
#[must_use]
pub(crate) fn create_rng(seed: u64) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed)
}

/// Creates the RNG for search round `round` of step `step` under `seed`.
///
/// The 256-bit ChaCha key is `seed` followed by `step` (both little-endian,
/// the remaining 16 bytes zero) and the ChaCha stream is `round`. Distinct
/// `(seed, step, round)` triples therefore select distinct key and stream
/// pairs, so no two rounds share or overlap a stream, and the derivation
/// does no arithmetic that could overflow.
#[must_use]
pub(crate) fn round_rng(seed: u64, step: u64, round: u64) -> ChaCha8Rng {
    let mut key = [0_u8; 32];
    key[..8].copy_from_slice(&seed.to_le_bytes());
    key[8..16].copy_from_slice(&step.to_le_bytes());
    let mut rng = ChaCha8Rng::from_seed(key);
    rng.set_stream(round);
    rng
}

/// Tag in bytes 16..24 of every [`refine_rng`] key, which are zero in
/// every [`round_rng`] key, so no refit climb shares a key with a step.
const REFINE_TAG: [u8; 8] = *b"refine\0\0";

/// Creates the RNG for climb `round` at layer `layer` of refit pass `pass`
/// under `seed`.
///
/// The ChaCha key is `seed` (bytes 0..8), `pass` (8..16), [`REFINE_TAG`]
/// (16..24) and `layer` (24..32), all little-endian, and the stream is
/// `round`. The tag is non-zero where every [`round_rng`] key is zero, so
/// the two derivations never select the same key, and distinct
/// `(seed, pass, layer, round)` select distinct key and stream pairs.
#[must_use]
pub(crate) fn refine_rng(seed: u64, pass: u64, layer: u64, round: u64) -> ChaCha8Rng {
    let mut key = [0_u8; 32];
    key[..8].copy_from_slice(&seed.to_le_bytes());
    key[8..16].copy_from_slice(&pass.to_le_bytes());
    key[16..24].copy_from_slice(&REFINE_TAG);
    key[24..32].copy_from_slice(&layer.to_le_bytes());
    let mut rng = ChaCha8Rng::from_seed(key);
    rng.set_stream(round);
    rng
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngExt;

    #[test]
    fn deterministic_across_calls() {
        let mut rng1 = create_rng(42);
        let mut rng2 = create_rng(42);
        let seq1: Vec<u64> = (0..100).map(|_| rng1.random()).collect();
        let seq2: Vec<u64> = (0..100).map(|_| rng2.random()).collect();
        assert_eq!(seq1, seq2);
    }

    #[test]
    fn different_seeds_differ() {
        let mut rng1 = create_rng(1);
        let mut rng2 = create_rng(2);
        let v1: u64 = rng1.random();
        let v2: u64 = rng2.random();
        assert_ne!(v1, v2);
    }

    fn first_words(mut rng: ChaCha8Rng) -> Vec<u64> {
        (0..8).map(|_| rng.random()).collect()
    }

    #[test]
    fn round_rngs_are_reproducible_and_do_not_overlap() {
        assert_eq!(
            first_words(round_rng(42, 3, 5)),
            first_words(round_rng(42, 3, 5))
        );

        let triples = [
            (42, 0, 0),
            (42, 0, 1),
            (43, 0, 0),
            (42, 1, 0),
            (43, 1, 0),
            (0, 0, 0),
            (u64::MAX, 0, 0),
            (u64::MAX, u64::MAX, 15),
        ];
        let streams: Vec<Vec<u64>> = triples
            .iter()
            .map(|&(seed, step, round)| first_words(round_rng(seed, step, round)))
            .collect();
        for (i, left) in streams.iter().enumerate() {
            for (j, right) in streams.iter().enumerate().skip(i + 1) {
                assert_ne!(left, right, "{:?} and {:?}", triples[i], triples[j]);
            }
        }
    }

    #[test]
    fn refine_rngs_are_reproducible_and_do_not_overlap() {
        assert_eq!(
            first_words(refine_rng(42, 1, 3, 5)),
            first_words(refine_rng(42, 1, 3, 5))
        );

        let quads = [
            (42, 0, 0, 0),
            (42, 0, 0, 1),
            (42, 0, 1, 0),
            (42, 1, 0, 0),
            (43, 0, 0, 0),
            (0, 0, 0, 0),
            (u64::MAX, u64::MAX, u64::MAX, 7),
        ];
        let mut streams: Vec<Vec<u64>> = quads
            .iter()
            .map(|&(seed, pass, layer, round)| first_words(refine_rng(seed, pass, layer, round)))
            .collect();
        // Every step key has zero bytes 16..32, where every refine key holds
        // the non-zero tag: the same seed, index and stream never collide.
        let triples = [
            (42, 0, 0),
            (42, 0, 1),
            (42, 1, 0),
            (43, 0, 0),
            (0, 0, 0),
            (u64::MAX, u64::MAX, 7),
        ];
        streams.extend(
            triples
                .iter()
                .map(|&(seed, step, round)| first_words(round_rng(seed, step, round))),
        );
        for (i, left) in streams.iter().enumerate() {
            for (j, right) in streams.iter().enumerate().skip(i + 1) {
                assert_ne!(left, right, "streams {i} and {j}");
            }
        }
    }

    #[test]
    fn refine_keys_never_match_round_keys() {
        assert_ne!(REFINE_TAG, [0; 8]);
        let refine = refine_rng(42, 3, 0, 5);
        let round = round_rng(42, 3, 5);
        assert_ne!(refine.get_seed(), round.get_seed());
        assert_eq!(refine.get_seed()[16..24], REFINE_TAG);
        assert_eq!(round.get_seed()[16..32], [0; 16]);
        assert_eq!(refine.get_stream(), round.get_stream());
    }
}

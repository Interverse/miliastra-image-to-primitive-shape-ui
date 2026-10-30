use crate::alpha::Alpha;
use crate::shapes::{Shape, Step};
use crate::worker::{SearchRound, WorkerCtx};
use rand::{Rng, RngExt};

/// Alpha a search starts from when the alpha is automatic.
const AUTO_ALPHA_START: u8 = 128;

/// How far a coarse move changes the alpha, either way, when the alpha is
/// automatic.
const ALPHA_STEP: i32 = 10;

/// How far a scaled move can change the alpha at the least.
const MIN_ALPHA_STEP: i32 = 3;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct State {
    pub(crate) shape: Shape,
    /// Whether moves mutate `alpha` too.
    auto_alpha: bool,
    /// `1..=255` during search; a committed shape covering no pixel can
    /// have alpha 0.
    pub(crate) alpha: u8,
    pub(crate) cached_energy: Option<u64>,
}

impl State {
    #[must_use]
    pub(crate) fn new(shape: Shape, alpha: Alpha) -> Self {
        let (auto_alpha, alpha) = match alpha {
            Alpha::Auto => (true, AUTO_ALPHA_START),
            Alpha::Fixed(alpha) => (false, alpha.get()),
        };
        Self {
            shape,
            auto_alpha,
            alpha,
            cached_energy: None,
        }
    }

    /// A state at a committed shape painted at `alpha`, whose moves change
    /// the alpha too when `mode` is [`Alpha::Auto`]; with a fixed `mode` the
    /// alpha stays `alpha`. `alpha` is `0` for a committed shape that covers
    /// no pixel, which fits no colour: such a state is invisible until a
    /// move under [`Alpha::Auto`] raises its alpha to at least `1`.
    #[must_use]
    pub(crate) fn committed(shape: Shape, mode: Alpha, alpha: u8) -> Self {
        Self {
            shape,
            auto_alpha: matches!(mode, Alpha::Auto),
            alpha,
            cached_energy: None,
        }
    }

    pub(crate) fn energy<R: Rng>(
        &mut self,
        worker: &mut WorkerCtx<R>,
        round: &SearchRound<'_>,
    ) -> u64 {
        if let Some(energy) = self.cached_energy {
            return energy;
        }

        let energy = worker.energy(round, &self.shape, i32::from(self.alpha));
        self.cached_energy = Some(energy);
        energy
    }

    /// The energy if it is below `bound`, `None` otherwise, which the
    /// evaluation can tell early. Only an energy below the bound is cached:
    /// the search drops or undoes every other state.
    pub(crate) fn energy_below<R: Rng>(
        &mut self,
        worker: &mut WorkerCtx<R>,
        round: &SearchRound<'_>,
        bound: u64,
    ) -> Option<u64> {
        if let Some(energy) = self.cached_energy {
            return (energy < bound).then_some(energy);
        }

        let energy = worker.energy_below(round, &self.shape, i32::from(self.alpha), bound);
        if energy.is_some() {
            self.cached_energy = energy;
        }
        energy
    }

    /// Makes a greedy search move, [`Step::Coarse`], and returns the state
    /// before it.
    pub(crate) fn do_move<R: Rng>(&mut self, worker: &mut WorkerCtx<R>) -> Self {
        self.do_move_by(worker, Step::Coarse)
    }

    /// Makes a move of size `step` and returns the state before it: the
    /// shape moves by [`Shape::mutate`], and under [`Alpha::Auto`] the alpha
    /// moves too, uniformly and possibly by zero, within `1..=255`. A
    /// [`Step::Coarse`] move, the greedy search's, changes the alpha by up
    /// to [`ALPHA_STEP`] either way; a [`Step::Scaled`] move, a refit
    /// climb's, by up to [`ALPHA_STEP`] times the scale, rounded, but at
    /// least [`MIN_ALPHA_STEP`]: by up to 3 at the refit's smallest scale.
    pub(crate) fn do_move_by<R: Rng>(&mut self, worker: &mut WorkerCtx<R>, step: Step) -> Self {
        let previous = self.clone();
        self.shape.mutate(worker, step);
        if self.auto_alpha {
            let delta = match step {
                Step::Coarse => worker.rng.random_range(0..2 * ALPHA_STEP + 1) - ALPHA_STEP,
                Step::Scaled(scale) => {
                    let reach = ((f64::from(ALPHA_STEP) * scale).round() as i32)
                        .clamp(MIN_ALPHA_STEP, ALPHA_STEP);
                    worker.rng.random_range(-reach..=reach)
                }
            };
            self.alpha = (i32::from(self.alpha) + delta).clamp(1, 255) as u8;
        }
        self.cached_energy = None;
        previous
    }

    pub(crate) fn undo_move(&mut self, previous: Self) {
        *self = previous;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Circle, Shape};
    use crate::test_util::{fixed_alpha, make_test_round};

    fn round(w: u32, h: u32) -> (WorkerCtx<rand_chacha::ChaCha8Rng>, SearchRound<'static>) {
        make_test_round(w, h, 123)
    }

    #[test]
    fn new_with_auto_alpha_starts_at_128() {
        let state = State::new(Shape::Circle(Circle { x: 5, y: 5, r: 3 }), Alpha::Auto);

        assert!(state.auto_alpha);
        assert_eq!(state.alpha, 128);
        assert_eq!(state.cached_energy, None);
    }

    #[test]
    fn new_with_fixed_alpha_keeps_it() {
        let state = State::new(Shape::Circle(Circle { x: 5, y: 5, r: 3 }), fixed_alpha(200));

        assert!(!state.auto_alpha);
        assert_eq!(state.alpha, 200);
    }

    #[test]
    fn energy_is_cached_after_first_evaluation() {
        let (mut worker, round) = round(16, 16);
        let mut state = State::new(Shape::Circle(Circle { x: 5, y: 5, r: 3 }), fixed_alpha(128));

        let first = state.energy(&mut worker, &round);
        let second = state.energy(&mut worker, &round);

        assert_eq!(first, second);
        assert_eq!(worker.evaluations, 1);
    }

    /// Under [`Alpha::Auto`] a scaled move changes the alpha by at most its
    /// reach, 3 at the refit's smallest scale and [`ALPHA_STEP`] at the
    /// coarse one, and keeps it in `1..=255`, also from either end.
    #[test]
    fn scaled_moves_keep_the_alpha_in_range() {
        let (mut worker, _round) = round(32, 32);
        for (scale, reach) in [(crate::refine::MIN_SCALE, 3), (1.0, ALPHA_STEP)] {
            for start in [1, 2, 128, 254, 255] {
                let shape = Shape::Circle(Circle { x: 16, y: 16, r: 4 });
                let mut state = State::committed(shape, Alpha::Auto, start);
                let mut largest = 0;
                for _ in 0..300 {
                    let before = i32::from(state.alpha);
                    let _previous = state.do_move_by(&mut worker, Step::Scaled(scale));
                    let delta = (i32::from(state.alpha) - before).abs();
                    assert!(
                        state.alpha >= 1 && delta <= reach,
                        "{scale} from {before}: {state:?}"
                    );
                    largest = largest.max(delta);
                }
                assert_eq!(largest, reach, "scale {scale} from {start}");
            }
        }
    }

    #[test]
    fn scaled_moves_keep_a_fixed_alpha() {
        let (mut worker, _round) = round(32, 32);
        let shape = Shape::Circle(Circle { x: 16, y: 16, r: 4 });
        let mut state = State::committed(shape, fixed_alpha(77), 77);
        for _ in 0..50 {
            let _previous = state.do_move_by(&mut worker, Step::Scaled(crate::refine::MIN_SCALE));
            assert_eq!(state.alpha, 77);
        }
    }

    #[test]
    fn do_move_invalidates_cached_energy() {
        let (mut worker, round) = round(16, 16);
        let mut state = State::new(Shape::Circle(Circle { x: 5, y: 5, r: 3 }), fixed_alpha(128));
        let _ = state.energy(&mut worker, &round);

        let _previous = state.do_move(&mut worker);

        assert_eq!(state.cached_energy, None);
    }
}

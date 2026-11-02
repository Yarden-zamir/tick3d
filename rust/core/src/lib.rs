//! The game and session rules of tick3d: a second copy of the TypeScript rules in `src/`, for the
//! Rust server. The shared cases in `src/session/rule-cases.json` check that both copies agree.
pub mod clock;
pub mod game;
pub mod names;
pub mod playoff;
pub mod session;

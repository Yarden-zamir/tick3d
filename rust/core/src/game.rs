// Rules for 3D tic-tac-toe on a 4x4x4 cube. A copy of src/game.ts.
use std::sync::LazyLock;

use serde::{Deserialize, Serialize, Serializer};

use crate::clock::TimeControl;

pub const SIZE: u8 = 4;
pub const CELL_COUNT: usize = 64;

/// A point in time: whole milliseconds since 1970-01-01 UTC.
pub type EpochMs = i64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Player {
    X,
    O,
}

impl std::fmt::Display for Player {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Player::X => "X",
            Player::O => "O",
        })
    }
}

impl Player {
    pub fn other(self) -> Player {
        match self {
            Player::X => Player::O,
            Player::O => Player::X,
        }
    }
}

/// A value for each player.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerPlayer<T> {
    #[serde(rename = "X")]
    pub x: T,
    #[serde(rename = "O")]
    pub o: T,
}

impl<T> PerPlayer<T> {
    pub fn get(&self, player: Player) -> &T {
        match player {
            Player::X => &self.x,
            Player::O => &self.o,
        }
    }

    pub fn set(&mut self, player: Player, value: T) {
        match player {
            Player::X => self.x = value,
            Player::O => self.o = value,
        }
    }

    /// The same values with X and O traded.
    pub fn swapped(self) -> PerPlayer<T> {
        PerPlayer { x: self.o, o: self.x }
    }
}

/// A cell index 0..63: layer * 16 + row * 4 + column. Deserialize refuses any other number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Cell(u8);

impl Cell {
    pub fn index(self) -> usize {
        usize::from(self.0)
    }

    fn at(layer: u8, row: u8, column: u8) -> Cell {
        assert!(layer < SIZE && row < SIZE && column < SIZE, "coordinate out of range: {layer},{row},{column}");
        Cell(layer * SIZE * SIZE + row * SIZE + column)
    }

    /// Layer, row and column.
    pub fn coords(self) -> [u8; 3] {
        [self.0 / (SIZE * SIZE), self.0 / SIZE % SIZE, self.0 % SIZE]
    }
}

impl TryFrom<u8> for Cell {
    type Error = String;
    fn try_from(value: u8) -> Result<Cell, String> {
        if usize::from(value) < CELL_COUNT { Ok(Cell(value)) } else { Err(format!("cell must be an integer in 0..63, got {value}")) }
    }
}

impl From<Cell> for u8 {
    fn from(cell: Cell) -> u8 {
        cell.0
    }
}

pub type Line = [Cell; 4];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Axis,
    Plane,
    Space,
}

/// How a line runs: along one axis, diagonally inside a plane, or diagonally through the cube.
pub fn line_kind(line: &Line) -> LineKind {
    let [a, b] = [line[0].coords(), line[1].coords()];
    match (0..3).filter(|&axis| a[axis] != b[axis]).count() {
        1 => LineKind::Axis,
        2 => LineKind::Plane,
        _ => LineKind::Space,
    }
}

/// Every straight line of 4 cells, in the order of LINES in src/game.ts. The order decides which line
/// a win shows when one move completes two lines.
pub static LINES: LazyLock<Vec<Line>> = LazyLock::new(|| {
    let steps = [-1i8, 0, 1];
    let starts = |step: i8| -> Vec<i8> {
        match step {
            0 => vec![0, 1, 2, 3],
            1 => vec![0],
            _ => vec![3],
        }
    };
    let mut lines = Vec::new();
    for dl in steps {
        for dr in steps {
            for dc in steps {
                // Keep one of each pair of opposite directions: the first non-zero step is positive.
                let first = [dl, dr, dc].into_iter().find(|&step| step != 0).unwrap_or(0);
                if first != 1 {
                    continue;
                }
                for layer in starts(dl) {
                    for row in starts(dr) {
                        for column in starts(dc) {
                            let at = |i: i8| {
                                let coord = |start: i8, step: i8| u8::try_from(start + step * i).expect("a line leaves the cube");
                                Cell::at(coord(layer, dl), coord(row, dr), coord(column, dc))
                            };
                            lines.push([at(0), at(1), at(2), at(3)]);
                        }
                    }
                }
            }
        }
    }
    lines
});

static LINES_THROUGH: LazyLock<Vec<Vec<Line>>> = LazyLock::new(|| {
    (0..CELL_COUNT).map(|cell| LINES.iter().filter(|line| line.iter().any(|c| c.index() == cell)).copied().collect()).collect()
});

pub type Board = [Option<Player>; CELL_COUNT];

pub fn winning_line(board: &Board, cell: Cell, player: Player) -> Option<Line> {
    LINES_THROUGH[cell.index()].iter().find(|line| line.iter().all(|c| board[c.index()] == Some(player))).copied()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Status {
    Playing,
    Won {
        winner: Player,
        line: Line,
    },
    /// The other player ran out of time.
    Timeout {
        winner: Player,
    },
    Draw,
    /// Nobody moved for a long time, so the server ended the game. It has no result.
    Abandoned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Game {
    #[serde(serialize_with = "serialize_board")]
    pub board: Board,
    pub turn: Player,
    pub first: Player,
    pub status: Status,
    pub moves: Vec<Cell>,
    /// When each move happened. The clock reads these.
    pub times: Vec<EpochMs>,
    /// The time limit this game is played with. It never changes during the game.
    pub clock: TimeControl,
}

// serde derives arrays up to 32 items only.
fn serialize_board<S: Serializer>(board: &Board, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(board)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MoveError {
    Occupied,
    GameOver,
}

impl std::fmt::Display for MoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            MoveError::Occupied => "occupied",
            MoveError::GameOver => "game-over",
        })
    }
}

impl Game {
    pub fn new(first: Player, clock: TimeControl) -> Game {
        Game { board: [None; CELL_COUNT], turn: first, first, status: Status::Playing, moves: vec![], times: vec![], clock }
    }

    pub fn is_playing(&self) -> bool {
        self.status == Status::Playing
    }

    pub fn play(&self, cell: Cell, at: EpochMs) -> Result<Game, MoveError> {
        if !self.is_playing() {
            return Err(MoveError::GameOver);
        }
        if self.board[cell.index()].is_some() {
            return Err(MoveError::Occupied);
        }
        let mut next = self.clone();
        next.board[cell.index()] = Some(self.turn);
        next.moves.push(cell);
        next.times.push(at);
        next.status = match winning_line(&next.board, cell, self.turn) {
            Some(line) => Status::Won { winner: self.turn, line },
            None if next.moves.len() == CELL_COUNT => Status::Draw,
            None => Status::Playing,
        };
        next.turn = self.turn.other();
        Ok(next)
    }

    /// Ends a live game: the player to move ran out of time.
    pub fn time_out(&self) -> Game {
        assert!(self.is_playing(), "only a live game can time out");
        Game { status: Status::Timeout { winner: self.turn.other() }, ..self.clone() }
    }

    /// Ends a live game with no winner.
    pub fn abandon(&self) -> Game {
        assert!(self.is_playing(), "only a live game can be abandoned");
        Game { status: Status::Abandoned, ..self.clone() }
    }

    /// Replays all moves except the last `count`, so the result is always a reachable position.
    pub fn undo(&self, count: usize) -> Game {
        let keep = self.moves.len().saturating_sub(count);
        replay(&self.moves[..keep], self.first, Some(&self.times[..keep]), self.clock).expect("a played game replays")
    }
}

/// Replays a move list from an empty board. Without `times`, every move gets time 0.
/// The error text matches `replay` in src/game.ts, because uploads show it.
pub fn replay(moves: &[Cell], first: Player, times: Option<&[EpochMs]>, clock: TimeControl) -> Result<Game, String> {
    if let Some(times) = times {
        assert_eq!(times.len(), moves.len(), "times and moves differ in length");
    }
    let mut game = Game::new(first, clock);
    for (i, &cell) in moves.iter().enumerate() {
        let at = times.map_or(0, |times| times[i]);
        game = game.play(cell, at).map_err(|error| format!("move history is not valid: {error} at cell {}", cell.0))?;
    }
    Ok(game)
}

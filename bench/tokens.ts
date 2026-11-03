// The player tokens of the benchmarks: 16 hex characters, a dash and a name, as the API takes them.
export const tokenOf = (player: number): string => `${player.toString(16).padStart(16, '0')}-bench${player}`;

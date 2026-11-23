// The snapshot's shape and the gate's board checks, run before anything is written.

export interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: { slug: string }[]; watchlist: string[] }
export interface BoardRow { rank: number; slug: string; name: string; implied_value_usd: number; farm_steps: string[] }

export function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot;
  if (!s || !Array.isArray(s.protocols) || !Array.isArray(s.watchlist) || typeof s.as_of !== 'string') throw new Error('snapshot: missing protocols, watchlist or as_of');
  return s;
}

/** Null when the board passes the gate's board_file, sorted_by_value, coverage and farm_steps rows. */
export function boardIssue(board: BoardRow[], s: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `${board.length} rows (100 to 4,000)`;
  const known = new Set(s.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const [i, r] of board.entries()) {
    if (!known.has(r.slug) || seen.has(r.slug) || /\s/.test(r.slug)) return `row ${i}: slug ${r.slug}`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i}: rank ${r.rank}`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) return `row ${i}: implied value`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i}: value rises`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12 || r.farm_steps.some((t) => t.trim().length < 20 || t.trim().length > 600)) return `row ${i}: farm steps`;
  }
  const missing = s.watchlist.filter((w) => !seen.has(w));
  if (missing.length) return `watchlist not covered: ${missing.slice(0, 3).join(', ')}`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  return null;
}

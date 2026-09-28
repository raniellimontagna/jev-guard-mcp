import { Chess, type Move } from "chess.js";

const MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const PIECES: Record<string, string> = {
  wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙",
  bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]!);
}

function token(move: Pick<Move, "from" | "to" | "promotion">): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function makeMove(game: Chess, encoded: string): Move {
  if (!MOVE.test(encoded)) throw new Error("Invalid coordinate move");
  return game.move({
    from: encoded.slice(0, 2),
    to: encoded.slice(2, 4),
    ...(encoded.length === 5 ? { promotion: encoded[4] } : {}),
  });
}

function botMove(game: Chess, index: number): void {
  const preferred = index === 0 ? "f2f3" : index === 1 ? "g2g4" : "";
  const legal = game.moves({ verbose: true });
  const move = legal.find((candidate) => token(candidate) === preferred)
    ?? legal.slice().sort((left, right) => token(left).localeCompare(token(right)))[0];
  if (!move) throw new Error("Bot has no legal move");
  game.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
}

function gameFromPath(pathname: string): { game: Chess; blackMoves: string[] } {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "game" || segments.length > 42) throw new Error("Invalid game path");
  const blackMoves = segments.slice(2);
  if (blackMoves.some((move) => !MOVE.test(move))) throw new Error("Invalid game path");
  const game = new Chess();
  botMove(game, 0);
  for (const [index, move] of blackMoves.entries()) {
    if (game.isGameOver() || game.turn() !== "b") throw new Error("Game is already over");
    makeMove(game, move);
    if (!game.isGameOver()) botMove(game, index + 1);
  }
  return { game, blackMoves };
}

function renderBoard(game: Chess): string {
  const rows = game.board().map((row, rowIndex) => {
    const cells = row.map((piece, fileIndex) => {
      const square = `${"abcdefgh"[fileIndex]}${8 - rowIndex}`;
      const name = piece ? `${piece.color === "w" ? "branca" : "preta"} ${piece.type}` : "vazia";
      const symbol = piece ? PIECES[`${piece.color}${piece.type}`] : "";
      return `<td aria-label="${square}: ${name}" class="${(rowIndex + fileIndex) % 2 ? "dark" : "light"}">${symbol}</td>`;
    }).join("");
    return `<tr><th scope="row">${8 - rowIndex}</th>${cells}</tr>`;
  }).join("");
  return `<table aria-label="Tabuleiro de xadrez"><tbody>${rows}</tbody><tfoot><tr><th></th>${[..."abcdefgh"].map((file) => `<th scope="col">${file}</th>`).join("")}</tr></tfoot></table>`;
}

function renderHistory(game: Chess): string {
  return game.history({ verbose: true }).map((move) =>
    `<li>${move.color === "w" ? "Bot" : "Jev"}: ${move.from} para ${move.to} (${escapeHtml(move.san)})</li>`).join("");
}

function renderMoves(game: Chess, blackMoves: string[]): string {
  const prefix = `/game${blackMoves.map((move) => `/${move}`).join("")}`;
  if (game.isGameOver()) return `<a class="review-result" href="${prefix}">Ver resultado da partida</a>`;
  return game.moves({ verbose: true }).map((move) =>
    `<a class="legal-move" href="${prefix}/${token(move)}">${move.from} para ${move.to} (${escapeHtml(move.san)})</a>`).join("");
}

export function renderChessPage(pathname: string): { status: number; html: string } {
  let state: ReturnType<typeof gameFromPath>;
  try { state = gameFromPath(pathname); }
  catch { return { status: 404, html: "<!doctype html><title>Partida inexistente</title><h1>Partida inexistente</h1>" }; }

  const { game, blackMoves } = state;
  const status = game.isCheckmate()
    ? game.turn() === "w" ? "Jev venceu por xeque-mate" : "Bot venceu por xeque-mate"
    : game.isDraw() ? "Partida empatada" : "Vez de Jev (pretas)";
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev contra Bot — xadrez local</title>
<style>
  body{margin:0;background:#102127;color:#eaf7f1;font:16px system-ui,-apple-system,sans-serif}
  main{max-width:950px;margin:0 auto;padding:18px 22px}
  h1{margin:0 0 4px;font-size:26px}p{margin:4px 0 12px} .layout{display:grid;grid-template-columns:350px 1fr;gap:22px}
  table{border-collapse:collapse;background:#102127}td{width:36px;height:36px;text-align:center;font-size:28px;line-height:1;color:#13252b}
  td.light{background:#e7ecce}td.dark{background:#76a797}th{font-size:12px;font-weight:500;color:#aecac0}
  .panel{background:#19343a;border-radius:12px;padding:14px}.moves{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
  a.legal-move{display:block;background:#285354;color:#fff;border-radius:6px;padding:6px;text-decoration:none;font-size:13px}
  a.legal-move:hover,a.legal-move:focus{background:#367b68;outline:2px solid #b9e8a0}
  ol{font-size:14px;padding-left:20px;margin:0}.status{font-weight:700;color:#b9e8a0}
  @media(max-width:680px){.layout{grid-template-columns:1fr}.moves{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main>
<h1>Jev contra Bot</h1><p>Partida local e sem rating. Codex planeja os lances das pretas; Jev escolhe o link correspondente.</p>
<p class="status">${status}</p><div class="layout"><div>${renderBoard(game)}</div><div class="panel">
<h2>Lances</h2><ol>${renderHistory(game)}</ol>
<h2>Lances legais das pretas</h2><div class="moves">${renderMoves(game, blackMoves)}</div>
</div></div></main></body></html>`;
  return { status: 200, html };
}

// Board geometry in lattice units (1 unit = horizontal peg spacing). Pure.
// Row r shows r + 3 pegs (j = 0..r+2). The ball on lattice offset i hits peg j = i + 1;
// the outer pegs frame the board. The last row's pegs are the bucket dividers.

export function boardGeometry(rows, L) {
  const dy = L.rowSpacing;
  const C = L.pegRadius + L.ballRadius; // ball-centre distance when resting on a peg
  const bucketTop = (rows - 1) * dy + L.bucketTopOffset;
  const bucketBottom = bucketTop + L.bucketHeight;
  const dropperY = -L.dropperHeight;
  const halfW = (rows + 1) / 2;
  const rowStart = new Int32Array(rows + 1);
  for (let r = 0; r <= rows; r++) rowStart[r] = (r * (r + 5)) / 2;
  return {
    rows, dy, C, bucketTop, bucketBottom, dropperY,
    pegRadius: L.pegRadius, ballRadius: L.ballRadius,
    landY: bucketTop + L.bucketHeight * L.bucketLandDepth,
    pegCount: rowStart[rows],
    rowStart,
    pegX: (r, j) => j - (r + 2) / 2,
    pegY: (r) => r * dy,
    pegIndex: (r, j) => rowStart[r] + j,
    bucketX: (k) => k - rows / 2,
    bounds: {
      minX: -halfW - L.sideMargin,
      maxX: halfW + L.sideMargin,
      minY: dropperY - L.ballRadius - L.topMargin,
      maxY: bucketBottom + L.bottomMargin,
    },
  };
}

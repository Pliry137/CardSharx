// Mirrors the row/column -> card_number formula in api/lib/standardChecklistGrid.ts.
// Kept as a small standalone copy here because the frontend bundle (src/) doesn't
// include api/lib/* — this is only used to lay out the post-scan review grid so it
// visually matches the physical "Sports Card Inventory Checklist" template (32
// numbered cells per row). If the print-defect threshold below ever changes, update
// both copies.
export const COLUMNS_PER_ROW = 32

const PRINT_DEFECT_THRESHOLD = 877

export function cardNumberForCell(row: number, col: number): number {
  const sequential = (row - 1) * COLUMNS_PER_ROW + col
  return sequential >= PRINT_DEFECT_THRESHOLD ? sequential + 1 : sequential
}

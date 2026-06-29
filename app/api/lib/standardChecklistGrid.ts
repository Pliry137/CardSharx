// Geometry for the "Sports Card Inventory Checklist" template — the one fixed,
// preprinted sheet Joe uses for every set (confirmed: same physical form every time,
// just different Year/Company written at top and a different X pattern below).
//
// Each row holds exactly 32 numbered cells, read left to right; rows are read top to
// bottom; card_number = position in that left-to-right/top-to-bottom sequence. Because
// the layout never changes, we don't need Claude to read the tiny printed numbers in
// each cell at all — it only needs to report whether each cell is marked (X) or blank.
// The server computes the real card_number from (row, col) directly. This is both
// cheaper (Claude's output is a compact bitstring instead of a JSON object per card)
// and more accurate (no risk of Claude misreading a small printed digit).

export const COLUMNS_PER_ROW = 32

// Known print defect in the physical template: row 28 (cells 865-897) skips printing
// the number 877 — the printed range spans 33 numbers but still only holds 32 cells.
// Confirmed by Joe inspecting the sheet directly (2026-06-29). Every card number from
// 877 onward is shifted up by one as a result. This only matters for sets with more
// than 864 cards, which is rare (1990 Topps: 792, 1991 Fleer: 720, 1990 Fleer: 660 —
// none reach it), but the formula accounts for it so it's correct if it ever comes up.
const PRINT_DEFECT_THRESHOLD = 877

export function cardNumberForCell(row: number, col: number): number {
  const sequential = (row - 1) * COLUMNS_PER_ROW + col
  return sequential >= PRINT_DEFECT_THRESHOLD ? sequential + 1 : sequential
}

export interface UncertainCell {
  row: number
  col: number
  confidence: number
}

export interface GridCard {
  card_number: string
  // The template has no printed player/subject names — this is always just the
  // card number as a placeholder. Real names get filled in automatically at save
  // time via the bundled checklist lookup (api/checklist-lookup.ts).
  player_or_subject_name: string
  owned: boolean
  presence_confidence: number
}

/**
 * Converts Claude's compact per-row mark bitstrings into the full per-card list the
 * rest of the app expects (api/vision-capture.ts response, src/types VisionCaptureResult).
 *
 * @param rows One string per grid row, top to bottom. Each char is '1' (marked/X) or
 *   '0' (blank), left to right. Rows may be shorter than 32 chars for a partially
 *   printed final row — missing positions are simply skipped.
 * @param totalCardCount The set's real card count, when known (e.g. read from a
 *   handwritten "660 total cards" note). Cells whose computed card_number exceeds
 *   this are dropped — they're unused template cells, not real cards. When null,
 *   every cell Claude reported is kept as-is.
 * @param uncertainCells Sparse list of cells Claude flagged as ambiguous, with its
 *   own confidence for that cell. Cells not listed default to high confidence (0.97)
 *   since most marks on these sheets are unambiguous red X vs. clean blank.
 */
export function buildCardsFromGrid(
  rows: string[],
  totalCardCount: number | null,
  uncertainCells: UncertainCell[],
): GridCard[] {
  const uncertainMap = new Map<string, number>()
  for (const u of uncertainCells) uncertainMap.set(`${u.row}:${u.col}`, u.confidence)

  const cards: GridCard[] = []
  rows.forEach((rowStr, idx) => {
    const row = idx + 1
    for (let col = 1; col <= COLUMNS_PER_ROW; col++) {
      const mark = rowStr[col - 1]
      if (mark === undefined) continue // short/partial final row
      const cardNumber = cardNumberForCell(row, col)
      if (totalCardCount != null && cardNumber > totalCardCount) continue
      cards.push({
        card_number: String(cardNumber),
        player_or_subject_name: String(cardNumber),
        owned: mark === '1',
        presence_confidence: uncertainMap.get(`${row}:${col}`) ?? 0.97,
      })
    }
  })

  // Safety net: if Claude under-reported rows (e.g. truncated near the bottom of a
  // long sheet) and we know the real total, fill in any missing card numbers as
  // low-confidence "not owned" so they show up in Capture.tsx's review flow instead
  // of silently vanishing from the set entirely.
  if (totalCardCount != null) {
    const seen = new Set(cards.map((c) => Number(c.card_number)))
    for (let n = 1; n <= totalCardCount; n++) {
      if (!seen.has(n)) {
        cards.push({
          card_number: String(n),
          player_or_subject_name: String(n),
          owned: false,
          presence_confidence: 0.4,
        })
      }
    }
    cards.sort((a, b) => Number(a.card_number) - Number(b.card_number))
  }

  return cards
}

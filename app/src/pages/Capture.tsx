import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CollectionType, ScanBatch, ScanBatchPageResult, VisionCaptureResult } from '../types'
import { COLUMNS_PER_ROW, cardNumberForCell } from '../lib/checklistGrid'

// Cards (and the owner name) read with confidence below this threshold get
// flagged for the user to manually confirm present/absent before saving,
// rather than silently trusting Claude's guess.
const CONFIRM_THRESHOLD = 0.85

type ReviewCard = VisionCaptureResult['cards'][number] & {
  confirmed: boolean
  // Claude's original read, captured once at parse time and never mutated — lets the
  // review UI show "what Claude thinks" separately from whatever the user has since
  // flipped `owned` to, instead of losing that signal the moment they correct it.
  detectedOwned: boolean
}

const COLLECTION_TYPES: CollectionType[] = ['baseball', 'football', 'basketball', 'non-sport']

export default function Capture() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<VisionCaptureResult | null>(null)
  const [cards, setCards] = useState<ReviewCard[]>([])
  // Untouched copy of what the scan actually read, kept around so the total-count box
  // below can re-derive `cards` repeatedly (e.g. user shrinks then grows the number)
  // without ever re-running OMR or losing Claude's original per-cell read.
  const [rawCards, setRawCards] = useState<VisionCaptureResult['cards']>([])
  // The checklist template has up to 897 numbered slots, but most real sets are much
  // smaller — this lets the user say "this set only has 12 cards" up front so they
  // don't have to review/confirm hundreds of slots the set doesn't actually use.
  // Purely a client-side filter over the already-scanned grid; never touches OMR.
  const [totalCountInput, setTotalCountInput] = useState('')
  const [totalCountApplied, setTotalCountApplied] = useState<number | null>(null)
  const [totalCountError, setTotalCountError] = useState<string | null>(null)
  const [ownerName, setOwnerName] = useState('')
  const [ownerConfirmed, setOwnerConfirmed] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Vision capture doesn't determine the sport — the same blank numeric checklist
  // template looks the same for baseball/football/basketball. User picks it so we
  // know which `collections.type` to file the set under and which bundled checklist
  // (api/lib/checklists/) to check for real player names.
  const [collectionType, setCollectionType] = useState<CollectionType>('baseball')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  // True when the just-saved set's names came from Claude's auto-generated checklist
  // fallback rather than the manually-sourced bundled library — drives the amber
  // "please verify" styling on saveMsg below instead of the normal saved-gray.
  const [checklistUnverified, setChecklistUnverified] = useState(false)
  // Grid view lays the cards out 32-per-row to match the physical checklist sheet,
  // so corrections can be made by tapping cells in place rather than scrolling a
  // long list — useful since the vision read is the part most likely to be wrong.
  const [reviewView, setReviewView] = useState<'grid' | 'list'>('grid')
  // On phones the grid is too narrow to show a 3-digit number per cell, so cells
  // become plain color swatches there — this tracks the last tapped one so we can
  // show "#121 — Claude: missing, now: present" as text instead.
  const [lastTappedIndex, setLastTappedIndex] = useState<number | null>(null)

  // Multi-page scan batch state — only set when the current upload is a PDF, which
  // may contain several checklist sheets (see api/scan-batch-create.ts /
  // api/scan-batch-page.ts). A plain photo/image upload never sets these and uses
  // the original single-shot /api/vision-capture flow below instead.
  const [batchId, setBatchId] = useState<string | null>(null)
  const [batchTotalPages, setBatchTotalPages] = useState<number | null>(null)
  const [batchFilename, setBatchFilename] = useState<string | null>(null)
  const [currentPageNumber, setCurrentPageNumber] = useState<number | null>(null)
  // Transient status text shown between sheets ("Saved sheet 3 of 12 — moving to
  // sheet 4 of 12.") and on batch completion.
  const [batchMsg, setBatchMsg] = useState<string | null>(null)
  // An in_progress batch found on page load (from a previous session, possibly a
  // different device) that the user can jump back into instead of re-uploading.
  const [resumableBatch, setResumableBatch] = useState<{
    batch: ScanBatch
    nextPage: number
    pendingCount: number
  } | null>(null)

  // On mount, check whether there's an unfinished multi-page upload to offer to
  // resume. Batch progress lives in the database (not browser-only state), so this
  // works even after closing the tab or switching devices.
  useEffect(() => {
    checkForResumableBatch()
  }, [])

  async function checkForResumableBatch() {
    const { data: batch } = await supabase
      .from('scan_batches')
      .select('*')
      .eq('status', 'in_progress')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!batch) return

    const { data: pendingPages, count } = await supabase
      .from('scan_batch_pages')
      .select('page_number', { count: 'exact' })
      .eq('batch_id', batch.id)
      .eq('status', 'pending')
      .order('page_number')

    if (!pendingPages || pendingPages.length === 0) return
    setResumableBatch({ batch, nextPage: pendingPages[0].page_number, pendingCount: count ?? pendingPages.length })
  }

  // Populates all the review state (cards, owner, total-count box, etc.) from a
  // freshly-read sheet — shared by the single-shot flow and every batch page load,
  // so a batch page behaves identically to a standalone upload once it's loaded.
  function applyCaptureResult(data: VisionCaptureResult) {
    setResult(data)
    setRawCards(data.cards)
    setCards(
      data.cards.map((c) => ({
        ...c,
        // Confident reads are pre-confirmed; low-confidence ones need a tap.
        confirmed: c.presence_confidence >= CONFIRM_THRESHOLD,
        detectedOwned: c.owned,
      })),
    )
    setTotalCountInput('')
    setTotalCountApplied(null)
    setTotalCountError(null)
    setOwnerName(data.owner_name ?? '')
    setOwnerConfirmed((data.owner_name ?? null) !== null && data.owner_confidence >= CONFIRM_THRESHOLD)
    setLastTappedIndex(null)
    setSaveState('idle')
    setSaveMsg(null)
  }

  async function loadBatchPage(id: string, pageNumber: number, totalPages: number, filename: string | null, msg: string | null) {
    setStatus('uploading')
    setErrorMsg(null)
    setPreview(null)

    try {
      const res = await fetch('/api/scan-batch-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: id, page_number: pageNumber }),
      })
      if (!res.ok) throw new Error(`Could not read sheet ${pageNumber} (${res.status})`)

      const data: ScanBatchPageResult = await res.json()
      applyCaptureResult(data)
      setBatchId(id)
      setBatchTotalPages(totalPages)
      setBatchFilename(filename)
      setCurrentPageNumber(pageNumber)
      setBatchMsg(msg)
      setStatus('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      setStatus('error')
    }
  }

  function resumeBatch() {
    if (!resumableBatch) return
    const { batch, nextPage } = resumableBatch
    setResumableBatch(null)
    loadBatchPage(
      batch.id,
      nextPage,
      batch.total_pages,
      batch.original_filename,
      `Resuming "${batch.original_filename ?? 'this upload'}" — sheet ${nextPage} of ${batch.total_pages}`,
    )
  }

  // After a sheet is saved or skipped, finds the next pending page in the same
  // batch and loads it automatically, or marks the whole batch completed once
  // nothing is left.
  async function goToNextBatchPageOrFinish(messagePrefix: string) {
    if (!batchId || !batchTotalPages) return

    const { data: next } = await supabase
      .from('scan_batch_pages')
      .select('page_number')
      .eq('batch_id', batchId)
      .eq('status', 'pending')
      .order('page_number')
      .limit(1)
      .maybeSingle()

    if (next) {
      await loadBatchPage(
        batchId,
        next.page_number,
        batchTotalPages,
        batchFilename,
        `${messagePrefix} — moving to sheet ${next.page_number} of ${batchTotalPages}.`,
      )
    } else {
      await supabase.from('scan_batches').update({ status: 'completed' }).eq('id', batchId)
      setBatchMsg(`${messagePrefix}. All ${batchTotalPages} sheets in this upload are done.`)
      setStatus('idle')
      setResult(null)
      setCards([])
      setBatchId(null)
      setCurrentPageNumber(null)
    }
  }

  async function skipCurrentPage() {
    if (!batchId || !currentPageNumber || !batchTotalPages) return
    await supabase
      .from('scan_batch_pages')
      .update({ status: 'skipped' })
      .eq('batch_id', batchId)
      .eq('page_number', currentPageNumber)
    await goToNextBatchPageOrFinish(`Skipped sheet ${currentPageNumber} of ${batchTotalPages}`)
  }

  async function handleFile(file: File) {
    setBatchMsg(null)

    if (file.type === 'application/pdf') {
      // A PDF may hold several checklist sheets — always go through the batch flow
      // for PDFs (even single-page ones), so storage/resume tracking is consistent.
      // See api/scan-batch-create.ts.
      setBatchId(null)
      setBatchTotalPages(null)
      setBatchFilename(null)
      setCurrentPageNumber(null)
      setPreview(null)
      setStatus('uploading')
      setErrorMsg(null)

      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/scan-batch-create', { method: 'POST', body: formData })
        if (!res.ok) throw new Error(`Could not start scan batch (${res.status})`)

        const created: { batch_id: string; total_pages: number; original_filename: string | null } = await res.json()
        await loadBatchPage(
          created.batch_id,
          1,
          created.total_pages,
          created.original_filename,
          created.total_pages > 1 ? `Found ${created.total_pages} sheets in this upload.` : null,
        )
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
        setStatus('error')
      }
      return
    }

    // Plain photo/image upload — original single-shot flow, no batch tracking.
    setBatchId(null)
    setBatchTotalPages(null)
    setBatchFilename(null)
    setCurrentPageNumber(null)
    setPreview(URL.createObjectURL(file))
    setStatus('uploading')
    setErrorMsg(null)

    try {
      const formData = new FormData()
      formData.append('image', file)

      // Calls the Claude Vision capture endpoint — see api/vision-capture.ts.
      // Returns structured card/checklist data plus a best-guess set match.
      const res = await fetch('/api/vision-capture', { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`Capture failed (${res.status})`)

      const data: VisionCaptureResult = await res.json()
      applyCaptureResult(data)
      setStatus('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      setStatus('error')
    }
  }

  const needsReview = useMemo(() => cards.filter((c) => !c.confirmed), [cards])
  const readyToSave = needsReview.length === 0 && ownerConfirmed

  // Maps a card_number to its index in `cards`, for the grid view to look up which
  // card belongs at each (row, col) position computed via cardNumberForCell.
  const cardIndexByNumber = useMemo(() => {
    const map = new Map<string, number>()
    cards.forEach((c, i) => map.set(c.card_number, i))
    return map
  }, [cards])

  const gridRows = useMemo(() => {
    const maxCardNumber = cards.reduce((max, c) => Math.max(max, parseInt(c.card_number, 10) || 0), 0)
    return Math.max(1, Math.ceil(maxCardNumber / COLUMNS_PER_ROW) + 1)
  }, [cards])

  function toggleOwned(index: number) {
    setCards((prev) =>
      prev.map((c, i) => (i === index ? { ...c, owned: !c.owned, confirmed: true } : c)),
    )
  }

  function confirmCard(index: number) {
    setCards((prev) => prev.map((c, i) => (i === index ? { ...c, confirmed: true } : c)))
  }

  // Re-derives the working `cards` list to cover exactly card numbers 1..n, dropping
  // any scanned slot above the real set size and adding placeholders for any number
  // below it that the scan didn't produce (e.g. a row near the bottom got cut off).
  // Re-running this with a different number is always safe — it reads from `rawCards`
  // (the original scan) and the current `cards` (to preserve any manual flips already
  // made), never from OMR, so the underlying scan is never touched.
  function applyTotalCount() {
    const n = parseInt(totalCountInput, 10)
    if (!Number.isFinite(n) || n <= 0) {
      setTotalCountError('Enter a whole number greater than 0')
      return
    }
    setTotalCountError(null)

    const currentByNumber = new Map(cards.map((c) => [Number(c.card_number), c]))
    const rawByNumber = new Map(rawCards.map((c) => [Number(c.card_number), c]))

    const next: ReviewCard[] = []
    for (let num = 1; num <= n; num++) {
      const existing = currentByNumber.get(num)
      if (existing) {
        next.push(existing)
        continue
      }
      const raw = rawByNumber.get(num)
      if (raw) {
        next.push({ ...raw, confirmed: raw.presence_confidence >= CONFIRM_THRESHOLD, detectedOwned: raw.owned })
        continue
      }
      // Never scanned at all (rare — only if the set's real size exceeds what the
      // sheet's grid covers) — add as a low-confidence "missing" placeholder so it's
      // visible for manual confirmation rather than silently absent.
      next.push({
        card_number: String(num),
        player_or_subject_name: String(num),
        presence_confidence: 0.4,
        owned: false,
        confirmed: false,
        detectedOwned: false,
      })
    }
    setCards(next)
    setTotalCountApplied(n)
  }

  async function handleSave() {
    if (!result || !readyToSave) return
    setSaveState('saving')
    setSaveMsg(null)
    setChecklistUnverified(false)

    try {
      // 1. Check the bundled checklist library for this exact sport/year/manufacturer.
      //    If it's been sourced before (e.g. 1991 Fleer baseball), this comes back with
      //    real player names for every card number — no manual SQL, every time.
      let realNames: Record<string, string> = {}
      let checklistFound = false
      // True for the bundled, manually-sourced checklist library; false when the names
      // came from Claude's auto-generated/cached fallback (api/checklist-lookup.ts tiers
      // 2-3) — those haven't been spot-checked against a real source yet.
      let checklistVerified = true
      // True when checklist-lookup kicked off generation in the background instead of
      // finding a cached/bundled checklist — names aren't ready yet, but should be cached
      // for next time (api/checklist-lookup.ts tier 3, generated via waitUntil()).
      let checklistGenerating = false
      try {
        const lookupRes = await fetch('/api/checklist-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sport: collectionType,
            year: result.year,
            manufacturer: result.manufacturer,
          }),
        })
        if (lookupRes.ok) {
          const lookupData = await lookupRes.json()
          checklistFound = !!lookupData.found
          checklistVerified = lookupData.verified ?? true
          checklistGenerating = !!lookupData.generating
          realNames = lookupData.names ?? {}
        }
      } catch {
        // Network hiccup on the lookup shouldn't block saving the scan itself.
      }

      // 2. Find-or-create the collection for this sport.
      const collectionName = `${collectionType[0].toUpperCase()}${collectionType.slice(1)} Cards`
      const { data: existingCollection } = await supabase
        .from('collections')
        .select('id')
        .eq('type', collectionType)
        .limit(1)
        .maybeSingle()

      let collectionId = existingCollection?.id as string | undefined
      if (!collectionId) {
        const { data: newCollection, error: collectionErr } = await supabase
          .from('collections')
          .insert({ name: collectionName, type: collectionType })
          .select('id')
          .single()
        if (collectionErr || !newCollection) throw new Error(collectionErr?.message ?? 'Could not create collection')
        collectionId = newCollection.id
      }

      // 3. Create the set.
      const setName = result.detected_set_name ?? `${result.year ?? 'Unknown year'} ${result.manufacturer ?? 'Unknown'}`
      const { data: newSet, error: setErr } = await supabase
        .from('sets')
        .insert({
          collection_id: collectionId,
          name: setName,
          year: result.year,
          manufacturer: result.manufacturer,
          total_card_count: cards.length,
          owner: ownerName || null,
        })
        .select('id')
        .single()
      if (setErr || !newSet) throw new Error(setErr?.message ?? 'Could not create set')

      // 4. Insert cards — real checklist name wins when we have one, otherwise fall back
      //    to whatever Vision read off the photo (often just the card number, since these
      //    checklists are blank numeric templates with no printed names).
      const cardRows = cards.map((c) => ({
        set_id: newSet.id,
        card_number: c.card_number,
        player_or_subject_name: realNames[c.card_number] ?? c.player_or_subject_name,
        owned: c.owned,
      }))
      const { error: cardsErr } = await supabase.from('cards').insert(cardRows)
      if (cardsErr) throw new Error(cardsErr.message)

      const namedCount = cardRows.filter((c) => realNames[c.card_number]).length
      setSaveState('saved')
      setChecklistUnverified(checklistFound && !checklistVerified)
      setSaveMsg(
        checklistFound
          ? checklistVerified
            ? `Saved ${cardRows.length} cards — real player names auto-filled for ${namedCount}/${cardRows.length} from the bundled checklist.`
            : `Saved ${cardRows.length} cards — real player names auto-filled for ${namedCount}/${cardRows.length} from a Claude-generated checklist (trained knowledge, not yet manually verified). Please double-check names before relying on them, especially for inserts/variations.`
          : checklistGenerating
            ? `Saved ${cardRows.length} cards. No checklist for ${result.year ?? '?'} ${result.manufacturer ?? 'this set'} yet — Claude is generating one in the background now. Names are best-effort from the photo for this save; the next save/scan of this set will get real names automatically.`
            : `Saved ${cardRows.length} cards. No checklist found yet for ${result.year ?? '?'} ${result.manufacturer ?? 'this set'} — names are best-effort from the photo until one is generated.`,
      )

      // If this sheet came from a multi-page batch, mark it processed and move on
      // to the next pending sheet automatically (or finish the batch).
      if (batchId && currentPageNumber && batchTotalPages) {
        await supabase
          .from('scan_batch_pages')
          .update({ status: 'processed', set_id: newSet.id, processed_at: new Date().toISOString() })
          .eq('batch_id', batchId)
          .eq('page_number', currentPageNumber)
        await goToNextBatchPageOrFinish(`Saved sheet ${currentPageNumber} of ${batchTotalPages}`)
      }
    } catch (err) {
      setSaveState('error')
      setSaveMsg(err instanceof Error ? err.message : 'Save failed')
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Scan a checklist or card</h1>
      <p className="text-sm text-slate-500">
        Photograph a paper checklist (one sheet = one set) or a card front/back. Claude Vision
        will parse it into structured card data for you to review before saving.
      </p>

      {resumableBatch && status === 'idle' && (
        <div className="rounded-lg border border-brand-300 dark:border-brand-800 bg-brand-50 dark:bg-brand-950/30 p-3 flex items-center justify-between gap-3">
          <p className="text-sm text-brand-700 dark:text-brand-300">
            Unfinished scan: {resumableBatch.batch.original_filename ?? 'untitled upload'} — sheet{' '}
            {resumableBatch.nextPage} of {resumableBatch.batch.total_pages} ({resumableBatch.pendingCount} left)
          </p>
          <button
            onClick={resumeBatch}
            className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white shrink-0"
          >
            Resume
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
        }}
      />

      <button
        onClick={() => fileInputRef.current?.click()}
        className="w-full rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 py-10 text-sm text-slate-500"
      >
        Tap to take a photo or upload an image
      </button>

      {preview && (
        <img src={preview} alt="Captured checklist preview" className="rounded-lg max-h-64 mx-auto" />
      )}

      {status === 'uploading' && <p className="text-sm text-slate-400">Reading image with Claude…</p>}
      {status === 'error' && <p className="text-sm text-red-500">{errorMsg}</p>}

      {status === 'done' && result && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          {batchId && batchTotalPages && (
            <p className="text-xs text-slate-400">
              Sheet {currentPageNumber} of {batchTotalPages} in this upload
              {batchFilename ? ` (${batchFilename})` : ''}
            </p>
          )}
          {batchMsg && (
            <p className="text-xs text-brand-600 dark:text-brand-300">{batchMsg}</p>
          )}

          <p className="text-sm">
            Detected set:{' '}
            <span className="font-medium">{result.detected_set_name ?? 'Not detected'}</span>{' '}
            {result.detected_set_name && (
              <span className="text-xs text-slate-400">
                ({Math.round(result.detected_set_confidence * 100)}% confidence)
              </span>
            )}
          </p>
          {!result.detected_set_name && (
            <p className="text-xs text-amber-500">
              Couldn't auto-detect the set — you'll be able to pick it manually before saving.
            </p>
          )}

          {/* Total card count override — the printed template has up to 897 numbered
              slots, but most real sets are much smaller. Set this first so the review
              views below only ever show the cards that actually exist in this set,
              instead of needing to confirm every unused slot on the sheet. Purely a
              client-side filter over the already-scanned grid — never re-runs OMR. */}
          <div className="rounded-md bg-slate-50 dark:bg-slate-900 p-3 space-y-2">
            <p className="text-sm">
              How many cards are in this set?{' '}
              <span className="text-xs text-slate-400">
                (the scan found {rawCards.length} slots on the sheet — set this lower if the real set is
                smaller)
              </span>
            </p>
            <div className="flex gap-2 items-center">
              <input
                type="number"
                min={1}
                value={totalCountInput}
                onChange={(e) => setTotalCountInput(e.target.value)}
                placeholder={String(rawCards.length)}
                className="text-sm border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 bg-transparent w-28"
              />
              <button
                onClick={applyTotalCount}
                disabled={!totalCountInput.trim()}
                className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white disabled:opacity-40"
              >
                Apply
              </button>
              {totalCountApplied !== null && (
                <span className="text-xs text-slate-400">Showing cards 1–{totalCountApplied}</span>
              )}
            </div>
            {totalCountError && <p className="text-xs text-red-500">{totalCountError}</p>}
          </div>

          {/* Sport / collection type — Vision can't tell this from a blank numeric
              checklist template, and it determines both which collection the set files
              under and which bundled checklist gets checked for real player names. */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Sport:</span>
            <select
              value={collectionType}
              onChange={(e) => setCollectionType(e.target.value as CollectionType)}
              className="text-sm border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 bg-transparent"
            >
              {COLLECTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Owner confirmation — handwritten name in the corner of the checklist */}
          <div className="rounded-md bg-slate-50 dark:bg-slate-900 p-3 space-y-2">
            {ownerConfirmed ? (
              <p className="text-sm">
                Owner: <span className="font-medium">{ownerName}</span>
              </p>
            ) : (
              <>
                <p className="text-sm text-amber-600">
                  {result.owner_name
                    ? `Is "${result.owner_name}" the right owner for this set?`
                    : "Couldn't read a name on this checklist — whose set is this?"}
                </p>
                <div className="flex gap-2 items-center">
                  <input
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="Owner name"
                    className="text-sm border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 bg-transparent flex-1"
                  />
                  <button
                    onClick={() => setOwnerConfirmed(true)}
                    disabled={!ownerName.trim()}
                    className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white disabled:opacity-40"
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-slate-500">
              {cards.length} cards parsed
              {needsReview.length > 0 && (
                <span className="text-amber-500"> — {needsReview.length} need your confirmation</span>
              )}
            </p>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => setReviewView('grid')}
                className={`text-xs px-2 py-1 rounded-md border ${
                  reviewView === 'grid'
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                Grid
              </button>
              <button
                onClick={() => setReviewView('list')}
                className={`text-xs px-2 py-1 rounded-md border ${
                  reviewView === 'list'
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                List
              </button>
            </div>
          </div>

          {reviewView === 'grid' ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                Laid out like the checklist sheet (32 per row). Tap any cell to flip it. On a narrow
                screen the cells are too small to print numbers on — tap one and its number shows
                below the grid.
              </p>
              {/* No horizontal scrolling: columns are `1fr` (no minimum px width) so the whole
                  32-wide grid always shrinks to fit the screen. On phones that makes each cell
                  small — by design, the trade-off for keeping the full sheet visible at once
                  instead of scrolling left/right to find a card. */}
              <div
                className="grid w-full gap-px bg-slate-200 dark:bg-slate-800 p-px rounded"
                style={{ gridTemplateColumns: `repeat(${COLUMNS_PER_ROW}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: gridRows }).flatMap((_, rowIdx) =>
                  Array.from({ length: COLUMNS_PER_ROW }).map((__, colIdx) => {
                    const row = rowIdx + 1
                    const col = colIdx + 1
                    const num = cardNumberForCell(row, col)
                    const idx = cardIndexByNumber.get(String(num))

                    if (idx === undefined) {
                      return (
                        <div key={`${row}-${col}`} className="aspect-square bg-white dark:bg-slate-950" />
                      )
                    }

                    const c = cards[idx]
                    return (
                      <button
                        key={`${row}-${col}`}
                        type="button"
                        onClick={() => {
                          toggleOwned(idx)
                          setLastTappedIndex(idx)
                        }}
                        aria-label={`Card ${c.card_number}, Claude read ${c.detectedOwned ? 'present' : 'missing'}, currently ${c.owned ? 'present' : 'missing'}`}
                        className={`aspect-square min-w-0 text-[8px] sm:text-[10px] leading-none flex items-center justify-center overflow-hidden ${
                          c.owned
                            ? 'bg-emerald-500 text-white'
                            : 'bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-200'
                        } ${!c.confirmed ? 'ring-2 ring-amber-400 ring-inset' : ''} ${
                          lastTappedIndex === idx ? 'outline outline-2 outline-brand-500' : ''
                        }`}
                      >
                        <span className="hidden sm:inline">{c.card_number}</span>
                      </button>
                    )
                  }),
                )}
              </div>

              {lastTappedIndex !== null && cards[lastTappedIndex] && (
                <p className="text-xs bg-brand-50 dark:bg-brand-950/40 text-brand-700 dark:text-brand-300 rounded px-2 py-1">
                  #{cards[lastTappedIndex].card_number} {cards[lastTappedIndex].player_or_subject_name} —
                  Claude read: {cards[lastTappedIndex].detectedOwned ? 'present' : 'missing'}, now set to:{' '}
                  <strong>{cards[lastTappedIndex].owned ? 'present' : 'missing'}</strong>
                </p>
              )}

              <p className="text-xs text-slate-400 flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500" /> present
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-400" /> missing
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm ring-2 ring-amber-400 ring-inset" /> Claude
                  unsure
                </span>
              </p>
            </div>
          ) : (
            <ul className="text-sm max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
              {cards.map((c, i) => (
                <li
                  key={i}
                  className={`py-1.5 flex items-center justify-between gap-2 ${
                    !c.confirmed ? 'bg-amber-50 dark:bg-amber-950/30 -mx-1 px-1 rounded' : ''
                  }`}
                >
                  <span className="flex-1">
                    #{c.card_number} <span className="text-slate-400">{c.player_or_subject_name}</span>
                  </span>

                  <span className="text-[10px] text-slate-400 w-24 text-right shrink-0">
                    Claude: {c.detectedOwned ? 'present' : 'missing'}
                    {!c.confirmed && ' (?)'}
                  </span>

                  <span
                    className={`text-xs w-14 text-right shrink-0 ${c.owned ? 'text-emerald-600' : 'text-slate-400'}`}
                  >
                    {c.owned ? 'Present' : 'Missing'}
                  </span>

                  <button
                    onClick={() => toggleOwned(i)}
                    className="text-xs px-2 py-1 rounded-md bg-slate-500 text-white shrink-0"
                  >
                    Flip
                  </button>

                  {!c.confirmed && (
                    <button
                      onClick={() => confirmCard(i)}
                      className="text-xs px-2 py-1 rounded-md bg-emerald-600 text-white shrink-0"
                    >
                      Confirm
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!readyToSave || saveState === 'saving' || saveState === 'saved'}
              className="flex-1 text-xs px-3 py-2 rounded-md bg-brand-600 text-white disabled:opacity-40"
            >
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'saved'
                  ? 'Saved'
                  : readyToSave
                    ? 'Save to collection'
                    : 'Confirm all flagged cards to save'}
            </button>

            {batchId && saveState !== 'saving' && saveState !== 'saved' && (
              <button
                onClick={skipCurrentPage}
                className="shrink-0 text-xs px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              >
                Skip this sheet
              </button>
            )}
          </div>

          {saveMsg && (
            <p
              className={`text-xs ${
                saveState === 'error'
                  ? 'text-red-500'
                  : checklistUnverified
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-slate-500'
              }`}
            >
              {saveMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

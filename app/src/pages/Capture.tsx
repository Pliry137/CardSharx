import { useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CollectionType, VisionCaptureResult } from '../types'

// Cards (and the owner name) read with confidence below this threshold get
// flagged for the user to manually confirm present/absent before saving,
// rather than silently trusting Claude's guess.
const CONFIRM_THRESHOLD = 0.85

type ReviewCard = VisionCaptureResult['cards'][number] & { confirmed: boolean }

const COLLECTION_TYPES: CollectionType[] = ['baseball', 'football', 'basketball', 'non-sport']

export default function Capture() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<VisionCaptureResult | null>(null)
  const [cards, setCards] = useState<ReviewCard[]>([])
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

  async function handleFile(file: File) {
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
      setResult(data)
      setCards(
        data.cards.map((c) => ({
          ...c,
          // Confident reads are pre-confirmed; low-confidence ones need a tap.
          confirmed: c.presence_confidence >= CONFIRM_THRESHOLD,
        })),
      )
      setOwnerName(data.owner_name ?? '')
      setOwnerConfirmed((data.owner_name ?? null) !== null && data.owner_confidence >= CONFIRM_THRESHOLD)
      setStatus('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      setStatus('error')
    }
  }

  const needsReview = useMemo(() => cards.filter((c) => !c.confirmed), [cards])
  const readyToSave = needsReview.length === 0 && ownerConfirmed

  function toggleOwned(index: number) {
    setCards((prev) =>
      prev.map((c, i) => (i === index ? { ...c, owned: !c.owned, confirmed: true } : c)),
    )
  }

  function confirmCard(index: number) {
    setCards((prev) => prev.map((c, i) => (i === index ? { ...c, confirmed: true } : c)))
  }

  async function handleSave() {
    if (!result || !readyToSave) return
    setSaveState('saving')
    setSaveMsg(null)

    try {
      // 1. Check the bundled checklist library for this exact sport/year/manufacturer.
      //    If it's been sourced before (e.g. 1991 Fleer baseball), this comes back with
      //    real player names for every card number — no manual SQL, every time.
      let realNames: Record<string, string> = {}
      let checklistFound = false
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
      setSaveMsg(
        checklistFound
          ? `Saved ${cardRows.length} cards — real player names auto-filled for ${namedCount}/${cardRows.length} from the bundled checklist.`
          : `Saved ${cardRows.length} cards. No bundled checklist found yet for ${result.year ?? '?'} ${result.manufacturer ?? 'this set'} — names are best-effort from the photo until one is added.`,
      )
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

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
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
                    className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-40"
                  >
                    Confirm
                  </button>
                </div>
              </>
            )}
          </div>

          <p className="text-sm text-slate-500">
            {cards.length} cards parsed
            {needsReview.length > 0 && (
              <span className="text-amber-500"> — {needsReview.length} need your confirmation</span>
            )}
          </p>

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

                {c.confirmed ? (
                  <span className={c.owned ? 'text-emerald-600 text-xs' : 'text-slate-400 text-xs'}>
                    {c.owned ? 'Present' : 'Missing'}
                  </span>
                ) : (
                  <span className="flex gap-1 items-center">
                    <span className="text-xs text-amber-500">
                      {c.owned ? 'Present?' : 'Missing?'}
                    </span>
                    <button
                      onClick={() => confirmCard(i)}
                      className="text-xs px-2 py-1 rounded-md bg-emerald-600 text-white"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => toggleOwned(i)}
                      className="text-xs px-2 py-1 rounded-md bg-slate-500 text-white"
                    >
                      Flip
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <button
            onClick={handleSave}
            disabled={!readyToSave || saveState === 'saving' || saveState === 'saved'}
            className="w-full text-xs px-3 py-2 rounded-md bg-indigo-600 text-white disabled:opacity-40"
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved'
                : readyToSave
                  ? 'Save to collection'
                  : 'Confirm all flagged cards to save'}
          </button>

          {saveMsg && (
            <p className={`text-xs ${saveState === 'error' ? 'text-red-500' : 'text-slate-500'}`}>
              {saveMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import type { VisionCaptureResult } from '../types'

// Cards (and the owner name) read with confidence below this threshold get
// flagged for the user to manually confirm present/absent before saving,
// rather than silently trusting Claude's guess.
const CONFIRM_THRESHOLD = 0.85

type ReviewCard = VisionCaptureResult['cards'][number] & { confirmed: boolean }

export default function Capture() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<VisionCaptureResult | null>(null)
  const [cards, setCards] = useState<ReviewCard[]>([])
  const [ownerName, setOwnerName] = useState('')
  const [ownerConfirmed, setOwnerConfirmed] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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
            disabled={!readyToSave}
            className="w-full text-xs px-3 py-2 rounded-md bg-indigo-600 text-white disabled:opacity-40"
          >
            {readyToSave ? 'Save to collection' : 'Confirm all flagged cards to save'}
          </button>
        </div>
      )}
    </div>
  )
}

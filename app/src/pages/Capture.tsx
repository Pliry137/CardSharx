import { useRef, useState } from 'react'
import type { VisionCaptureResult } from '../types'

export default function Capture() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<VisionCaptureResult | null>(null)
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
      setStatus('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      setStatus('error')
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
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2">
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
          <p className="text-sm text-slate-500">{result.cards.length} cards parsed</p>
          <ul className="text-sm max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {result.cards.map((c, i) => (
              <li key={i} className="py-1 flex justify-between">
                <span>#{c.card_number}</span>
                <span>{c.player_or_subject_name}</span>
              </li>
            ))}
          </ul>
          <button className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white">
            Save to collection
          </button>
        </div>
      )}
    </div>
  )
}

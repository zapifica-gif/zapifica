import { useState, type ChangeEventHandler } from 'react'
import { FileText, Image as ImageIcon, Loader2, MessageSquare, Mic, Upload, Video } from 'lucide-react'
import { supabase } from '../../lib/supabase'

export type IscaFunnelMediaType = 'text' | 'image' | 'video' | 'audio' | 'document'

const MEDIA_TYPE_OPTIONS: {
  value: IscaFunnelMediaType
  label: string
  icon: typeof MessageSquare
}[] = [
  { value: 'text', label: 'Texto', icon: MessageSquare },
  { value: 'image', label: 'Foto', icon: ImageIcon },
  { value: 'video', label: 'Vídeo', icon: Video },
  { value: 'audio', label: 'Áudio', icon: Mic },
  { value: 'document', label: 'Arquivo', icon: FileText },
]

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'arquivo'
}

export type IscaSlotModel = {
  text: string
  mediaType: IscaFunnelMediaType
  mediaUrl: string | null
}

export type IscaFiveSlotsEditorProps = {
  userId: string | null
  disabled?: boolean
  slots: IscaSlotModel[]
  onChange: (index: number, patch: Partial<IscaSlotModel>) => void
}

export function IscaFiveSlotsEditor({
  userId,
  disabled,
  slots,
  onChange,
}: IscaFiveSlotsEditorProps) {
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const handlePickMediaType = (idx: number, next: IscaFunnelMediaType) => {
    setLocalErr(null)
    onChange(idx, { mediaType: next, mediaUrl: next === 'text' ? null : slots[idx]?.mediaUrl ?? null })
  }

  const handleUpload: (idx: number) => ChangeEventHandler<HTMLInputElement> = (idx) => async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !userId) {
      if (!userId) setLocalErr('Faça login para enviar arquivos.')
      return
    }
    setLocalErr(null)
    setUploadingIdx(idx)
    const path = `${userId}/${Date.now()}_${sanitizeFileName(file.name)}`
    const { error: upErr } = await supabase.storage
      .from('campaign_media')
      .upload(path, file, { upsert: true, cacheControl: '3600' })
    if (upErr) {
      setLocalErr(`Upload: ${upErr.message}`)
      setUploadingIdx(null)
      return
    }
    const { data: pub } = supabase.storage.from('campaign_media').getPublicUrl(path)
    onChange(idx, { mediaUrl: pub.publicUrl })
    setUploadingIdx(null)
  }

  return (
    <div className="space-y-2">
      {localErr ? (
        <p className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-800">
          {localErr}
        </p>
      ) : null}
      {slots.map((slot, idx) => {
        const mediaNeedsUrl = slot.mediaType !== 'text'
        const uploading = uploadingIdx === idx
        return (
          <div key={idx} className="rounded-lg border border-zinc-200 bg-white p-2">
            <p className="mb-1 text-[11px] font-semibold text-zinc-600">Isca {idx + 1}</p>
            <div className="mb-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Tipo de mensagem
              </p>
              <div className="flex flex-wrap gap-1.5">
                {MEDIA_TYPE_OPTIONS.map(({ value, label, icon: Icon }) => {
                  const on = slot.mediaType === value
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={disabled}
                      onClick={() => handlePickMediaType(idx, value)}
                      title={label}
                      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border text-zinc-600 transition ${
                        on
                          ? 'border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-200'
                          : 'border-zinc-200 bg-white hover:border-zinc-300'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                      <span className="sr-only">{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {mediaNeedsUrl ? (
              <div className="mb-2 rounded-lg border border-zinc-100 bg-zinc-50/80 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Mídia (URL ou upload)
                </p>
                <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    value={slot.mediaUrl ?? ''}
                    disabled={disabled}
                    onChange={(e) => {
                      setLocalErr(null)
                      onChange(idx, { mediaUrl: e.target.value.trim() || null })
                    }}
                    placeholder="https://…"
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-900 shadow-inner focus:border-google-blue/35 focus:outline-none disabled:opacity-60"
                  />
                  <label className="inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 transition hover:border-brand-300 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50">
                    {uploading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Upload className="h-3.5 w-3.5" aria-hidden />
                    )}
                    Enviar
                    <input
                      type="file"
                      className="sr-only"
                      disabled={disabled || uploading || !userId}
                      accept={
                        slot.mediaType === 'image'
                          ? 'image/*'
                          : slot.mediaType === 'video'
                            ? 'video/*'
                            : slot.mediaType === 'audio'
                              ? 'audio/*'
                              : slot.mediaType === 'document'
                                ? '.pdf,.doc,.docx,.xls,.xlsx,.zip'
                                : '*/*'
                      }
                      onChange={handleUpload(idx)}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            <label className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              <MessageSquare className="h-3 w-3" aria-hidden />
              {slot.mediaType === 'text' ? 'Mensagem' : 'Legenda (caption)'}
            </label>
            <textarea
              rows={2}
              disabled={disabled}
              value={slot.text}
              onChange={(e) => onChange(idx, { text: e.target.value })}
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm shadow-inner focus:border-google-blue/35 focus:outline-none disabled:opacity-60"
            />
          </div>
        )
      })}
    </div>
  )
}

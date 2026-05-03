'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useField } from '@payloadcms/ui'

type MediaDoc = {
  id: string
  alt?: string
  filename?: string
  url?: string
  blobUrl?: string
  thumbnailURL?: string
}

type GalleryItem = {
  id?: string
  image?: string | MediaDoc | null
}

const MAX_IMAGES = 20

const getImageId = (item: GalleryItem): string | null => {
  if (!item?.image) return null
  if (typeof item.image === 'string') return item.image
  return item.image.id || null
}

const getMediaUrl = (media?: MediaDoc | null): string => {
  return media?.blobUrl || media?.url || media?.thumbnailURL || ''
}

const filenameToAlt = (filename: string): string => {
  return filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const moveItem = <T,>(items: T[], fromIndex: number, toIndex: number): T[] => {
  const next = [...items]
  const [removed] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, removed)
  return next
}

const getBoatIdFromAdminUrl = (): string | null => {
  if (typeof window === 'undefined') return null

  const match = window.location.pathname.match(/\/admin\/collections\/boats\/([^/?#]+)/)
  const boatId = match?.[1]

  if (!boatId || boatId === 'create') return null

  return decodeURIComponent(boatId)
}

const normaliseGalleryItems = (items: unknown): GalleryItem[] => {
  if (!Array.isArray(items)) return []

  return items
    .map((item: any) => {
      if (!item?.image) return null

      return {
        id: item.id,
        image: item.image,
      }
    })
    .filter(Boolean) as GalleryItem[]
}

const styles = {
  fieldWrap: {
    marginBottom: 28,
  } as React.CSSProperties,
  label: {
    display: 'block',
    fontWeight: 600,
    marginBottom: 8,
    color: 'var(--theme-text)',
  } as React.CSSProperties,
  helpText: {
    margin: '0 0 12px',
    color: 'var(--theme-elevation-500)',
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,
  dropzoneBase: {
    border: '1px dashed var(--theme-elevation-400)',
    borderRadius: 8,
    padding: 20,
    background: 'var(--theme-elevation-50)',
    color: 'var(--theme-text)',
    marginBottom: 16,
    transition: 'border-color 120ms ease, background 120ms ease',
  } as React.CSSProperties,
  chooseButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--theme-elevation-300)',
    borderRadius: 6,
    padding: '8px 12px',
    background: 'var(--theme-elevation-150)',
    color: 'var(--theme-text)',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: 14,
  } as React.CSSProperties,
  card: {
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 8,
    overflow: 'hidden',
    background: 'var(--theme-elevation-50)',
    color: 'var(--theme-text)',
    cursor: 'grab',
  } as React.CSSProperties,
  thumb: {
    height: 115,
    background: 'var(--theme-elevation-100)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as React.CSSProperties,
  cardButton: {
    fontSize: 12,
    padding: '5px 8px',
    border: '1px solid var(--theme-elevation-200)',
    borderRadius: 4,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-text)',
    cursor: 'pointer',
  } as React.CSSProperties,
}

export function BoatGalleryField({ path, label }: any) {
  const { value, setValue } = useField<GalleryItem[]>({ path })

  const galleryItems = useMemo(() => {
    return Array.isArray(value) ? value : []
  }, [value])

  const [mediaById, setMediaById] = useState<Record<string, MediaDoc>>({})
  const [isUploading, setIsUploading] = useState(false)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const draggedIndexRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const hasHydratedExistingGalleryRef = useRef(false)

  const imageIds = useMemo(() => {
    return galleryItems.map(getImageId).filter(Boolean) as string[]
  }, [galleryItems])

  useEffect(() => {
    const missingIds = imageIds.filter((id) => !mediaById[id])
    if (missingIds.length === 0) return

    let cancelled = false

    async function loadMedia() {
      const loadedEntries = await Promise.all(
        missingIds.map(async (id) => {
          try {
            const response = await fetch(`/api/media/${id}?depth=0`, {
              credentials: 'include',
            })

            if (!response.ok) return null

            const json = await response.json()
            const doc = json?.doc || json

            if (!doc?.id) return null

            return [id, doc] as const
          } catch {
            return null
          }
        }),
      )

      if (cancelled) return

      const nextMediaById = loadedEntries.reduce<Record<string, MediaDoc>>((acc, entry) => {
        if (!entry) return acc
        const [id, doc] = entry
        acc[id] = doc
        return acc
      }, {})

      if (Object.keys(nextMediaById).length > 0) {
        setMediaById((prev) => ({ ...prev, ...nextMediaById }))
      }
    }

    loadMedia()

    return () => {
      cancelled = true
    }
  }, [imageIds, mediaById])

  const updateGallery = useCallback(
    (nextItems: GalleryItem[]) => {
      setValue(nextItems)
    },
    [setValue],
  )

  useEffect(() => {
    if (hasHydratedExistingGalleryRef.current) return
    if (galleryItems.length > 0) return

    const boatId = getBoatIdFromAdminUrl()
    if (!boatId) return

    hasHydratedExistingGalleryRef.current = true

    let cancelled = false

    async function hydrateExistingGallery() {
      try {
        const response = await fetch(`/api/boats/${boatId}?depth=1`, {
          credentials: 'include',
        })

        if (!response.ok) return

        const json = await response.json()
        const doc = json?.doc || json
        const existingGallery = normaliseGalleryItems(doc?.gallery)

        if (cancelled || existingGallery.length === 0) return

        const existingMediaById = existingGallery.reduce<Record<string, MediaDoc>>((acc, item) => {
          if (item.image && typeof item.image === 'object' && item.image.id) {
            acc[item.image.id] = item.image
          }

          return acc
        }, {})

        if (Object.keys(existingMediaById).length > 0) {
          setMediaById((prev) => ({
            ...prev,
            ...existingMediaById,
          }))
        }

        updateGallery(existingGallery)
      } catch {
        // Do not block the admin form if fallback hydration fails.
      }
    }

    hydrateExistingGallery()

    return () => {
      cancelled = true
    }
  }, [galleryItems.length, updateGallery])

  const uploadSingleFile = async (file: File): Promise<MediaDoc> => {
    const alt = filenameToAlt(file.name)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('_payload', JSON.stringify({ alt }))
    formData.append('alt', alt)

    const response = await fetch('/api/media', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    })

    const json = await response.json().catch(() => null)

    if (!response.ok) {
      const responseMessage =
        json?.errors?.[0]?.message ||
        json?.message ||
        `Upload failed for ${file.name}`

      throw new Error(responseMessage)
    }

    const doc = json?.doc || json

    if (!doc?.id) {
      throw new Error(`Upload completed but media ID was missing for ${file.name}`)
    }

    return doc
  }

  const handleFiles = async (fileList: FileList | File[]) => {
    setError('')
    setMessage('')

    const incomingFiles = Array.from(fileList).filter((file) => file.type.startsWith('image/'))

    if (incomingFiles.length === 0) {
      setError('Please choose image files only.')
      return
    }

    const remainingSlots = MAX_IMAGES - galleryItems.length

    if (remainingSlots <= 0) {
      setError(`Gallery already has the maximum of ${MAX_IMAGES} images.`)
      return
    }

    const filesToUpload = incomingFiles.slice(0, remainingSlots)

    if (incomingFiles.length > remainingSlots) {
      setMessage(`Only ${remainingSlots} image(s) were added because the gallery limit is ${MAX_IMAGES}.`)
    }

    setIsUploading(true)

    try {
      const uploadedDocs: MediaDoc[] = []

      for (const file of filesToUpload) {
        const uploadedDoc = await uploadSingleFile(file)
        uploadedDocs.push(uploadedDoc)
      }

      setMediaById((prev) => {
        const next = { ...prev }
        for (const doc of uploadedDocs) next[doc.id] = doc
        return next
      })

      updateGallery([
        ...galleryItems,
        ...uploadedDocs.map((doc) => ({
          image: doc.id,
        })),
      ])

      setMessage(`${uploadedDocs.length} image(s) uploaded. Save the boat to keep the gallery changes.`)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Gallery upload failed.')
    } finally {
      setIsUploading(false)

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const removeImage = (index: number) => {
    updateGallery(galleryItems.filter((_, itemIndex) => itemIndex !== index))
    setMessage('Image removed. Save the boat to keep the gallery changes.')
  }

  const moveImageUp = (index: number) => {
    if (index === 0) return
    updateGallery(moveItem(galleryItems, index, index - 1))
    setMessage('Gallery order changed. Save the boat to keep the new order.')
  }

  const moveImageDown = (index: number) => {
    if (index >= galleryItems.length - 1) return
    updateGallery(moveItem(galleryItems, index, index + 1))
    setMessage('Gallery order changed. Save the boat to keep the new order.')
  }

  return (
    <div style={styles.fieldWrap}>
      <label style={styles.label}>{label || 'Gallery'}</label>

      <p style={styles.helpText}>
        Upload up to {MAX_IMAGES} images. Drag files into the box below, or choose images from your computer.
        After upload, drag thumbnails to arrange the order.
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setIsDraggingOver(false)

          if (event.dataTransfer.files?.length) {
            handleFiles(event.dataTransfer.files)
          }
        }}
        style={{
          ...styles.dropzoneBase,
          borderColor: isDraggingOver ? 'var(--theme-success-500)' : 'var(--theme-elevation-400)',
          background: isDraggingOver ? 'var(--theme-elevation-100)' : 'var(--theme-elevation-50)',
        }}
      >
        <p style={{ margin: '0 0 8px', fontWeight: 700 }}>
          Drop gallery images here
        </p>

        <p style={styles.helpText}>
          Current gallery: {galleryItems.length}/{MAX_IMAGES}. Each image is uploaded to Media first.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={isUploading || galleryItems.length >= MAX_IMAGES}
          onChange={(event) => {
            if (event.target.files?.length) {
              handleFiles(event.target.files)
            }
          }}
          style={{ display: 'none' }}
        />

        <button
          type="button"
          disabled={isUploading || galleryItems.length >= MAX_IMAGES}
          onClick={() => fileInputRef.current?.click()}
          style={{
            ...styles.chooseButton,
            opacity: isUploading || galleryItems.length >= MAX_IMAGES ? 0.55 : 1,
            cursor: isUploading || galleryItems.length >= MAX_IMAGES ? 'not-allowed' : 'pointer',
          }}
        >
          {isUploading ? 'Uploading...' : 'Choose images'}
        </button>

        {message && (
          <p style={{ margin: '12px 0 0', color: 'var(--theme-success-500)', fontSize: 13 }}>
            {message}
          </p>
        )}

        {error && (
          <p style={{ margin: '12px 0 0', color: 'var(--theme-error-500)', fontSize: 13 }}>
            {error}
          </p>
        )}
      </div>

      {galleryItems.length > 0 && (
        <>
          <p style={styles.helpText}>
            Drag thumbnails to reorder. You can also use Up / Down.
          </p>

          <div style={styles.grid}>
            {galleryItems.map((item, index) => {
              const mediaId = getImageId(item)
              const populatedMedia = typeof item.image === 'object' ? item.image : null
              const media = populatedMedia || (mediaId ? mediaById[mediaId] : null)
              const imageUrl = getMediaUrl(media)

              return (
                <div
                  key={`${mediaId || 'gallery'}-${index}`}
                  draggable
                  onDragStart={() => {
                    draggedIndexRef.current = index
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                  }}
                  onDrop={(event) => {
                    event.preventDefault()

                    const fromIndex = draggedIndexRef.current
                    draggedIndexRef.current = null

                    if (fromIndex === null || fromIndex === index) return

                    updateGallery(moveItem(galleryItems, fromIndex, index))
                    setMessage('Gallery order changed. Save the boat to keep the new order.')
                  }}
                  style={styles.card}
                  title="Drag to reorder"
                >
                  <div style={styles.thumb}>
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={media?.alt || `Gallery image ${index + 1}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    ) : (
                      <span style={{ color: 'var(--theme-elevation-500)', fontSize: 12 }}>
                        Loading preview...
                      </span>
                    )}
                  </div>

                  <div style={{ padding: 10 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        marginBottom: 8,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={media?.alt || media?.filename || mediaId || ''}
                    >
                      {index + 1}. {media?.alt || media?.filename || mediaId || 'Gallery image'}
                    </div>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => moveImageUp(index)}
                        disabled={index === 0}
                        style={{
                          ...styles.cardButton,
                          opacity: index === 0 ? 0.5 : 1,
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Up
                      </button>

                      <button
                        type="button"
                        onClick={() => moveImageDown(index)}
                        disabled={index === galleryItems.length - 1}
                        style={{
                          ...styles.cardButton,
                          opacity: index === galleryItems.length - 1 ? 0.5 : 1,
                          cursor: index === galleryItems.length - 1 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Down
                      </button>

                      <button
                        type="button"
                        onClick={() => removeImage(index)}
                        style={{
                          ...styles.cardButton,
                          color: 'var(--theme-error-500)',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export default BoatGalleryField

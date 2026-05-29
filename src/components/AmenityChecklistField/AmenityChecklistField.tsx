'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useField } from '@payloadcms/ui'

type Amenity = {
  id: string
  name: string
  category?: string
  sortOrder?: number
  isActive?: boolean
}

const categoryLabel = (value?: string) => {
  switch (value) {
    case 'comfort':
      return 'Comfort'
    case 'entertainment':
      return 'Entertainment'
    case 'food_drink':
      return 'Food & Drink'
    case 'safety':
      return 'Safety'
    case 'water_sports':
      return 'Water Sports'
    default:
      return 'Other'
  }
}

const toId = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return String((value as { id?: string }).id || '')
  }
  return String(value)
}

export function AmenityChecklistField({ path, label }: any) {
  const { value, setValue } = useField<Array<string | Amenity>>({ path })
  const selectedIds = useMemo(() => {
    return new Set((Array.isArray(value) ? value : []).map(toId).filter(Boolean))
  }, [value])

  const [amenities, setAmenities] = useState<Amenity[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    async function loadAmenities() {
      try {
        const response = await fetch('/api/amenities?limit=500&sort=sortOrder,name&where[isActive][equals]=true', {
          credentials: 'include',
        })

        if (!response.ok) throw new Error('Could not load amenities.')

        const json = await response.json()
        if (!cancelled) setAmenities(json?.docs || [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load amenities.')
      }
    }

    loadAmenities()

    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (id: string) => {
    const current = Array.from(selectedIds)
    const next = selectedIds.has(id) ? current.filter((item) => item !== id) : [...current, id]
    setValue(next)
  }

  const grouped = amenities.reduce<Record<string, Amenity[]>>((acc, amenity) => {
    const key = amenity.category || 'other'
    acc[key] = acc[key] || []
    acc[key].push(amenity)
    return acc
  }, {})

  return (
    <div style={{ marginBottom: 28 }}>
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 8 }}>
        {label || 'Amenities'}
      </label>
      <p style={{ margin: '0 0 12px', color: 'var(--theme-elevation-500)', fontSize: 13 }}>
        Select from the global amenities list. Manage the master list in the Amenities collection.
      </p>

      {error ? (
        <p style={{ color: 'var(--theme-error-500)', fontSize: 13 }}>{error}</p>
      ) : null}

      {Object.entries(grouped).map(([category, items]) => (
        <fieldset
          key={category}
          style={{
            border: '1px solid var(--theme-elevation-150)',
            borderRadius: 8,
            margin: '0 0 12px',
            padding: 12,
          }}
        >
          <legend style={{ fontWeight: 700, padding: '0 6px' }}>{categoryLabel(category)}</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {items.map((amenity) => (
              <label key={amenity.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(amenity.id)}
                  onChange={() => toggle(amenity.id)}
                />
                <span>{amenity.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      {!error && amenities.length === 0 ? (
        <p style={{ color: 'var(--theme-elevation-500)', fontSize: 13 }}>
          No active amenities yet. Add amenities in the Amenities collection first.
        </p>
      ) : null}
    </div>
  )
}

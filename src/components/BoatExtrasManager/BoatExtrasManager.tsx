'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

type RelationshipValue = string | { id?: string } | null | undefined

type ExtraDoc = {
  id: string
  name?: string
  category?: string
  unitPrice?: number
  boat?: RelationshipValue[]
}

const CATEGORY_OPTIONS = [
  { label: 'All categories', value: 'all' },
  { label: 'Watersports', value: 'watersports' },
  { label: 'Catering', value: 'catering' },
  { label: 'Entertainment', value: 'entertainment' },
  { label: 'Decor', value: 'decor' },
]

const getBoatIdFromAdminUrl = (): string | null => {
  if (typeof window === 'undefined') return null

  const match = window.location.pathname.match(/\/admin\/collections\/boats\/([^/?#]+)/)
  const boatId = match?.[1]

  if (!boatId || boatId === 'create') return null

  return decodeURIComponent(boatId)
}

const getRelationshipIds = (value: RelationshipValue[] | undefined): string[] => {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      if (!item) return null
      if (typeof item === 'string') return item
      return item.id || null
    })
    .filter(Boolean) as string[]
}

const formatCategory = (category?: string): string => {
  if (!category) return 'Uncategorised'

  return category
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const styles = {
  wrap: {
    marginBottom: 28,
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 8,
    background: 'var(--theme-elevation-50)',
    color: 'var(--theme-text)',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    padding: 18,
    borderBottom: '1px solid var(--theme-elevation-150)',
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
  } as React.CSSProperties,
  help: {
    margin: '8px 0 0',
    color: 'var(--theme-elevation-500)',
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,
  controls: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 1fr) minmax(180px, 260px)',
    gap: 12,
    padding: 18,
    borderBottom: '1px solid var(--theme-elevation-150)',
  } as React.CSSProperties,
  input: {
    width: '100%',
    border: '1px solid var(--theme-elevation-200)',
    borderRadius: 6,
    background: 'var(--theme-input-bg)',
    color: 'var(--theme-text)',
    padding: '10px 12px',
    fontSize: 14,
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    padding: '0 18px 18px',
    borderBottom: '1px solid var(--theme-elevation-150)',
  } as React.CSSProperties,
  button: {
    border: '1px solid var(--theme-elevation-250)',
    borderRadius: 6,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-text)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  primaryButton: {
    border: '1px solid var(--theme-success-500)',
    borderRadius: 6,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-success-500)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  dangerButton: {
    border: '1px solid var(--theme-error-500)',
    borderRadius: 6,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-error-500)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  list: {
    display: 'grid',
    gridTemplateColumns: '1fr',
  } as React.CSSProperties,
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 1fr) 140px 110px 110px',
    gap: 12,
    alignItems: 'center',
    padding: '12px 18px',
    borderBottom: '1px solid var(--theme-elevation-100)',
  } as React.CSSProperties,
  rowMuted: {
    color: 'var(--theme-elevation-500)',
    fontSize: 13,
  } as React.CSSProperties,
  badge: {
    display: 'inline-flex',
    width: 'fit-content',
    border: '1px solid var(--theme-elevation-200)',
    borderRadius: 999,
    padding: '3px 8px',
    fontSize: 12,
    color: 'var(--theme-elevation-700)',
    background: 'var(--theme-elevation-100)',
  } as React.CSSProperties,
  message: {
    padding: '12px 18px',
    fontSize: 13,
    color: 'var(--theme-success-500)',
  } as React.CSSProperties,
  error: {
    padding: '12px 18px',
    fontSize: 13,
    color: 'var(--theme-error-500)',
  } as React.CSSProperties,
}

export function BoatExtrasManager() {
  const [boatId, setBoatId] = useState<string | null>(null)
  const [extras, setExtras] = useState<ExtraDoc[]>([])
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [isBulkSaving, setIsBulkSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setBoatId(getBoatIdFromAdminUrl())
  }, [])

  const fetchExtras = useCallback(async () => {
    setIsLoading(true)
    setError('')

    try {
      const allExtras: ExtraDoc[] = []
      let page = 1
      let hasNextPage = true

      while (hasNextPage) {
        const response = await fetch(
          `/api/extras?limit=100&page=${page}&depth=0&sort=category,name`,
          {
            credentials: 'include',
          },
        )

        if (!response.ok) {
          throw new Error('Could not load extras.')
        }

        const json = await response.json()

        allExtras.push(...(json.docs || []))
        hasNextPage = Boolean(json.hasNextPage)
        page = Number(json.nextPage || page + 1)

        if (page > 20) {
          // Safety guard: prevents accidental infinite loops.
          hasNextPage = false
        }
      }

      setExtras(allExtras)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load extras.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchExtras()
  }, [fetchExtras])

  const filteredExtras = useMemo(() => {
    const normalisedSearch = search.trim().toLowerCase()

    return extras.filter((extra) => {
      const matchesCategory = category === 'all' || extra.category === category

      const matchesSearch =
        !normalisedSearch ||
        extra.name?.toLowerCase().includes(normalisedSearch) ||
        extra.category?.toLowerCase().includes(normalisedSearch)

      return matchesCategory && matchesSearch
    })
  }, [category, extras, search])

  const selectedCount = useMemo(() => {
    if (!boatId) return 0

    return extras.filter((extra) => getRelationshipIds(extra.boat).includes(boatId)).length
  }, [boatId, extras])

  const filteredSelectedCount = useMemo(() => {
    if (!boatId) return 0

    return filteredExtras.filter((extra) => getRelationshipIds(extra.boat).includes(boatId)).length
  }, [boatId, filteredExtras])

  const patchExtraBoatIds = async (extra: ExtraDoc, nextBoatIds: string[]) => {
    const response = await fetch(`/api/extras/${extra.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        boat: nextBoatIds,
      }),
    })

    const json = await response.json().catch(() => null)

    if (!response.ok) {
      const responseMessage =
        json?.errors?.[0]?.message ||
        json?.message ||
        `Could not update ${extra.name || 'extra'}`

      throw new Error(responseMessage)
    }

    const doc = json?.doc || json

    setExtras((previousExtras) =>
      previousExtras.map((item) =>
        item.id === extra.id
          ? {
              ...item,
              boat: doc?.boat || nextBoatIds,
            }
          : item,
      ),
    )
  }

  const addExtraToBoat = async (extra: ExtraDoc) => {
    if (!boatId) return

    setMessage('')
    setError('')
    setSavingId(extra.id)

    try {
      const currentBoatIds = getRelationshipIds(extra.boat)
      const nextBoatIds = Array.from(new Set([...currentBoatIds, boatId]))

      await patchExtraBoatIds(extra, nextBoatIds)
      setMessage(`${extra.name || 'Extra'} added to this boat.`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not add extra.')
    } finally {
      setSavingId(null)
    }
  }

  const removeExtraFromBoat = async (extra: ExtraDoc) => {
    if (!boatId) return

    setMessage('')
    setError('')
    setSavingId(extra.id)

    try {
      const currentBoatIds = getRelationshipIds(extra.boat)
      const nextBoatIds = currentBoatIds.filter((id) => id !== boatId)

      await patchExtraBoatIds(extra, nextBoatIds)
      setMessage(`${extra.name || 'Extra'} removed from this boat.`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not remove extra.')
    } finally {
      setSavingId(null)
    }
  }

  const addAllFiltered = async () => {
    if (!boatId) return

    const extrasToAdd = filteredExtras.filter(
      (extra) => !getRelationshipIds(extra.boat).includes(boatId),
    )

    if (extrasToAdd.length === 0) {
      setMessage('All filtered extras are already assigned to this boat.')
      return
    }

    setMessage('')
    setError('')
    setIsBulkSaving(true)

    try {
      for (const extra of extrasToAdd) {
        const currentBoatIds = getRelationshipIds(extra.boat)
        const nextBoatIds = Array.from(new Set([...currentBoatIds, boatId]))

        await patchExtraBoatIds(extra, nextBoatIds)
      }

      setMessage(`${extrasToAdd.length} filtered extra(s) added to this boat.`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not bulk add extras.')
    } finally {
      setIsBulkSaving(false)
    }
  }

  const removeAllFiltered = async () => {
    if (!boatId) return

    const extrasToRemove = filteredExtras.filter((extra) =>
      getRelationshipIds(extra.boat).includes(boatId),
    )

    if (extrasToRemove.length === 0) {
      setMessage('No filtered extras are assigned to this boat.')
      return
    }

    setMessage('')
    setError('')
    setIsBulkSaving(true)

    try {
      let removed = 0
      let skipped = 0

      for (const extra of extrasToRemove) {
        const currentBoatIds = getRelationshipIds(extra.boat)
        const nextBoatIds = currentBoatIds.filter((id) => id !== boatId)

        if (nextBoatIds.length === 0) {
          skipped += 1
          continue
        }

        await patchExtraBoatIds(extra, nextBoatIds)
        removed += 1
      }

      setMessage(
        `${removed} filtered extra(s) removed from this boat.${
          skipped ? ` ${skipped} skipped because each extra must remain assigned to at least one boat.` : ''
        }`,
      )
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not bulk remove extras.')
    } finally {
      setIsBulkSaving(false)
    }
  }

  if (!boatId) {
    return (
      <div style={styles.wrap}>
        <div style={styles.header}>
          <h3 style={styles.title}>Boat Extras</h3>
          <p style={styles.help}>
            Save this boat first, then reopen it to assign extras from the boat screen.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <h3 style={styles.title}>Boat Extras</h3>
        <p style={styles.help}>
          Assign existing extras to this boat without leaving the boat edit screen. Filter by category,
          search by name, then add or remove extras in bulk.
        </p>
        <p style={styles.help}>
          Assigned extras: {selectedCount} | Showing: {filteredExtras.length} | Assigned in current filter:{' '}
          {filteredSelectedCount}
        </p>
      </div>

      <div style={styles.controls}>
        <input
          type="search"
          placeholder="Search extras by name..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={styles.input}
        />

        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          style={styles.input}
        >
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          onClick={fetchExtras}
          disabled={isLoading || isBulkSaving}
          style={{
            ...styles.button,
            opacity: isLoading || isBulkSaving ? 0.6 : 1,
            cursor: isLoading || isBulkSaving ? 'not-allowed' : 'pointer',
          }}
        >
          Refresh extras
        </button>

        <button
          type="button"
          onClick={addAllFiltered}
          disabled={isLoading || isBulkSaving || filteredExtras.length === 0}
          style={{
            ...styles.primaryButton,
            opacity: isLoading || isBulkSaving || filteredExtras.length === 0 ? 0.6 : 1,
            cursor:
              isLoading || isBulkSaving || filteredExtras.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {isBulkSaving ? 'Saving...' : 'Add all filtered'}
        </button>

        <button
          type="button"
          onClick={removeAllFiltered}
          disabled={isLoading || isBulkSaving || filteredSelectedCount === 0}
          style={{
            ...styles.dangerButton,
            opacity: isLoading || isBulkSaving || filteredSelectedCount === 0 ? 0.6 : 1,
            cursor:
              isLoading || isBulkSaving || filteredSelectedCount === 0
                ? 'not-allowed'
                : 'pointer',
          }}
        >
          Remove all filtered assigned
        </button>
      </div>

      {message && <div style={styles.message}>{message}</div>}
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.list}>
        {isLoading && (
          <div style={{ padding: 18, color: 'var(--theme-elevation-500)' }}>
            Loading extras...
          </div>
        )}

        {!isLoading && filteredExtras.length === 0 && (
          <div style={{ padding: 18, color: 'var(--theme-elevation-500)' }}>
            No extras found for the current filter.
          </div>
        )}

        {!isLoading &&
          filteredExtras.map((extra) => {
            const isAssigned = Boolean(boatId && getRelationshipIds(extra.boat).includes(boatId))
            const isSaving = savingId === extra.id || isBulkSaving

            return (
              <div key={extra.id} style={styles.row}>
                <div>
                  <div style={{ fontWeight: 700 }}>{extra.name || 'Untitled extra'}</div>
                  <div style={styles.rowMuted}>ID: {extra.id}</div>
                </div>

                <div>
                  <span style={styles.badge}>{formatCategory(extra.category)}</span>
                </div>

                <div style={styles.rowMuted}>
                  {typeof extra.unitPrice === 'number' ? `AED ${extra.unitPrice}` : 'No price'}
                </div>

                <div>
                  {isAssigned ? (
                    <button
                      type="button"
                      onClick={() => removeExtraFromBoat(extra)}
                      disabled={isSaving}
                      style={{
                        ...styles.dangerButton,
                        opacity: isSaving ? 0.6 : 1,
                        cursor: isSaving ? 'not-allowed' : 'pointer',
                        width: '100%',
                      }}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => addExtraToBoat(extra)}
                      disabled={isSaving}
                      style={{
                        ...styles.primaryButton,
                        opacity: isSaving ? 0.6 : 1,
                        cursor: isSaving ? 'not-allowed' : 'pointer',
                        width: '100%',
                      }}
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}

export default BoatExtrasManager

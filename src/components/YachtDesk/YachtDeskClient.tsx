'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

type Option = {
  id: string
  name: string
}

type Amenity = Option & {
  category?: string
  sortOrder?: number
}

type MediaItem = {
  id: string
  url?: string
  alt?: string
}

type GalleryItem = {
  imageId: string
  image?: MediaItem | null
  isFeatured?: boolean
}

type YachtRow = {
  id: string
  name: string
  slug?: string
  archived: boolean
  ownerId?: string
  ownerName: string
  locationId?: string
  locationName: string
  price: number
  salePrice?: number
  priceDay: number
  minHours: number
  type: string
  manufacture?: string
  refit?: string
  length?: string
  capacity: number
  sleeps?: string
  bathrooms?: string
  crew?: number
  description?: string
  globalAmenities: string[]
  routes: string[]
  keyFeatures: Array<{ feature: string; included?: boolean }>
  boatSpecific: Array<{ faq: string }>
  media?: MediaItem | null
  mediaId?: string
  gallery: GalleryItem[]
  adminUrl: string
  frontendUrl?: string
}

const emptyForm = {
  id: '',
  name: '',
  slug: '',
  archived: true,
  ownerId: '',
  locationId: '',
  price: 0,
  salePrice: 0,
  priceDay: 0,
  minHours: 1,
  type: 'Yacht',
  manufacture: '',
  refit: '',
  length: '',
  capacity: 1,
  sleeps: '0',
  bathrooms: '0',
  crew: 0,
  description: '',
  globalAmenities: [] as string[],
  routes: [] as string[],
  keyFeatures: [] as Array<{ feature: string; included?: boolean }>,
  boatSpecific: [] as Array<{ faq: string }>,
  gallery: [] as GalleryItem[],
}

const formatAED = (value: number) =>
  Number(value || 0).toLocaleString('en-AE', {
    style: 'currency',
    currency: 'AED',
    maximumFractionDigits: 0,
  })

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

export default function YachtDeskClient() {
  const [view, setView] = useState<'list' | 'form'>('list')
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(emptyForm)
  const [yachts, setYachts] = useState<YachtRow[]>([])
  const [owners, setOwners] = useState<Option[]>([])
  const [locations, setLocations] = useState<Option[]>([])
  const [amenities, setAmenities] = useState<Amenity[]>([])
  const [routes, setRoutes] = useState<Option[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived' | 'missingImages' | 'missingPrice' | 'missingOwner'>('all')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const update = (key: keyof typeof emptyForm, value: any) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const resetForm = () => {
    setForm(emptyForm)
    setStep(0)
    setError('')
    setMessage('')
    setView('form')
  }

  const loadOptions = async () => {
    const response = await fetch('/api/yacht-desk/options', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not load Yacht Desk options.')

    setOwners(data.owners || [])
    setLocations(data.locations || [])
    setAmenities(data.amenities || [])
    setRoutes(data.routes || [])
  }

  const loadYachts = async () => {
    const response = await fetch('/api/yacht-desk/boats', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not load yachts.')

    setYachts(data.boats || [])
  }

  useEffect(() => {
    Promise.all([loadOptions(), loadYachts()]).catch((err) =>
      setError(err instanceof Error ? err.message : 'Could not load Yacht Desk.'),
    )
  }, [])

  const filteredYachts = useMemo(() => {
    const query = search.trim().toLowerCase()

    return yachts.filter((yacht) => {
      const matchesSearch =
        !query ||
        [yacht.name, yacht.ownerName, yacht.locationName, yacht.slug]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query)

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && !yacht.archived) ||
        (statusFilter === 'archived' && yacht.archived) ||
        (statusFilter === 'missingImages' && yacht.gallery.length === 0) ||
        (statusFilter === 'missingPrice' && yacht.price <= 0) ||
        (statusFilter === 'missingOwner' && !yacht.ownerId)

      return matchesSearch && matchesStatus
    })
  }, [yachts, search, statusFilter])

  const stats = useMemo(
    () => ({
      active: yachts.filter((yacht) => !yacht.archived).length,
      archived: yachts.filter((yacht) => yacht.archived).length,
      missingImages: yachts.filter((yacht) => yacht.gallery.length === 0).length,
      missingOwner: yachts.filter((yacht) => !yacht.ownerId).length,
    }),
    [yachts],
  )

  const editYacht = async (yacht: YachtRow) => {
    setError('')
    setMessage('')

    const response = await fetch(`/api/yacht-desk/${yacht.id}`, { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) {
      setError(data?.message || 'Could not load yacht.')
      return
    }

    const boat = data.boat as YachtRow

    setForm({
      ...emptyForm,
      id: boat.id,
      name: boat.name || '',
      slug: boat.slug || '',
      archived: Boolean(boat.archived),
      ownerId: boat.ownerId || '',
      locationId: boat.locationId || '',
      price: boat.price || 0,
      salePrice: boat.salePrice || 0,
      priceDay: boat.priceDay || 0,
      minHours: boat.minHours || 1,
      type: boat.type || 'Yacht',
      manufacture: boat.manufacture || '',
      refit: boat.refit || '',
      length: boat.length || '',
      capacity: boat.capacity || 1,
      sleeps: boat.sleeps || '0',
      bathrooms: boat.bathrooms || '0',
      crew: boat.crew || 0,
      description: boat.description || '',
      globalAmenities: boat.globalAmenities || [],
      routes: boat.routes || [],
      keyFeatures: boat.keyFeatures || [],
      boatSpecific: boat.boatSpecific || [],
      gallery: boat.gallery || [],
    })

    setStep(0)
    setView('form')
  }

  const toggleId = (key: 'globalAmenities' | 'routes', id: string) => {
    setForm((current) => {
      const values = current[key]
      const next = values.includes(id) ? values.filter((item) => item !== id) : [...values, id]
      return { ...current, [key]: next }
    })
  }

  const setFeatured = (imageId: string) => {
    update(
      'gallery',
      form.gallery.map((item) => ({
        ...item,
        isFeatured: item.imageId === imageId,
      })),
    )
  }

  const removeImage = (imageId: string) => {
    const next = form.gallery.filter((item) => item.imageId !== imageId)
    if (next.length && !next.some((item) => item.isFeatured)) {
      next[0].isFeatured = true
    }
    update('gallery', next)
  }

  const moveImage = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= form.gallery.length) return

    const next = [...form.gallery]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    update('gallery', next)
  }

  const uploadImages = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    setError('')

    try {
      const uploaded: GalleryItem[] = []

      for (const file of Array.from(files).filter((item) => item.type.startsWith('image/'))) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('alt', file.name.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' '))

        const response = await fetch('/api/media', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })

        const data = await response.json()
        if (!response.ok) throw new Error(data?.message || `Could not upload ${file.name}`)

        const doc = data?.doc || data
        uploaded.push({
          imageId: doc.id,
          image: {
            id: doc.id,
            url: doc.blobUrl || doc.url || doc.thumbnailURL || '',
            alt: doc.alt || doc.filename || file.name,
          },
          isFeatured: form.gallery.length === 0 && uploaded.length === 0,
        })
      }

      update('gallery', [...form.gallery, ...uploaded])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload images.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const validateStep = (targetStep: number) => {
    setError('')

    if (step === 0) {
      if (!form.name.trim()) return setError('Yacht name is required.')
      if (!form.ownerId) return setError('Supplier is required.')
      if (!form.locationId) return setError('Location is required.')
    }

    if (step === 1) {
      if (form.price <= 0) return setError('Price per hour is required.')
      if (form.priceDay <= 0) return setError('Price per day is required.')
      if (form.minHours <= 0) return setError('Minimum hours is required.')
    }

    if (step === 2) {
      if (!form.type) return setError('Yacht type is required.')
      if (!form.length.trim()) return setError('Length is required.')
      if (form.capacity <= 0) return setError('Capacity is required.')
    }

    setStep(targetStep)
  }

  const saveYacht = async () => {
    setSaving(true)
    setError('')
    setMessage('')

    try {
      const endpoint = form.id ? `/api/yacht-desk/${form.id}` : '/api/yacht-desk/create'
      const response = await fetch(endpoint, {
        method: form.id ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data?.message || 'Could not save yacht.')

      setMessage(form.id ? 'Yacht updated.' : 'Yacht created.')
      await loadYachts()
      setView('list')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save yacht.')
    } finally {
      setSaving(false)
    }
  }

  const groupedAmenities = amenities.reduce<Record<string, Amenity[]>>((acc, amenity) => {
    const key = amenity.category || 'other'
    acc[key] = acc[key] || []
    acc[key].push(amenity)
    return acc
  }, {})

  return (
    <main className="btb-yacht-desk">
      <section className="btb-yacht-desk__hero">
        <div>
          <p>Operations</p>
          <h1>Yacht Desk</h1>
          <span>Create and edit yachts with a mobile-friendly workflow.</span>
        </div>
        <div className="btb-yacht-desk__hero-actions">
          <a href="/admin">Back to Admin</a>
          <a href="/admin/reservation-desk">Reservation Desk</a>
          <button type="button" onClick={resetForm}>Create New Yacht</button>
        </div>
      </section>

      {error ? <div className="btb-yacht-desk__alert is-error">{error}</div> : null}
      {message ? <div className="btb-yacht-desk__alert is-success">{message}</div> : null}

      {view === 'list' ? (
        <section className="btb-yacht-desk__list-shell">
          <div className="btb-yacht-desk__toolbar">
            <div>
              <h2>Yachts</h2>
              <p>{filteredYachts.length} of {yachts.length} yachts</p>
            </div>
            <div className="btb-yacht-desk__filters">
              <label>
                <span>Search</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Yacht, supplier, location or slug" />
              </label>
              <label>
                <span>Filter</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as any)}>
                  <option value="all">All yachts</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="missingImages">Missing images</option>
                  <option value="missingPrice">Missing price</option>
                  <option value="missingOwner">Missing supplier</option>
                </select>
              </label>
            </div>
          </div>

          <div className="btb-yacht-desk__dashboard">
            <div className="btb-yacht-desk__cards">
              {filteredYachts.map((yacht) => (
                <article className="btb-yacht-desk__card" key={yacht.id}>
                  <div className="btb-yacht-desk__image">
                    {yacht.media?.url ? <img src={yacht.media.url} alt={yacht.media.alt || yacht.name} /> : <span>No image</span>}
                  </div>
                  <div className="btb-yacht-desk__card-main">
                    <div>
                      <span className="btb-yacht-desk__eyebrow">{yacht.ownerName}</span>
                      <h3>{yacht.name}</h3>
                      <p>{yacht.locationName} - {yacht.capacity} guests - {formatAED(yacht.price)}/h</p>
                    </div>
                    <span className={`btb-yacht-desk__status ${yacht.archived ? 'is-archived' : 'is-active'}`}>
                      {yacht.archived ? 'Archived' : 'Active'}
                    </span>
                  </div>
                  <div className="btb-yacht-desk__actions">
                    <button type="button" onClick={() => editYacht(yacht)}>Edit</button>
                    {yacht.frontendUrl ? <a href={yacht.frontendUrl} target="_blank" rel="noreferrer">Preview</a> : null}
                    <a href={yacht.adminUrl}>Advanced</a>
                  </div>
                </article>
              ))}
            </div>

            <aside className="btb-yacht-desk__summary">
              <div><span>Active</span><strong>{stats.active}</strong></div>
              <div><span>Archived</span><strong>{stats.archived}</strong></div>
              <div><span>Missing Images</span><strong>{stats.missingImages}</strong></div>
              <div><span>Missing Supplier</span><strong>{stats.missingOwner}</strong></div>
            </aside>
          </div>
        </section>
      ) : (
        <>
          <nav className="btb-yacht-desk__steps">
            {['Basics', 'Pricing', 'Specs', 'Media', 'Amenities', 'Details', 'Review'].map((label, index) => (
              <button key={label} type="button" className={step === index ? 'is-active' : ''} onClick={() => setStep(index)}>
                {index + 1}. {label}
              </button>
            ))}
          </nav>

          <div className="btb-yacht-desk__layout">
            <section className="btb-yacht-desk__panel">
              {step === 0 ? (
                <div className="btb-yacht-desk__form">
                  <h2>Basics</h2>
                  <label>Yacht name<input value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
                  <label>Supplier
                    <select value={form.ownerId} onChange={(event) => update('ownerId', event.target.value)}>
                      <option value="">Select supplier</option>
                      {owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
                    </select>
                  </label>
                  <label>Location
                    <select value={form.locationId} onChange={(event) => update('locationId', event.target.value)}>
                      <option value="">Select location</option>
                      {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </label>
                  <label>Slug<input value={form.slug} onChange={(event) => update('slug', event.target.value)} placeholder="Auto-generated if blank" /></label>
                  <label className="btb-yacht-desk__toggle"><input type="checkbox" checked={!form.archived} onChange={(event) => update('archived', !event.target.checked)} /> Published / active</label>
                  <button type="button" onClick={() => validateStep(1)}>Continue</button>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="btb-yacht-desk__form">
                  <h2>Pricing & Rules</h2>
                  <label>Price per hour<input type="number" value={form.price} onChange={(event) => update('price', Number(event.target.value))} /></label>
                  <label>Sale price<input type="number" value={form.salePrice} onChange={(event) => update('salePrice', Number(event.target.value))} /></label>
                  <label>Price per day<input type="number" value={form.priceDay} onChange={(event) => update('priceDay', Number(event.target.value))} /></label>
                  <label>Minimum hours<input type="number" value={form.minHours} onChange={(event) => update('minHours', Number(event.target.value))} /></label>
                  <button type="button" onClick={() => validateStep(2)}>Continue</button>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="btb-yacht-desk__form">
                  <h2>Specifications</h2>
                  <label>Type
                    <select value={form.type} onChange={(event) => update('type', event.target.value)}>
                      {['Yacht', 'Sailboat', 'Speedboat', 'Pontoon', 'Catamaran', 'Luxury Yachts', 'Other'].map((type) => <option key={type} value={type}>{type}</option>)}
                    </select>
                  </label>
                  <label>Year of manufacture<input value={form.manufacture} onChange={(event) => update('manufacture', event.target.value)} /></label>
                  <label>Year of refit<input value={form.refit} onChange={(event) => update('refit', event.target.value)} /></label>
                  <label>Length<input value={form.length} onChange={(event) => update('length', event.target.value)} /></label>
                  <label>Capacity<input type="number" value={form.capacity} onChange={(event) => update('capacity', Number(event.target.value))} /></label>
                  <label>Sleeps<input value={form.sleeps} onChange={(event) => update('sleeps', event.target.value)} /></label>
                  <label>Bathrooms<input value={form.bathrooms} onChange={(event) => update('bathrooms', event.target.value)} /></label>
                  <label>Crew<input type="number" value={form.crew} onChange={(event) => update('crew', Number(event.target.value))} /></label>
                  <button type="button" onClick={() => validateStep(3)}>Continue</button>
                </div>
              ) : null}

              {step === 3 ? (
                <div>
                  <h2>Media</h2>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(event) => uploadImages(event.target.files)} />
                  <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? 'Uploading...' : 'Upload Images'}</button>
                  <div className="btb-yacht-desk__gallery">
                    {form.gallery.map((item, index) => (
                      <article key={`${item.imageId}-${index}`}>
                        <div>{item.image?.url ? <img src={item.image.url} alt={item.image.alt || ''} /> : <span>No preview</span>}</div>
                        {item.isFeatured ? <strong>Featured image</strong> : null}
                        <button type="button" onClick={() => setFeatured(item.imageId)} disabled={item.isFeatured}>Set featured</button>
                        <button type="button" onClick={() => moveImage(index, -1)} disabled={index === 0}>Up</button>
                        <button type="button" onClick={() => moveImage(index, 1)} disabled={index === form.gallery.length - 1}>Down</button>
                        <button type="button" onClick={() => removeImage(item.imageId)}>Remove</button>
                      </article>
                    ))}
                  </div>
                  <button type="button" onClick={() => setStep(4)}>Continue</button>
                </div>
              ) : null}

              {step === 4 ? (
                <div>
                  <h2>Amenities & Routes</h2>
                  {Object.entries(groupedAmenities).map(([category, rows]) => (
                    <fieldset className="btb-yacht-desk__fieldset" key={category}>
                      <legend>{categoryLabel(category)}</legend>
                      {rows.map((amenity) => (
                        <label key={amenity.id} className="btb-yacht-desk__checkbox">
                          <input type="checkbox" checked={form.globalAmenities.includes(amenity.id)} onChange={() => toggleId('globalAmenities', amenity.id)} />
                          {amenity.name}
                        </label>
                      ))}
                    </fieldset>
                  ))}

                  <fieldset className="btb-yacht-desk__fieldset">
                    <legend>Routes</legend>
                    {routes.map((route) => (
                      <label key={route.id} className="btb-yacht-desk__checkbox">
                        <input type="checkbox" checked={form.routes.includes(route.id)} onChange={() => toggleId('routes', route.id)} />
                        {route.name}
                      </label>
                    ))}
                  </fieldset>
                  <button type="button" onClick={() => setStep(5)}>Continue</button>
                </div>
              ) : null}

              {step === 5 ? (
                <div className="btb-yacht-desk__form">
                  <h2>Description & Features</h2>
                  <label>Description<textarea value={form.description} onChange={(event) => update('description', event.target.value)} /></label>
                  <h3>Key features</h3>
                  {form.keyFeatures.map((row, index) => (
                    <div className="btb-yacht-desk__inline" key={index}>
                      <input value={row.feature} onChange={(event) => update('keyFeatures', form.keyFeatures.map((item, i) => i === index ? { ...item, feature: event.target.value } : item))} />
                      <button type="button" onClick={() => update('keyFeatures', form.keyFeatures.filter((_, i) => i !== index))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => update('keyFeatures', [...form.keyFeatures, { feature: '', included: true }])}>Add feature</button>

                  <h3>FAQs</h3>
                  {form.boatSpecific.map((row, index) => (
                    <div className="btb-yacht-desk__inline" key={index}>
                      <textarea value={row.faq} onChange={(event) => update('boatSpecific', form.boatSpecific.map((item, i) => i === index ? { ...item, faq: event.target.value } : item))} />
                      <button type="button" onClick={() => update('boatSpecific', form.boatSpecific.filter((_, i) => i !== index))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => update('boatSpecific', [...form.boatSpecific, { faq: '' }])}>Add FAQ</button>
                  <button type="button" onClick={() => setStep(6)}>Review</button>
                </div>
              ) : null}

              {step === 6 ? (
                <div>
                  <h2>Review</h2>
                  <div className="btb-yacht-desk__review">
                    <p><strong>Yacht:</strong> {form.name}</p>
                    <p><strong>Supplier:</strong> {owners.find((owner) => owner.id === form.ownerId)?.name || 'Not selected'}</p>
                    <p><strong>Location:</strong> {locations.find((location) => location.id === form.locationId)?.name || 'Not selected'}</p>
                    <p><strong>Price:</strong> {formatAED(form.price)}/h</p>
                    <p><strong>Status:</strong> {form.archived ? 'Archived' : 'Active'}</p>
                    <p><strong>Images:</strong> {form.gallery.length}</p>
                  </div>
                  <button type="button" disabled={saving} onClick={saveYacht}>{saving ? 'Saving...' : form.id ? 'Save Yacht' : 'Create Yacht'}</button>
                </div>
              ) : null}
            </section>

            <aside className="btb-yacht-desk__side">
              <h3>Yacht Summary</h3>
              <dl>
                <dt>Name</dt><dd>{form.name || 'Not entered'}</dd>
                <dt>Supplier</dt><dd>{owners.find((owner) => owner.id === form.ownerId)?.name || 'Not selected'}</dd>
                <dt>Location</dt><dd>{locations.find((location) => location.id === form.locationId)?.name || 'Not selected'}</dd>
                <dt>Price</dt><dd>{formatAED(form.price)}/h</dd>
                <dt>Status</dt><dd>{form.archived ? 'Archived' : 'Active'}</dd>
              </dl>
            </aside>
          </div>
        </>
      )}
    </main>
  )
}

import type { Endpoint } from 'payload'

const toId = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return String((value as { id?: unknown }).id || '')
  }
  return String(value)
}

const toNumber = (value: unknown, fallback = 0) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

const getRequestBody = async (req: any) => {
  if (typeof req.json === 'function') {
    return req.json().catch(() => ({}))
  }

  return req.body || {}
}

const getRelatedName = (value: any, fallback = '') => {
  if (!value) return fallback
  if (typeof value === 'string') return value
  return value.name || value.title || value.email || value.id || fallback
}

const getMediaUrl = (media: any) => {
  if (!media || typeof media === 'string') return ''
  return media.blobUrl || media.url || media.thumbnailURL || ''
}

const mapOption = (doc: any) => ({
  id: String(doc.id),
  name: doc.name || doc.title || doc.code || doc.email || String(doc.id),
})

const mapAmenity = (doc: any) => ({
  id: String(doc.id),
  name: doc.name || '',
  category: doc.category || 'other',
  sortOrder: toNumber(doc.sortOrder, 0),
})

const mapMedia = (media: any) => {
  if (!media) return null
  if (typeof media === 'string') return { id: media, url: '' }

  return {
    id: String(media.id),
    url: getMediaUrl(media),
    alt: media.alt || media.filename || '',
  }
}

const mapGallery = (gallery: any[] = []) =>
  gallery
    .map((item) => ({
      id: item.id,
      image: mapMedia(item.image),
      imageId: toId(item.image),
      isFeatured: Boolean(item.isFeatured),
    }))
    .filter((item) => item.imageId)

const mapBoat = (boat: any) => {
  const specs = boat.boatSpecifications || {}
  const owner = boat.owner && typeof boat.owner === 'object' ? boat.owner : null
  const location = boat.location && typeof boat.location === 'object' ? boat.location : null

  return {
    id: String(boat.id),
    name: boat.name || '',
    slug: boat.slug || '',
    archived: Boolean(boat.archived),
    ownerId: toId(boat.owner),
    ownerName: getRelatedName(owner, 'No supplier'),
    locationId: toId(boat.location),
    locationName: getRelatedName(location, 'No location'),
    price: toNumber(boat.price, 0),
    salePrice: toNumber(boat.salePrice, 0),
    priceDay: toNumber(boat.priceDay, 0),
    minHours: toNumber(boat.minHours, 1),
    type: specs.type || 'Yacht',
    manufacture: specs.manufacture || '',
    refit: specs.refit || '',
    length: specs.length || '',
    capacity: toNumber(specs.capacity, 0),
    sleeps: specs.sleeps || '',
    bathrooms: specs.bathrooms || '',
    crew: toNumber(specs.crew, 0),
    description: specs.description || '',
    globalAmenities: Array.isArray(boat.globalAmenities)
      ? boat.globalAmenities.map(toId).filter(Boolean)
      : [],
    routes: Array.isArray(boat.routes) ? boat.routes.map(toId).filter(Boolean) : [],
    keyFeatures: Array.isArray(boat.keyFeatures) ? boat.keyFeatures : [],
    boatSpecific: Array.isArray(boat.boatSpecific) ? boat.boatSpecific : [],
    media: mapMedia(boat.media),
    mediaId: toId(boat.media),
    gallery: mapGallery(boat.gallery || []),
    adminUrl: `/admin/collections/boats/${boat.id}`,
    frontendUrl: boat.slug ? `/service/${boat.slug}` : '',
  }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')

const buildLegacyAmenities = async ({ payload, amenityIds }: { payload: any; amenityIds: string[] }) => {
  const docs = await Promise.all(
    amenityIds.map(async (id) => {
      try {
        return await payload.findByID({
          collection: 'amenities',
          id,
          depth: 0,
          overrideAccess: true,
        })
      } catch {
        return null
      }
    }),
  )

  return docs.filter(Boolean).map((doc: any) => ({ item: doc.name })).filter((row: any) => row.item)
}

const getFeaturedImageId = (gallery: any[]) => {
  const featured = gallery.find((item) => item.isFeatured && item.image)
  return toId(featured?.image || gallery[0]?.image)
}

const buildBoatPayload = async ({ payload, body, existing }: { payload: any; body: any; existing?: any }) => {
  const gallery = Array.isArray(body.gallery)
    ? body.gallery
        .map((item: any) => ({
          image: toId(item.imageId || item.image),
          isFeatured: Boolean(item.isFeatured),
        }))
        .filter((item: any) => item.image)
    : []

  let featuredSeen = false
  const normalisedGallery = gallery.map((item: any, index: number) => {
    const isFeatured = Boolean(item.isFeatured) && !featuredSeen
    if (isFeatured) featuredSeen = true

    return {
      ...item,
      isFeatured,
    }
  })

  if (!featuredSeen && normalisedGallery[0]) {
    normalisedGallery[0].isFeatured = true
  }

  const amenityIds = Array.isArray(body.globalAmenities)
    ? body.globalAmenities.map(toId).filter(Boolean)
    : []

  const legacyAmenities = await buildLegacyAmenities({ payload, amenityIds })
  const media = getFeaturedImageId(normalisedGallery) || toId(existing?.media)

  return {
    archived: Boolean(body.archived),
    name: String(body.name || '').trim(),
    slug: String(body.slug || '').trim() || slugify(String(body.name || '')),
    owner: toId(body.ownerId) || undefined,
    location: toId(body.locationId) || undefined,
    price: toNumber(body.price, 0),
    salePrice: toNumber(body.salePrice, 0) || undefined,
    priceDay: toNumber(body.priceDay, 0),
    minHours: Math.max(1, toNumber(body.minHours, 1)),
    media,
    gallery: normalisedGallery,
    globalAmenities: amenityIds,
    amenities: legacyAmenities,
    routes: Array.isArray(body.routes) ? body.routes.map(toId).filter(Boolean) : [],
    keyFeatures: Array.isArray(body.keyFeatures)
      ? body.keyFeatures
          .map((row: any) => ({
            feature: String(row.feature || '').trim(),
            included: row.included !== false,
          }))
          .filter((row: any) => row.feature)
      : [],
    boatSpecific: Array.isArray(body.boatSpecific)
      ? body.boatSpecific.map((row: any) => ({ faq: String(row.faq || '').trim() })).filter((row: any) => row.faq)
      : [],
    boatSpecifications: {
      type: body.type || 'Yacht',
      manufacture: String(body.manufacture || '').trim() || 'Unknown',
      refit: String(body.refit || '').trim(),
      length: String(body.length || '').trim(),
      capacity: Math.max(1, toNumber(body.capacity, 1)),
      sleeps: String(body.sleeps || '').trim() || '0',
      bathrooms: String(body.bathrooms || '').trim() || '0',
      crew: toNumber(body.crew, 0),
      description: String(body.description || '').trim(),
    },
  }
}

export const yachtDeskEndpoints: Endpoint[] = [
  {
    path: '/yacht-desk/options',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const [owners, locations, amenities, routes] = await Promise.all([
        req.payload.find({ collection: 'owners', depth: 0, limit: 500, sort: 'name', overrideAccess: true }),
        req.payload.find({ collection: 'locations', depth: 0, limit: 500, sort: 'name', overrideAccess: true }),
        req.payload.find({ collection: 'amenities', depth: 0, limit: 500, sort: 'sortOrder,name', overrideAccess: true, where: { isActive: { equals: true } } }),
        req.payload.find({ collection: 'routes', depth: 0, limit: 500, sort: 'name', overrideAccess: true }),
      ])

      return Response.json({
        owners: (owners.docs || []).map(mapOption),
        locations: (locations.docs || []).map(mapOption),
        amenities: (amenities.docs || []).map(mapAmenity),
        routes: (routes.docs || []).map(mapOption),
      })
    },
  },
  {
    path: '/yacht-desk/boats',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const boats = await req.payload.find({
        collection: 'boats',
        depth: 2,
        limit: 500,
        sort: '-createdAt',
        overrideAccess: true,
      })

      return Response.json({ boats: (boats.docs || []).map(mapBoat) })
    },
  },
  {
    path: '/yacht-desk/:id',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const routeParams = (req as any).routeParams || {}
      const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

      const boat = await req.payload.findByID({
        collection: 'boats',
        id,
        depth: 2,
        overrideAccess: true,
      })

      return Response.json({ boat: mapBoat(boat), raw: boat })
    },
  },
  {
    path: '/yacht-desk/create',
    method: 'post',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const body = await getRequestBody(req)

      if (!String(body.name || '').trim()) {
        return Response.json({ message: 'Yacht name is required.' }, { status: 400 })
      }

      const data = await buildBoatPayload({ payload: req.payload, body })

      const boat = await req.payload.create({
        collection: 'boats',
        data: data as any,
        overrideAccess: true,
        user: req.user,
      })

      return Response.json({ success: true, boat: mapBoat(boat) })
    },
  },
  {
    path: '/yacht-desk/:id',
    method: 'patch',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const routeParams = (req as any).routeParams || {}
      const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id
      const body = await getRequestBody(req)

      const existing = await req.payload.findByID({
        collection: 'boats',
        id,
        depth: 0,
        overrideAccess: true,
      })

      const data = await buildBoatPayload({ payload: req.payload, body, existing })

      const boat = await req.payload.update({
        collection: 'boats',
        id,
        data: data as any,
        overrideAccess: true,
        user: req.user,
      })

      return Response.json({ success: true, boat: mapBoat(boat) })
    },
  },
]

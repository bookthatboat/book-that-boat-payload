import type { CollectionConfig, PayloadRequest } from 'payload'

interface ReviewDoc {
  boat: string | { id: string }
  rating: number
}

export const Reviews: CollectionConfig = {
  slug: 'reviews',
  fields: [
    {
      name: 'boat',
      type: 'relationship',
      relationTo: 'boats',
      required: true,
      index: true,
    },
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
    },
    {
      name: 'rating',
      type: 'number',
      min: 1,
      max: 5,
      required: true,
    },
    {
      name: 'comment',
      type: 'textarea',
    },
    {
      name: 'approved',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Approved reviews will be visible publicly',
      },
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation === 'create' || operation === 'update') {
          await updateBoatRating(doc, req)
        }
      },
    ],
    afterDelete: [
      async ({ doc, req }) => {
        await updateBoatRating(doc, req)
      },
    ],
  },
}

async function updateBoatRating(doc: ReviewDoc, req: PayloadRequest) {
  const boatId = typeof doc.boat === 'object' ? doc.boat.id : doc.boat
  if (!boatId) return

  // Find approved reviews for this boat
  const reviewsRes = await req.payload.find({
    collection: 'reviews',
    where: {
      boat: { equals: boatId },
      approved: { equals: true },
    },
    depth: 0,
    limit: 1000,
  })

  // Calculate average rating
  if (reviewsRes.docs.length > 0) {
    const total = reviewsRes.docs.reduce((sum: number, rev) => sum + rev.rating, 0)
    const average = total / reviewsRes.docs.length

    // Update boat with new rating data
    await req.payload.update({
      collection: 'boats',
      id: boatId,
      data: {
        averageRating: parseFloat(average.toFixed(1)),
        reviewCount: reviewsRes.docs.length,
      },
    })
  } else {
    // Reset if no reviews
    await req.payload.update({
      collection: 'boats',
      id: boatId,
      data: {
        averageRating: 0,
        reviewCount: 0,
      },
    })
  }
}

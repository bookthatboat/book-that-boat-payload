import type { CollectionConfig } from 'payload'

const generateSlug = (label: string): string =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')

export const BoatTypes: CollectionConfig = {
  slug: 'boat-types',
  admin: {
    useAsTitle: 'label',
    defaultColumns: ['label', 'slug'],
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'label',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'URL-friendly identifier (auto-generated if left empty)',
      },
    },
  ],
  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (data?.label && !data.slug) {
          data.slug = generateSlug(data.label)
        }
        return data
      },
    ],
  },
}

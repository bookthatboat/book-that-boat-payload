import type { CollectionConfig } from 'payload'

const slugify = (label: string): string =>
  label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')

export const EventTypes: CollectionConfig = {
  slug: 'event-types',

  // ascending: 1,2,3,... (1 on top)
  defaultSort: 'priority',

  admin: {
    useAsTitle: 'label',
    defaultColumns: ['label', 'slug', 'priority'],
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
    {
      name: 'priority',
      type: 'number',
      required: true,
      defaultValue: 1,
      admin: {
        description: '1 = first, 2 = second, 3 = third, etc.',
      },
    },
  ],

  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (data?.label && !data.slug) {
          data.slug = slugify(data.label)
        }
        return data
      },
    ],
  },
}

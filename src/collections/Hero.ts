import type { CollectionConfig } from 'payload'

export const Hero: CollectionConfig = {
  slug: 'hero',
  admin: {
    useAsTitle: 'title',
  },
  access: {
    read: () => true,
    create: () => true,
    update: () => true,
    delete: () => true,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      name: 'subtitle',
      type: 'text',
    },
    {
      name: 'backgroundImage',
      type: 'upload',
      relationTo: 'media',
      required: true,
    },
    {
      name: 'ctaText',
      type: 'text',
      required: false,
    },
    {
      name: 'ctaLink',
      type: 'text',
      required: false,
    },
  ],
}

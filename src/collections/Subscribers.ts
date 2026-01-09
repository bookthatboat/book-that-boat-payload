import type { CollectionConfig } from 'payload'

export const Subscribers: CollectionConfig = {
  slug: 'subscribers',
  access: { read: () => true },

  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'createdAt'],
    description: 'Newsletter email subscribers',
  },

  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (data && typeof data.email === 'string') {
          data.email = data.email.toLowerCase().trim()
        }
      },
    ],
  },

  fields: [
    {
      name: 'email',
      type: 'email',
      required: true,
      unique: true,
      index: true,
    },
  ],
}

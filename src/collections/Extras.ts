import type { CollectionConfig } from 'payload'
import type { Field } from 'payload'

function stringToLexical(value: string) {
  return {
    root: {
      type: 'root',
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
      children: value
        ? [
            {
              type: 'paragraph',
              direction: 'ltr',
              format: '',
              indent: 0,
              version: 1,
              children: [
                {
                  type: 'text',
                  text: value,
                  detail: 0,
                  format: 0,
                  mode: 'normal',
                  style: '',
                  version: 1,
                },
              ],
            },
          ]
        : [],
    },
  }
}

export const Extras: CollectionConfig = {
  slug: 'extras',
  admin: {
    useAsTitle: 'name',
  },
  access: {
    read: () => true,
  },
  hooks: {
    beforeChange: [
      async ({ data, operation }) => {
        if (operation === 'update' && data?.dependentItems) {
          const currentId = data.id
          const dependencies = data.dependentItems as string[]

          return {
            ...data,
            dependentItems: dependencies.filter((id) => id !== currentId),
          }
        }

        if (typeof data?.description === 'string') {
          data.description = stringToLexical(data.description)
        }

        return data
      },
    ],

    beforeRead: [
      ({ doc }) => {
        if (doc?.description && typeof doc.description === 'string') {
          doc.description = stringToLexical(doc.description)
        }
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'category',
      type: 'select',
      required: true,
      options: [
        { label: 'Watersports', value: 'watersports' },
        { label: 'Catering', value: 'catering' },
        { label: 'Entertainment', value: 'entertainment' },
        { label: 'Decor', value: 'decor' },
      ],
    },
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'description',
      type: 'richText',
      admin: {
        description: 'Detailed description of the extra service',
      },
    },
    {
      name: 'itemsDetails',
      type: 'upload',
      relationTo: 'media',
      required: true,
    },
    {
      name: 'minimumNumberOfPax',
      type: 'group',
      fields: [
        {
          name: 'min',
          type: 'number',
          required: true,
          min: 0,
          defaultValue: 1,
        },
        {
          name: 'max',
          type: 'number',
          required: false,
          min: 1,
        },
      ],
    },
    {
      name: 'unitPrice',
      type: 'number',
      required: true,
      min: 0,
    },
    {
      name: 'dependentItems',
      type: 'relationship',
      relationTo: 'extras',
      hasMany: true,
      filterOptions: ({ id }) => {
        return { id: { not_in: [id] } }
      },
      admin: {
        description: 'Select extras that must be purchased with this item',
      },
    } as Field,
    {
      name: 'boat',
      type: 'relationship',
      relationTo: 'boats',
      required: true,
      hasMany: true,
    },
  ],
}

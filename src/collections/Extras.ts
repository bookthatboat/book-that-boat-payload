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
    defaultColumns: ['name', 'archived', 'category', 'unitPrice'],
  },
  access: {
    read: ({ req }) => {
      if (req.user) return true

      return {
        archived: {
          not_equals: true,
        },
      }
    },
  },
  endpoints: [
    {
      path: '/:id/boat-assignment',
      method: 'patch',
      handler: async (req) => {
        const routeParams = (req as any).routeParams || {}
        const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

        try {
          if (!req.user) {
            return Response.json({ message: 'Unauthorized.' }, { status: 401 })
          }

          if (!id) {
            return Response.json({ message: 'Missing extra ID.' }, { status: 400 })
          }

          const body =
            typeof req.json === 'function'
              ? await req.json().catch(() => null)
              : ((req as any).data ?? null)

          const boatIds = Array.isArray(body?.boatIds)
            ? body.boatIds.filter((boatId: unknown) => typeof boatId === 'string' && boatId)
            : null

          if (!boatIds) {
            return Response.json({ message: 'boatIds must be an array.' }, { status: 400 })
          }

          const updatedExtra = await req.payload.update({
            collection: 'extras',
            id,
            data: {
              boat: Array.from(new Set(boatIds)),
            },
            depth: 0,
            overrideAccess: true,
          })

          return Response.json({
            doc: updatedExtra,
          })
        } catch (error) {
          console.error('[extras/boat-assignment] failed', {
            extraId: id,
            error,
          })

          return Response.json(
            {
              message:
                error instanceof Error
                  ? error.message
                  : 'Could not update extra boat assignment.',
            },
            {
              status: 500,
            },
          )
        }
      },
    },
  ],
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
      name: 'archived',
      type: 'checkbox',
      label: 'Archived',
      defaultValue: false,
      index: true,
      admin: {
        position: 'sidebar',
        description:
          'Archived extras remain in the system for old reservations but are hidden from the public frontend.',
      },
    },
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
      required: false,
      hasMany: true,
      admin: {
        description: 'Optional. Extras can be created first and assigned to boats later from the Boat edit screen.',
      },
    },
  ],
}

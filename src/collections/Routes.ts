import type { CollectionConfig } from 'payload'

export const Routes: CollectionConfig = {
  slug: 'routes',
  admin: {
    useAsTitle: 'routeName',
    defaultColumns: ['routeName', 'location', 'hourRoutes'],
  },
  access: {
    read: () => true,
    create: () => true,
    update: () => true,
  },
  fields: [
    {
      name: 'routeName',
      type: 'text',
      required: true,
      label: 'Route Name',
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      required: true,
      label: 'Select Location',
      admin: {
        allowCreate: false,
      },
    },
    {
      name: 'hourRoutes',
      type: 'array',
      label: 'Duration Routes',
      minRows: 1,
      labels: {
        singular: 'Duration Route',
        plural: 'Duration Routes',
      },
      fields: [
        {
          name: 'duration',
          type: 'text',
          required: true,
          label: 'Route Duration',
          admin: {
            placeholder: 'e.g., 3 Hour Route, Full Day Route',
            description: 'Enter duration in hours (e.g., "3 Hours", "6-8 Hours")',
          },
        },
        {
          name: 'points',
          type: 'array',
          label: 'Route Points',
          minRows: 1,
          labels: {
            singular: 'Point',
            plural: 'Points',
          },
          fields: [
            {
              name: 'point',
              type: 'text',
              required: true,
              admin: {
                placeholder: 'Enter location point (e.g., Marina Bay, Coral Reef)',
                width: '100%',
              },
            },
          ],
          admin: {
            initCollapsed: true,
          },
        },
      ],
      admin: {
        initCollapsed: true,
      },
    },
  ],
}

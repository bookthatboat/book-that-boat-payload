import type { CollectionConfig } from 'payload'

export const Menu: CollectionConfig = {
  slug: 'menu',
  access: { read: () => true },
  fields: [
    {
      name: 'logo',
      type: 'upload',
      relationTo: 'media',
      required: true,
    },
    {
      name: 'scrolled_logo',
      type: 'upload',
      relationTo: 'media',
      label: 'Scrolled Logo',
      admin: {
        description: 'Logo to display when user scrolls down',
      },
    },
    {
      name: 'menu_items',
      type: 'array',
      required: true,
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'link', type: 'text', required: true },
        {
          name: 'submenu',
          type: 'array',
          fields: [
            { name: 'label', type: 'text', required: true },
            { name: 'link', type: 'text', required: true },

            // NEW: allow submenu to act as a filter
            {
              name: 'acts_as_filter',
              type: 'checkbox',
              defaultValue: false,
              admin: { description: 'If ON, this submenu navigates to a filter landing page' },
            },
            {
              name: 'filter_kind',
              type: 'select',
              options: [
                { label: 'Event', value: 'event' },
                { label: 'Boat Type', value: 'type' },
                { label: 'Harbour', value: 'harbour' },
              ],
              admin: {
                condition: (_, siblingData) => Boolean(siblingData?.acts_as_filter),
              },
              required: false,
            },
            {
              name: 'filter_value',
              type: 'text',
              admin: {
                description:
                  'Exact value as used in your filters (e.g., "Watersports", "Yacht", "Dubai Marina")',
                condition: (_, siblingData) => Boolean(siblingData?.acts_as_filter),
              },
              required: false,
            },
            {
              name: 'filter_slug',
              type: 'text',
              admin: {
                description:
                  'Pretty URL slug (e.g., "watersports", "yachts", "dubai-marina"). Used for /[filter] route.',
                condition: (_, siblingData) => Boolean(siblingData?.acts_as_filter),
              },
              required: false,
            },
          ],
        },
      ],
    },
    {
      name: 'social_media',
      type: 'array',
      fields: [
        {
          name: 'platform',
          type: 'text',
          required: true,
        },
        {
          name: 'url',
          type: 'text',
          required: true,
        },
        {
          name: 'icon',
          type: 'text',
          required: true,
          admin: {
            description: 'Font Awesome icon class (e.g. fab fa-facebook)',
          },
        },
      ],
    },
    {
      name: 'book_now_button',
      type: 'group',
      fields: [
        { name: 'label', type: 'text', required: true, defaultValue: 'Book Now' },
        { name: 'link', type: 'text', required: true, defaultValue: '/book-now' },
      ],
    },
  ],
}

import type { CollectionConfig } from 'payload'

export const Amenities: CollectionConfig = {
  slug: 'amenities',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'category', 'sortOrder'],
    group: 'Boats',
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      unique: true,
      index: true,
    },
    {
      name: 'category',
      type: 'select',
      defaultValue: 'comfort',
      options: [
        { label: 'Comfort', value: 'comfort' },
        { label: 'Entertainment', value: 'entertainment' },
        { label: 'Food & Drink', value: 'food_drink' },
        { label: 'Safety', value: 'safety' },
        { label: 'Water Sports', value: 'water_sports' },
        { label: 'Other', value: 'other' },
      ],
    },
    {
      name: 'sortOrder',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Lower numbers appear first in the Boat amenity checklist.',
      },
    },
    {
      name: 'isActive',
      type: 'checkbox',
      defaultValue: true,
    },
  ],
}

// src/collections/Coupons.ts
import type { CollectionConfig } from 'payload'

export const Coupons: CollectionConfig = {
  slug: 'coupons',
  admin: {
    useAsTitle: 'code',
    defaultColumns: ['code', 'isActive', 'type', 'amount', 'expiresAt', 'applyToAllBoats'],
  },
  access: {
    // If you keep this as true, coupon codes are enumerable via /api/coupons
    // (today they’re already effectively public because they’re inside boats)
    read: () => true,
  },
  fields: [
    {
      name: 'code',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      hooks: {
        beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)],
      },
    },
    {
      name: 'type',
      type: 'select',
      required: true,
      options: [
        { label: 'Percentage Discount', value: 'percentage' },
        { label: 'Fixed Amount Discount', value: 'fixed' },
      ],
    },
    { name: 'amount', type: 'number', required: true, min: 1 },
    { name: 'isActive', type: 'checkbox', defaultValue: true, index: true },
    { name: 'expiresAt', type: 'date' },

    { name: 'usageCount', type: 'number', defaultValue: 0, admin: { readOnly: true } },

    { name: 'applyToAllBoats', type: 'checkbox', defaultValue: false, index: true },

    {
      name: 'boats',
      type: 'relationship',
      relationTo: 'boats',
      hasMany: true,
      admin: {
        condition: (_, siblingData) => !siblingData?.applyToAllBoats,
        description: 'If not global, select which boats this coupon applies to.',
      },
    },
  ],
}

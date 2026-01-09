import type { CollectionConfig } from 'payload';

export const Footer: CollectionConfig = {
  slug: 'footer',
  access: { read: () => true },
  fields: [
    // ✅ Logo
    {
      name: 'logo',
      type: 'upload',
      relationTo: 'media',
      required: true,
    },

    // ✅ Footer Links Section
    {
      name: 'footer_links',
      type: 'array',
      required: true,
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'link', type: 'text', required: true },
      ],
    },

    // ✅ Social Media Links
    {
      name: 'social_links',
      type: 'array',
      fields: [
        { name: 'platform', type: 'text', required: true },
        { name: 'icon', type: 'text', required: true }, // e.g., "facebook", "twitter"
        { name: 'url', type: 'text', required: true },
      ],
    },

    // ✅ Copyright Text
    {
      name: 'copyright',
      type: 'text',
      required: true,
      defaultValue: '© 2024 Book That Boat. All rights reserved.',
    },
  ],
};


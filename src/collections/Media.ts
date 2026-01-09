// src/collections/Media.ts
import type { CollectionConfig } from 'payload'
import { put } from '@vercel/blob'
import sharp from 'sharp'

// Extend the PayloadRequest interface using module augmentation
declare module 'payload' {
  // @ts-ignore
  interface PayloadRequest {
    file?: {
      name: string
      data: Buffer
      mimetype: string
      size: number
    }
  }
}

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
    {
      name: 'blobUrl',
      type: 'text',
      admin: {
        position: 'sidebar',
      },
    },
    {
      name: 'filename',
      type: 'text',
      admin: {
        hidden: true,
      },
    },
    {
      name: 'mimeType',
      type: 'text',
      admin: {
        hidden: true,
      },
    },
    {
      name: 'filesize',
      type: 'number',
      admin: {
        hidden: true,
      },
    },
    {
      name: 'width',
      type: 'number',
      admin: {
        hidden: true,
      },
    },
    {
      name: 'height',
      type: 'number',
      admin: {
        hidden: true,
      },
    },
  ],
  hooks: {
    beforeChange: [
      async ({ data, req, operation }) => {
        // Only handle file uploads on create operation
        if (req.file && operation === 'create') {
          const file = req.file

          try {
            // Upload to Vercel Blob
            const blob = await put(file.name, file.data, {
              access: 'public',
            })

            // Get image dimensions for images
            let width = null
            let height = null

            if (file.mimetype.startsWith('image/')) {
              try {
                const image = sharp(file.data)
                const metadata = await image.metadata()
                width = metadata.width
                height = metadata.height
              } catch (error) {
                console.error('Error getting image dimensions:', error)
              }
            }

            return {
              ...data,
              blobUrl: blob.url,
              filename: file.name,
              mimeType: file.mimetype,
              filesize: file.size,
              width,
              height,
            }
          } catch (error) {
            console.error('Error uploading to Vercel Blob:', error)
            throw new Error('Failed to upload file to Vercel Blob')
          }
        }

        // For updates, return the existing data
        return data
      },
    ],
  },
  upload: {
    // Disable local storage since we're using Vercel Blob
    disableLocalStorage: true,
    // Use custom admin thumbnail
    adminThumbnail: ({ doc }) => {
      return (doc.blobUrl as string) || ''
    },
    mimeTypes: ['image/*', 'video/*', 'audio/*', 'application/pdf'],
  },
}

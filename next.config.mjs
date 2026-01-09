import { withPayload } from '@payloadcms/next/withPayload'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default withPayload({
  reactStrictMode: true,

  serverExternalPackages: ['payload'],

  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
        pathname: '/api/media/**',
      },
      {
        protocol: 'https',
        hostname: 'iqs9cmwxvznbiu7f.public.blob.vercel-storage.com',
        pathname: '/**',
      },
     /*  {
        protocol: 'https',
        hostname: '.public.blob.vercel-storage.com',
        pathname: '/**',
      }, */
      {
        protocol: 'https',
        hostname: 'book-that-boat-frontend.vercel.app',
        pathname: '/**',
      },
    ],
  },

  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@components': path.resolve(__dirname, 'src/app/(frontend)/components'),
      '@utils': path.resolve(__dirname, 'src/app/(frontend)/utils'),
      '@styles': path.resolve(__dirname, 'src/app/(frontend)/styles'),
      '@config': path.resolve(__dirname, 'src/config'),
    }

    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        net: false,
        tls: false,
      }
    }

    return config
  },
})

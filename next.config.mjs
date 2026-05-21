import { withPayload } from '@payloadcms/next/withPayload'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const codespaceName = process.env.CODESPACE_NAME
const codespaceDomain =
  process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'

const codespaceOrigin = codespaceName
  ? `${codespaceName}-3000.${codespaceDomain}`
  : undefined

const adminHostFromEnv = process.env.PAYLOAD_PUBLIC_SERVER_URL
  ? new URL(process.env.PAYLOAD_PUBLIC_SERVER_URL).host
  : undefined

const serverActionAllowedOrigins = [
  'localhost:3000',
  '127.0.0.1:3000',
  'book-that-boat-payload-production.up.railway.app',
  'bookings.bookthatboat.com',
  adminHostFromEnv,
  codespaceOrigin,
].filter(Boolean)

export default withPayload({
  reactStrictMode: true,

  serverExternalPackages: ['payload'],

  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
      allowedOrigins: serverActionAllowedOrigins,
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
      {
        protocol: 'https',
        hostname: 'bookthatboat.com',
        pathname: '/**',
      },
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

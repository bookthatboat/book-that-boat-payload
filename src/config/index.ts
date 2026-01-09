export const isProduction = process.env.NODE_ENV === 'production'
export const isDevelopment = !isProduction

// MamoPay configuration
export const MAMOPAY_CONFIG = {
  baseUrl:
    process.env.MAMOPAY_BASE_URL ||
    (isProduction ? 'https://business.mamopay.com' : 'https://sandbox.dev.business.mamopay.com'),
  apiKey: process.env.MAMOPAY_API_KEY || '',
}

// Email configuration
export const EMAIL_CONFIG = {
  enabled: !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD),
  from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || 'noreply@bookthatboat.com',
  adminEmail: 'web@bookthatboat.com',
}

// Application URLs
export const APP_URLS = {
  frontend: process.env.NEXT_PUBLIC_API_URL || 'https://bookthatboat.com',
  api: process.env.NEXT_PUBLIC_API_URL || 'https://localhost:3000',
}

// Default values
export const DEFAULTS = {
  reservationUser: process.env.DEFAULT_RESERVATION_USER_EMAIL || 'web@bookthatboat.com',
}

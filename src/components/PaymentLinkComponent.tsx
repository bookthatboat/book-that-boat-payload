// src/components/PaymentLinkComponent.tsx
'use client'
import React, { useState, useEffect } from 'react'

export const PaymentLinkComponent: React.FC<{
  value?: string
  path: string
}> = ({ value }) => {
  const [paymentLink, setPaymentLink] = useState(value)

  useEffect(() => {
    setPaymentLink(value)
  }, [value])

  return (
    <input
      type="text"
      value={paymentLink || 'Generating...'}
      readOnly
      disabled
      style={{
        width: '100%',
        padding: '8px',
        backgroundColor: '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: '4px',
        color: '#666',
      }}
    />
  )
}

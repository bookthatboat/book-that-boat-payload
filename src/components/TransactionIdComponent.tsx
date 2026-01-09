// src/components/TransactionIdComponent.tsx
'use client';
import React, { useState, useEffect } from 'react';

export const TransactionIdComponent: React.FC<{
  value?: string;
  path: string;
}> = ({ value }) => {
  const [transactionId, setTransactionId] = useState(value);

  useEffect(() => {
    setTransactionId(value);
  }, [value]);

  return (
    <input 
      type="text" 
      value={transactionId || 'Generating...'} 
      readOnly 
      disabled
      style={{ 
        width: '100%', 
        padding: '8px',
        backgroundColor: '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: '4px',
        color: '#666'
      }}
    />
  );
};
'use client';
import { useState } from 'react';

export function Checkout() {
  const [done, setDone] = useState(false);
  async function pay() {
    await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ total: 1000 }) });
    setDone(true);
  }
  return <button onClick={pay}>{done ? 'Paid' : 'Pay'}</button>;
}

// src/app/(frontend)/types/reservations.ts
import { Boat } from './boats'
import { User } from '@/types/users'

export type ReservationStatus = 'pending' | 'confirmed' | 'cancelled' | 'awaiting payment'

export interface Reservation {
  id: string
  boat: string | Boat
  user: string | User
  start_time: Date
  end_time: Date
  status: ReservationStatus
  payment?: {
    amount: number
    method: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
    transaction_id?: string
  }
  createdAt: Date
  updatedAt: Date
}

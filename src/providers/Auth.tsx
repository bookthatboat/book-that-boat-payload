'use client'
import { createContext, useContext, useState, ReactNode } from 'react'
import type { User, AuthContextType } from '@/types/users'

const AuthContext = createContext<AuthContextType | null>(null)

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)

  const login = async (email: string, password: string) => {
    const mockUser: User = {
      id: '1',
      name: 'User',
      email: 'web@bookthatboat.com',
      role: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
      // Add optional fields if needed
      phone: '',
      address: ''
    };
    setUser(mockUser);
  };

  const logout = () => setUser(null)

  const register = async (userData: Omit<User, 'id'> & { password: string }) => {
    const newUser: User = {
      ...userData,
      id: '2',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    setUser(newUser)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}

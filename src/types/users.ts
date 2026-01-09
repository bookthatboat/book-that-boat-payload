export interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'owner' | 'user'
  phone?: string
  address?: string
  createdAt: Date
  updatedAt: Date
}

export interface AuthContextType {
  user: User | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  register: (user: Omit<User, 'id'> & { password: string }) => Promise<void>
}

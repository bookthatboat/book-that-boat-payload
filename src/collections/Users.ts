import type { CollectionConfig, Access } from 'payload'

// Define access control functions
const isAdmin: Access = ({ req: { user } }) => {
  return user?.role === 'admin'
}

const isAdminOrSelf: Access = ({ req: { user } }) => {
  if (user?.role === 'admin') {
    return true
  }
  
  // Users can only access their own data
  return {
    id: {
      equals: user?.id,
    },
  }
}

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    hidden: ({ user }) => user?.role !== 'admin',
  },
  auth: true,
  access: {
    read: isAdminOrSelf,
    create: isAdmin,
    update: isAdminOrSelf,
    delete: isAdmin,
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'user',
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'User', value: 'user' },
      ],
      access: {
        // Only admins can change roles
        update: ({ req: { user } }) => user?.role === 'admin',
      },
    },
  ],
}
import type { CollectionConfig } from 'payload'
import { getCountries } from 'libphonenumber-js'

const countries = getCountries().sort()
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })

const countryOptions = countries.map((code) => ({
  label: displayNames.of(code) || code,
  value: code,
}))

// Safe country name function
const getCountryName = (countryCode: string): string => {
  try {
    return displayNames.of(countryCode) || countryCode
  } catch {
    return countryCode
  }
}

export const Locations: CollectionConfig = {
  slug: 'locations',
  access: {
    read: () => true,
  },
  admin: {
    useAsTitle: 'displayName',
  },
  fields: [
    {
      name: 'country',
      type: 'select',
      label: 'Country',
      required: true,
      options: countryOptions,
    },
    {
      name: 'city',
      type: 'text',
      required: true,
    },
    {
      name: 'harbour',
      type: 'text',
      required: true,
      validate: async (value: unknown, { operation, req, id }: any) => {
        // Handle the case where value might be an array or null/undefined
        if (Array.isArray(value)) {
          return 'Harbour name cannot be an array'
        }

        const stringValue = value as string

        if (!stringValue || typeof stringValue !== 'string') {
          return 'Harbour name is required'
        }

        // Trim the harbour name
        const trimmedHarbour = stringValue.trim()

        if (!trimmedHarbour) {
          return 'Harbour name is required'
        }

        try {
          // Query for existing locations with the same harbour name (case-insensitive)
          const existingLocations = await req.payload.find({
            collection: 'locations',
            where: {
              and: [
                {
                  harbour: {
                    like: trimmedHarbour,
                  },
                },
                // Exclude current document during update operations
                ...(operation === 'update' && id ? [{ id: { not_equals: id } }] : []),
              ],
            },
            limit: 1,
          })

          // If a duplicate is found, return validation error
          if (existingLocations.docs.length > 0) {
            const existingLocation = existingLocations.docs[0]
            // Check if it's actually a case-insensitive match (since 'like' might be too broad)
            if (existingLocation.harbour.toLowerCase() === trimmedHarbour.toLowerCase()) {
              return `This harbour name already exists. Please enter a unique name. (Conflict with: ${existingLocation.harbour}, ${existingLocation.city}, ${getCountryName(existingLocation.country)})`
            }
          }

          return true
        } catch (error) {
          console.error('Error validating harbour name:', error)
          // If there's an error querying the database, allow the operation
          // but log the error for debugging
          return true
        }
      },
    },
    {
      name: 'displayName',
      type: 'text',
      admin: {
        readOnly: true,
        hidden: true,
      },
    },
  ],
  hooks: {
    beforeChange: [
      ({ data }) => {
        if (data?.harbour && data?.city && data?.country) {
          data.displayName = `${data.harbour}, ${data.city}, ${getCountryName(data.country)}`
        }
        return data
      },
    ],
  },
}

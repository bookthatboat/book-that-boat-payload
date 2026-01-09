import type { CollectionConfig, Validate } from 'payload'
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js'

const countries = getCountries().sort()
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })

const countryOptions = countries.map((code) => ({
  label: displayNames.of(code) || code,
  value: code,
}))

export const Owners: CollectionConfig = {
  slug: 'owners',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    // Owner Information
    {
      name: 'name',
      type: 'text',
      label: 'Company Name',
      required: true,
    },
    {
      name: 'countryCode',
      type: 'select',
      label: 'Country Code',
      required: true,
      admin: {
        width: '50%',
      },
      options: getCountries()
        .map((countryCode) => {
          const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode)
          return {
            label: `${name} (+${getCountryCallingCode(countryCode)})`,
            value: `+${getCountryCallingCode(countryCode)}`,
          }
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      name: 'contactNumber',
      type: 'text',
      label: 'Contact Number',
      required: true,
      admin: {
        placeholder: '412 345 678',
        width: '50%',
      },
    },
    {
      name: 'address',
      type: 'group',
      label: 'Address',
      fields: [
        {
          name: 'streetLine1',
          type: 'text',
          label: 'Street Address',
          required: true,
          admin: {
            placeholder: 'Enter street address',
          },
        },
        {
          name: 'streetLine2',
          type: 'text',
          label: 'Apartment/Suite',
          required: false,
          admin: {
            placeholder: 'Apartment, suite, or building number',
          },
        },
        {
          name: 'city',
          type: 'text',
          label: 'City',
          required: true,
          admin: {
            placeholder: 'Enter city',
            width: '50%',
          },
        },
        {
          name: 'state',
          type: 'text',
          label: 'State/Province/Region',
          required: false,
          admin: {
            placeholder: 'Enter state/province',
            width: '50%',
          },
        },
        {
          name: 'postalCode',
          type: 'text',
          label: 'Postal Code',
          required: false,
          admin: {
            placeholder: 'Enter postal code',
            width: '50%',
          },
        },
        {
          name: 'country',
          type: 'select',
          label: 'Country',
          required: true,
          admin: {
            width: '50%',
          },
          options: countryOptions,
        },
        /* {
          name: 'country',
          type: 'select',
          label: 'Country',
          required: true,
          options: getCountries()
            .map((countryCode) => {
              const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode)
              if (!name) return null
              return {
                label: `${name} (+${getCountryCallingCode(countryCode)})`,
                value: `+${getCountryCallingCode(countryCode)}`,
              }
            })
            .filter((option): option is { label: string; value: string } => !!option)
            .sort((a, b) => a.label.localeCompare(b.label)),

          admin: {
            placeholder: 'Select country',
            width: '50%',
          },
        }, */
      ],
    },
    {
      name: 'email',
      type: 'email',
      label: 'Email',
      required: true,
    },

    // Banking Details
    {
      name: 'bankDetails',
      type: 'group',
      fields: [
        {
          name: 'accountName',
          type: 'text',
          required: false,
        },
        {
          name: 'iban',
          type: 'text',
          label: 'IBAN',
          required: false,
        },
        {
          name: 'bankName',
          type: 'text',
          required: false,
        },
        {
          name: 'country',
          type: 'select',
          label: 'Country',
          required: false,
          admin: {
            width: '50%',
          },
          options: countryOptions,
        },
        {
          name: 'swift',
          type: 'text',
          label: 'SWIFT (Optional)',
          required: false,
        },
        {
          name: 'trn',
          type: 'text',
          label: 'TRN (Tax Registration Number)',
          required: false,
          admin: {
            placeholder: 'Enter TRN if applicable',
            description: 'Tax Registration Number (optional)',
          },
        },
      ],
    },

    // Billing Contact (Optional)
    {
      name: 'billingContact',
      type: 'group',
      label: 'Billing Contact (Optional)',
      fields: [
        {
          name: 'firstName',
          type: 'text',
          label: 'First Name',
          required: false,
        },
        {
          name: 'lastName',
          type: 'text',
          label: 'Last Name',
          required: false,
        },
        {
          name: 'countryCode',
          type: 'select',
          label: 'Country Code',
          required: false,
          admin: {
            width: '50%',
          },
          options: getCountries()
            .map((countryCode) => {
              const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode)
              return {
                label: `${name} (+${getCountryCallingCode(countryCode)})`,
                value: `+${getCountryCallingCode(countryCode)}`,
              }
            })
            .sort((a, b) => a.label.localeCompare(b.label)),
        },
        {
          name: 'contactNumber',
          type: 'text',
          label: 'Contact Number',
          required: false,
          admin: {
            placeholder: '412 345 678',
            width: '50%',
          },
        },
        {
          name: 'email',
          type: 'email',
          required: false,
        },
      ],
    },

    // Administrative Contact
    {
      name: 'administrativeContact',
      type: 'group',
      fields: [
        {
          name: 'firstName',
          type: 'text',
          label: 'First Name',
          required: true,
        },
        {
          name: 'lastName',
          type: 'text',
          label: 'Last Name',
          required: true,
        },
        {
          name: 'countryCode',
          type: 'select',
          label: 'Country Code',
          required: true,
          admin: {
            width: '50%',
          },
          options: getCountries()
            .map((countryCode) => {
              const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode)
              return {
                label: `${name} (+${getCountryCallingCode(countryCode)})`,
                value: `+${getCountryCallingCode(countryCode)}`,
              }
            })
            .sort((a, b) => a.label.localeCompare(b.label)),
        },
        {
          name: 'contactNumber',
          type: 'text',
          label: 'Contact Number',
          required: true,
          admin: {
            placeholder: '412 345 678',
            width: '50%',
          },
        },
        {
          name: 'email',
          type: 'email',
          required: true,
        },
      ],
    },
    {
      name: 'faqs',
      type: 'textarea',
      label: 'FAQ Section',
    },
    {
      name: 'termsConditions',
      type: 'textarea',
      label: 'Terms & Conditions',
    },
    {
      name: 'cancellationPolicy',
      type: 'textarea',
      label: 'Cancellation Policy',
    },

    // Policies & Content
    {
      name: 'comments',
      type: 'textarea',
      label: 'Comments/Notes',
    },
  ],
}

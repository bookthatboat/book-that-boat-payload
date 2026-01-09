import type { CollectionConfig } from 'payload'
import type { Field } from 'payload'
import OpenAI from 'openai'

const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .trim()
}

async function getLocationName(locationId: string, req: any): Promise<string> {
  try {
    const location = await req.payload.findByID({
      collection: 'locations',
      id: locationId,
      depth: 0,
    })
    return location.name || ''
  } catch (error) {
    req.payload.logger.error('Error fetching location:', error)
    return ''
  }
}

export const Boats: CollectionConfig = {
  slug: 'boats',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'location', 'price', 'minHours', 'type', 'specialEventTags'],
  },
  access: {
    read: () => true,
  },
  hooks: {
    beforeChange: [
      ({ data, operation, originalDoc }) => {
        if (data.name && (operation === 'create' || data.name !== originalDoc?.name)) {
          // Generate slug from name
          data.slug = data.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)+/g, '')
        }
        return data
      },

      async ({ data, operation, originalDoc, req }) => {
        if (data.name && !data.slug) {
          data.slug = generateSlug(data.name)
        }

        try {
          const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: 15000,
          })

          const shouldGenerate =
            (operation === 'create' || !originalDoc?.boatSpecifications?.description) &&
            !data?.boatSpecifications?.description

          if (!shouldGenerate) {
            req.payload.logger.info('Skipping AI description generation')
            return data
          }

          const requiredFields = {
            name: data.name,
            type: data.boatSpecifications?.type,
            capacity: data.boatSpecifications?.capacity,
            price: data.price,
          }

          if (Object.values(requiredFields).some((v) => !v)) {
            req.payload.logger.warn(
              `Missing required fields for AI generation: ${JSON.stringify(requiredFields)}`,
            )
            return data
          }

          const locationName = data.location ? await getLocationName(data.location, req) : ''

          const prompt = `
            Generate a professional boat rental description using these details:
            - Boat Name: ${data.name}
            - Type: ${data.boatSpecifications.type}
            - Capacity: ${data.boatSpecifications.capacity} people
            - Length: ${data.boatSpecifications.length}
            - Price/hour: $${data.price}
            - Features: ${data.keyHighlights?.map((f: any) => f.feature).join(', ') || 'Not specified'}
            - Amenities: ${data.amenities?.map((a: any) => a.item).join(', ') || 'Standard amenities'}
            - Year Built: ${data.boatSpecifications.manufacture}
            - Location: ${locationName}

            Requirements:
            - Engaging and professional tone
            - Highlight unique selling points
            - 100-150 words
            - Markdown formatting with paragraphs
          `

          const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 300,
          })

          const description = completion.choices[0].message.content?.trim() || ''

          return {
            ...data,
            boatSpecifications: {
              ...data.boatSpecifications,
              description,
            },
          }
        } catch (error) {
          req.payload.logger.error(
            `AI Generation Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          )
          return data
        }
      },

      async ({ data, req }) => {
        if (data.gallery && Array.isArray(data.gallery)) {
          data.gallery = data.gallery.map((item: any) => {
            if (item.image && typeof item.image === 'object') {
              return { image: item.image.id || item.image }
            }
            return item
          })
        }
        return data
      },
    ],
  },

  fields: [
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        position: 'sidebar',
        description: 'Unique identifier for the boat in URLs',
      },
    },
    // Basic Information
    {
      name: 'owner',
      type: 'relationship',
      relationTo: 'owners',
      required: false,
      index: true,
    },
    {
      name: 'name',
      label: 'Boat Name',
      type: 'text',
      required: true,
    },
    {
      name: 'location',
      type: 'relationship',
      relationTo: 'locations',
      hasMany: false,
      admin: {
        allowCreate: false,
      },
    },
    {
      name: 'price',
      type: 'number',
      label: 'Price Per Hour',
      required: true,
    },
    {
      name: 'salePrice',
      type: 'number',
      label: 'Sale Price',
      required: false,
    },
    {
      name: 'priceDay',
      type: 'number',
      label: 'Price Per Day',
      required: true,
    },
    {
      name: 'minHours',
      type: 'number',
      label: 'Minimum Number of Hours',
      required: true,
      defaultValue: 1,
    },
    {
      name: 'advancedMinHours',
      type: 'array',
      label: 'Advanced Booking Rules',
      fields: [
        // NEW: rule type selector
        {
          name: 'ruleType',
          type: 'select',
          label: 'Rule Type',
          required: true,
          defaultValue: 'minHours',
          options: [
            {
              label: 'Minimum Hours',
              value: 'minHours',
            },
            {
              label: 'Special Event Day',
              value: 'specialEvent',
            },
          ],
          admin: {
            description:
              'Choose whether this rule sets a minimum number of hours or a special event package.',
          },
        },

        // Existing days selector (used by minHours AND specialEvent when dateMode="day")
        {
          name: 'days',
          type: 'select',
          label: 'Select Day(s) or All Days',
          options: [
            {
              label: 'All Days',
              value: 'all',
            },
            {
              label: 'Monday',
              value: 'monday',
            },
            {
              label: 'Tuesday',
              value: 'tuesday',
            },
            {
              label: 'Wednesday',
              value: 'wednesday',
            },
            {
              label: 'Thursday',
              value: 'thursday',
            },
            {
              label: 'Friday',
              value: 'friday',
            },
            {
              label: 'Saturday',
              value: 'saturday',
            },
            {
              label: 'Sunday',
              value: 'sunday',
            },
            {
              label: 'Weekdays',
              value: 'weekdays',
            },
            {
              label: 'Weekend',
              value: 'weekend',
            },
          ],
          required: true,
          hasMany: true,
          admin: {
            condition: (_, siblingData) => {
              // Show for:
              // - Minimum Hours rules (as before)
              // - Special Event rules when using day-based rules (dateMode !== 'date')
              if (!siblingData?.ruleType || siblingData.ruleType === 'minHours') return true
              if (siblingData.ruleType === 'specialEvent' && siblingData.dateMode !== 'date') {
                return true
              }
              return false
            },
            description:
              'Choose specific day(s), weekdays/weekend, or All Days. For Special Event rules, you can also switch to a specific date range below.',
          },
        },

        // Existing timeRange group (shared between both types)
        {
          name: 'timeRange',
          type: 'group',
          label: 'Time Range',
          fields: [
            {
              name: 'type',
              type: 'select',
              label: 'Time Range Type',
              options: [
                {
                  label: 'All Day',
                  value: 'allDay',
                },
                {
                  label: 'Custom Time Range',
                  value: 'custom',
                },
              ],
              defaultValue: 'allDay',
              required: true,
            },
            {
              name: 'startTime',
              type: 'date',
              label: 'Start Time',
              admin: {
                condition: (_, siblingData) => siblingData?.type === 'custom',
                description: 'Select start time',
                date: {
                  pickerAppearance: 'timeOnly',
                  timeIntervals: 30,
                  displayFormat: 'h:mm a',
                },
              },
            },
            {
              name: 'endTime',
              type: 'date',
              label: 'End Time',
              admin: {
                condition: (_, siblingData) => siblingData?.type === 'custom',
                description: 'Select end time',
                date: {
                  pickerAppearance: 'timeOnly',
                  timeIntervals: 30,
                  displayFormat: 'h:mm a',
                },
              },
            },
          ],
        },

        // --- MINIMUM HOURS FIELDS (existing behaviour) ---
        {
          name: 'minHours',
          type: 'select',
          label: 'Minimum Hours',
          required: true,
          defaultValue: '3',
          options: [
            { label: '1 hour', value: '1' },
            { label: '2 hours', value: '2' },
            { label: '3 hours', value: '3' },
            { label: '4 hours', value: '4' },
            { label: '5 hours', value: '5' },
            { label: '6 hours', value: '6' },
            { label: '7 hours', value: '7' },
            { label: '8 hours', value: '8' },
            { label: '9 hours', value: '9' },
            { label: '10 hours', value: '10' },
            { label: '12 hours', value: '12' },
            { label: '24 hours', value: '24' },
          ],
          admin: {
            condition: (_, siblingData) =>
              !siblingData?.ruleType || siblingData.ruleType === 'minHours',
            description: 'This controls the minimum number of hours when this rule applies.',
          },
        },

        // --- SPECIAL EVENT FIELDS (NEW) ---
        {
          name: 'specialEventName',
          type: 'text',
          label: 'Special Event Name',
          admin: {
            condition: (_, siblingData) => siblingData?.ruleType === 'specialEvent',
            description: 'e.g. New Year’s Eve, Eid Weekend, National Day, etc.',
          },
        },
        {
          name: 'dateMode',
          type: 'select',
          label: 'Select Day / All Days / Date',
          options: [
            {
              label: 'Use Day / All Days selection above',
              value: 'day',
            },
            {
              label: 'Specific Date or Date Range',
              value: 'date',
            },
          ],
          defaultValue: 'day',
          admin: {
            condition: (_, siblingData) => siblingData?.ruleType === 'specialEvent',
            description:
              'Choose whether this event uses day-based rules (e.g. weekends) or an exact date / date range.',
          },
        },
        {
          name: 'startDate',
          type: 'date',
          label: 'Start Date',
          admin: {
            condition: (_, siblingData) =>
              siblingData?.ruleType === 'specialEvent' && siblingData?.dateMode === 'date',
            date: {
              pickerAppearance: 'dayOnly',
            },
            description: 'Event start date (inclusive).',
          },
        },
        {
          name: 'endDate',
          type: 'date',
          label: 'End Date',
          admin: {
            condition: (_, siblingData) =>
              siblingData?.ruleType === 'specialEvent' && siblingData?.dateMode === 'date',
            date: {
              pickerAppearance: 'dayOnly',
            },
            description: 'Event end date (inclusive).',
          },
        },
        {
          name: 'packageHours',
          type: 'select',
          label: 'Package Hours',
          required: false,
          options: [
            { label: '1 hour', value: '1' },
            { label: '2 hours', value: '2' },
            { label: '3 hours', value: '3' },
            { label: '4 hours', value: '4' },
            { label: '5 hours', value: '5' },
            { label: '6 hours', value: '6' },
            { label: '8 hours', value: '8' },
            { label: '10 hours', value: '10' },
            { label: '12 hours', value: '12' },
          ],
          admin: {
            condition: (_, siblingData) => siblingData?.ruleType === 'specialEvent',
            description: 'How many hours are included in this special event package.',
          },
        },
        {
          name: 'packagePrice',
          type: 'number',
          label: 'Package Price (AED)',
          required: false,
          min: 0,
          admin: {
            condition: (_, siblingData) => siblingData?.ruleType === 'specialEvent',
            description:
              'Total price for the package (for the package hours). The system will derive an hourly rate from this.',
          },
        },
      ],
      admin: {
        initCollapsed: true,
        description: 'Set advanced minimum hour rules and special event packages.',
      },
      labels: {
        singular: 'Advanced Booking Rule',
        plural: 'Advanced Booking Rules',
      },
    },
    // Specifications
    {
      name: 'boatSpecifications',
      type: 'group',
      fields: [
        {
          name: 'type',
          type: 'select',
          options: [
            'Yacht',
            'Sailboat',
            'Speedboat',
            'Pontoon',
            'Catamaran',
            'Luxury Yachts',
            'Other',
          ],
          required: true,
          index: true,
        },
        /* {
          name: 'type',
          type: 'relationship',
          relationTo: 'boat-types',
          hasMany: false,
          required: true,
          index: true,
          admin: {
            description: 'Select the boat type',
          },
        }, */
        {
          name: 'manufacture',
          type: 'text',
          label: 'Year of Manufacture',
          required: true,
        },
        {
          name: 'refit',
          type: 'text',
          label: 'Year of Refit (optional)',
          required: false,
        },
        {
          name: 'length',
          type: 'text',
          required: true,
        },
        {
          name: 'capacity',
          type: 'number',
          label: 'Capacity',
          required: true,
        },
        {
          name: 'sleeps',
          type: 'text',
          required: true,
        },
        {
          name: 'bathrooms',
          type: 'text',
          label: 'Bathrooms/Toilets',
          required: true,
        },
        {
          name: 'crew',
          type: 'number',
          label: 'Number of Crew',
          required: false,
        },
        {
          name: 'description',
          type: 'textarea',
          admin: {
            description: 'Detailed description of the extra service',
          },
        },
      ],
    },

    // Features
    {
      name: 'keyFeatures',
      type: 'array',
      label: 'Key Features',
      fields: [
        {
          name: 'feature',
          type: 'text',
          required: true,
        },
        {
          name: 'included',
          type: 'checkbox',
          defaultValue: true,
        },
      ],
      admin: {
        initCollapsed: true,
      },
    },
    {
      name: 'amenities',
      type: 'array',
      fields: [
        {
          name: 'item',
          type: 'text',
          required: true,
        },
      ],
      admin: {
        initCollapsed: true,
      },
    },
    {
      name: 'additionalServices',
      type: 'array',
      fields: [
        {
          name: 'service',
          type: 'text',
          required: true,
        },
        {
          name: 'file',
          type: 'upload',
          relationTo: 'media',
        },
        {
          name: 'price',
          type: 'number',
        },
      ],
      admin: {
        initCollapsed: true,
      },
    },

    /* {
      name: 'extras',
      label: 'Available Extras',
      type: 'relationship',
      relationTo: 'extras',
      hasMany: true,
      admin: {
        description: 'Select extras available for this boat',
        allowCreate: true,
      },
    }, */

    {
      name: 'routes',
      type: 'relationship',
      relationTo: 'routes',
      required: false,
      label: 'Select Routes',
      admin: {
        allowCreate: true, // Change this to true to allow creating routes from boats
        description: 'Select predefined routes for this boat',
        isSortable: true, // Optional: allows reordering
      },
      hasMany: true,
      access: {
        read: () => true,
      },
    },
    {
      name: 'media',
      type: 'upload',
      relationTo: 'media',
      required: true,
      label: 'Featured Image',
    },
    {
      name: 'gallery',
      type: 'array',
      fields: [
        {
          name: 'image',
          type: 'upload',
          relationTo: 'media',
          required: true,
        },
      ],
    },
    {
      name: 'boatSpecific',
      type: 'array',
      label: 'Boat Specific FAQ',
      fields: [
        {
          name: 'faq',
          type: 'textarea',
          label: 'Boat-specific FAQ',
        },
      ],
    },
    {
      name: 'discounts',
      type: 'array',
      label: 'Discounts',
      fields: [
        {
          name: 'type',
          type: 'select',
          label: 'Discount Type',
          required: true,
          options: [
            { label: 'Fixed Discount', value: 'fixed' },
            { label: 'Percentage Discount', value: 'percentage' },
            { label: 'Buy X Get Y Free (B1G1)', value: 'b1g1' },
            { label: 'Bulk Fixed Discount', value: 'bulk_fixed' },
            { label: 'Bulk Percentage Discount', value: 'bulk_percentage' },
          ],
          defaultValue: 'fixed',
          admin: {
            description: 'Only one Fixed or Percentage discount can be active at a time.',
          },
        },
        {
          name: 'variable',
          type: 'number',
          label: 'Variable (X)',
          admin: {
            condition: (_, siblingData) =>
              ['b1g1', 'bulk_fixed', 'bulk_percentage'].includes(siblingData?.type),
          },
          min: 1,
        },
        {
          name: 'amount',
          type: 'number',
          label: 'Amount/Discount',
          required: true,
          min: 0,
          admin: {
            description: 'Enter amount - fixed value or percentage based on discount type',
          },
        },
        {
          name: 'startDate',
          type: 'date',
          label: 'Start Date',
          required: true,
          admin: {
            date: { pickerAppearance: 'dayOnly' },
          },
        },
        {
          name: 'endDate',
          type: 'date',
          label: 'End Date',
          required: true,
          admin: {
            date: { pickerAppearance: 'dayOnly' },
          },
        },
      ],
      admin: {
        initCollapsed: true,
        description: 'Note: Only one Fixed or Percentage discount can be active at a time.',
      },
      labels: {
        singular: 'Discount',
        plural: 'Discounts',
      },
      hooks: {
        beforeValidate: [
          ({ value }) => {
            if (!value || !Array.isArray(value)) return value

            const fixedDiscounts = value.filter((d: any) => d?.type === 'fixed')
            const percentageDiscounts = value.filter((d: any) => d?.type === 'percentage')

            if (fixedDiscounts.length > 0 && percentageDiscounts.length > 0) {
              throw new Error(
                'Cannot have both Fixed and Percentage discounts active at the same time. Please remove one.',
              )
            }

            return value
          },
        ],
      },
    },
    {
      name: 'surgePricing',
      type: 'text',
      label: 'Surge Pricing',
    },
    {
      name: 'averageRating',
      type: 'number',
      min: 0,
      max: 5,
      defaultValue: 0,
      admin: {
        description: 'Automatically calculated average rating',
        readOnly: true,
      },
    },
    {
      name: 'reviewCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Total approved reviews',
        readOnly: true,
      },
    },

    {
      name: 'specialEventTags',
      type: 'relationship',
      label: 'Special Event Tags',
      relationTo: 'event-types',
      hasMany: true,
      admin: {
        initCollapsed: true,
      },
    } as Field,
    /* {
      name: 'coupons',
      type: 'array',
      label: 'Coupons',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'code',
          type: 'text',
          required: true,
          unique: true,
        },
        {
          name: 'type',
          type: 'select',
          required: true,
          options: [
            { label: 'Percentage Discount', value: 'percentage' },
            { label: 'Fixed Amount Discount', value: 'fixed' },
          ],
        },
        {
          name: 'amount',
          type: 'number',
          required: true,
          min: 1,
        },
        {
          name: 'usageCount',
          type: 'number',
          defaultValue: 0,
          admin: { readOnly: true },
        },
        {
          name: 'isActive',
          type: 'checkbox',
          defaultValue: true,
        },
        {
          name: 'expiresAt',
          type: 'date',
          required: false,
        },
      ],
    }, */
  ],
}

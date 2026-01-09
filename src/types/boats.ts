export interface BoatMedia {
  id: string
  url: string
  alt?: string
  width?: number
  height?: number
}

export interface BoatLocation {
  id: string
  city: string
  country: string
  harbour: string
  name: string
}

export interface Discount {
  type: string
  amount: number
  startDate: string
  endDate: string
  variable?: number
}

export interface RoutePoint {
  point: string
  id?: string
}

export interface HourRoute {
  duration: string
  points: RoutePoint[]
  id?: string
}

export interface Route {
  id: string
  routeName: string
  location: string | BoatLocation
  hourRoutes: HourRoute[]
  createdAt: string
  updatedAt: string
}

export interface EventTypeTaxonomy {
  id: string
  label: string
  slug?: string
  priority?: number
}

export interface Extra {
  id: string
  category: string
  name: string
  description: any
  itemsDetails: BoatMedia | string
  minimumNumberOfPax: {
    min: number
    max: number
  }
  unitPrice: number
  dependentItems?: (string | Extra)[]
  boat?: (string | { id?: string })[]
  isDependentOnly?: boolean
}

export type Coupon = {
  id: string
  code: string
  type: 'percentage' | 'fixed'
  amount: number
}

export interface Boat {
  minHours: number
  id: string
  name: string
  slug: string
  specialEventTags?: Array<string | EventTypeTaxonomy>
  type: string
  description: string
  price: number
  salePrice: number
  minCapacity: number
  maxCapacity: number
  location: BoatLocation | string
  media: BoatMedia
  gallery: BoatMedia[]
  boatSpecifications: {
    type: string
    manufacture: string
    refit?: string
    length: string
    capacity: number
    sleeps: string
    bathrooms: string
    crew?: number
    description: string
  }
  keyHighlights: Array<{ feature: string; included: boolean }>
  amenities: Array<{ item: string }>
  additionalServices?: Array<{
    service: string
    file?: any
    price?: number
  }>
  routes: (string | Route)[]
  extras: Extra[]
  createdAt: string
  updatedAt: string
  averageRating: number
  reviewCount: number
  specialEventTag: any
  priceDay: number
  surgePricing?: string
  advancedMinHours?: Array<{
    ruleType?: 'minHours' | 'specialEvent' | 'specialEventDay'
  
    // date-type info can come in different flavours
    dateMode?: 'day' | 'date'
    dateType?: 'days' | 'range' | 'date'
  
    days?: string[]
    timeRange: {
      type: 'allDay' | 'custom'
      startTime?: string
      endTime?: string
    }
  
    // min-hours logic
    minHours?: string
  
    // special event fields
    specialEventName?: string
    startDate?: string
    endDate?: string
    packageHours?: string | number
    packagePrice?: string | number
  }>  
  discounts?: Discount[]
  /* coupons?: Array<{
    code: string
    type: 'percentage' | 'fixed'
    amount: number
    isActive: boolean
  }> */
}

export function isPopulatedExtra(extra: string | Extra): extra is Extra {
  return typeof extra === 'object' && extra !== null && 'id' in extra
}

export function isPopulatedMedia(media: string | BoatMedia): media is BoatMedia {
  return typeof media === 'object' && media !== null && 'url' in media
}

export function isPopulatedRoute(route: string | Route): route is Route {
  return typeof route === 'object' && route !== null && 'id' in route
}

export const getBlobUrl = (media: any): string => {
    if (!media) return ''
    
    // If media is a string (ID), we can't get the URL directly
    if (typeof media === 'string') {
      return '' // You'll need to fetch the media document first
    }
    
    // If media is a populated document
    return media.blobUrl || ''
  }
  
  export const getImageSizes = (media: any) => {
    if (!media) return {}
    
    return {
      width: media.width || null,
      height: media.height || null,
    }
  }
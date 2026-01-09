// types/icon.d.ts
import { LucideIcon } from 'lucide-react'

declare module '@components/ui/Icon' {
  export interface IconProps {
    name: keyof typeof import('./Icon').icons
    className?: string
  }

  declare const Icon: React.FC<IconProps>
  export default Icon
}

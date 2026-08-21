import type { RendererApi } from '../../shared/types'

export type { RendererApi }

declare global {
  interface Window {
    api: RendererApi
  }
}

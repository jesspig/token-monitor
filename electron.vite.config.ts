import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const p = id.replace(/\\/g, '/')
            if (!p.includes('/node_modules/')) return undefined
            if (/recharts|d3-|victory-vendor/.test(p)) return 'charts'
            if (p.includes('@tanstack')) return 'query'
            if (/\/(react|react-dom|scheduler)\//.test(p)) return 'vendor'
            return undefined
          }
        }
      }
    }
  }
})

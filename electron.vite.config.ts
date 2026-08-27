import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 多入口：index = 主进程入口；zstd-worker = dsh 插件的解压线程；
        // query-worker = 统计查询只读线程（两者均以 entry 名即产物文件名输出，
        // 运行时经 new Worker(join(__dirname, '*.js'), { workerData }) 拉起）
        input: {
          index: resolve('src/main/index.ts'),
          'zstd-worker': resolve('src/main/workers/zstd-worker.ts'),
          'query-worker': resolve('src/main/workers/query-worker.ts')
        }
      }
    }
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

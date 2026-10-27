import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { dockerTracerBackendPlugin } from './server/tracerServer.ts'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    dockerTracerBackendPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '5174', 10),
  },
  preview: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '5174', 10),
  },
})

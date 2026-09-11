import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/uipath-release-notes-portal/', // Make sure to include the forward slashes!
})

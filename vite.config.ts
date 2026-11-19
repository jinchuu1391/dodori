import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 상대 경로로 빌드해서 GitHub Pages의 /<저장소이름>/ 하위 경로에서도 그대로 동작하게 한다
  base: './',
  server: { port: 5173 },
})

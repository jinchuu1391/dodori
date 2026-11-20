import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 상대 경로로 빌드해서 GitHub Pages의 /<저장소이름>/ 하위 경로에서도 그대로 동작하게 한다
  base: './',
  server: { port: 5173 },
  // 박 감지 워커(Essentia)를 모듈 워커로 — 버튼을 누를 때만 따로 내려받는다
  worker: { format: 'es' },
  // 워커에서만 쓰는 의존성은 개발 서버가 처음 쓸 때 발견하고 페이지를 새로고침한다(분석 중 상태가 날아감).
  // 시작할 때 미리 묶어 둔다
  optimizeDeps: { include: ['essentia.js/dist/essentia-wasm.es.js', 'essentia.js/dist/essentia.js-core.es.js'] },
})

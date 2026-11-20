import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { engine } from './audio/engine'
import { usePlayer } from './store/usePlayer'
import './styles.css'

// 개발 모드에서만: e2e 테스트가 앱과 같은 엔진·스토어 인스턴스를 들여다보게 한다.
// (import('/src/…')로 가져오면 핫 리로드를 거친 서버에선 ?t= 붙은 다른 사본이 잡힌다)
if (import.meta.env.DEV) {
  ;(window as unknown as { __dodori: unknown }).__dodori = { engine, usePlayer }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

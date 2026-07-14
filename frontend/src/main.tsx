import React from 'react'
import ReactDOM from 'react-dom/client'
import '@/styles/global.css'

async function bootstrap() {
  // 仅当 VITE_MOCK=true 时启用 MSW mock，否则直接请求后端
  if (import.meta.env.VITE_MOCK === 'true') {
    const { worker } = await import('@/mocks/browser')
    await worker.start({ onUnhandledRequest: 'bypass' })
  }

  const { default: App } = await import('@/app/App')

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

bootstrap()

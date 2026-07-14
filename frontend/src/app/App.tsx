import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'

import { SessionProvider } from '@/features/auth/useSession'
import { AppRouter } from '@/routes/AppRouter'
import { appTheme } from '@/styles/theme'

export default function App() {
  return (
    <ConfigProvider theme={appTheme} locale={zhCN}>
      <AntApp>
        <SessionProvider>
          <AppRouter />
        </SessionProvider>
      </AntApp>
    </ConfigProvider>
  )
}

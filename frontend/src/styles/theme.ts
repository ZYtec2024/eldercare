import type { ThemeConfig } from 'antd'

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb',
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',
    colorText: '#1e293b',
    colorBgLayout: '#f8fafc',
    colorBgContainer: '#ffffff',
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif',
    borderRadius: 10,
    fontSize: 14,
    lineHeight: 1.6,
  },
  components: {
    Layout: {
      bodyBg: '#f8fafc',
      siderBg: '#1e3a5f',
      headerBg: '#ffffff',
    },
    Button: {
      controlHeight: 40,
      paddingInline: 20,
      borderRadius: 8,
    },
    Card: {
      borderRadiusLG: 12,
    },
    Menu: {
      darkItemBg: '#1e3a5f',
      darkSubMenuItemBg: '#1e40af',
    },
  },
}

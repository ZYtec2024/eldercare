import type { ThemeConfig } from 'antd'

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb',
    colorSuccess: '#10b981',
    colorWarning: '#f59e0b',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',
    colorText: '#1e293b',
    colorBgLayout: '#f1f5f9',
    colorBgContainer: '#ffffff',
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif',
    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    fontSize: 14,
    lineHeight: 1.6,
    boxShadow:
      '0 1px 3px rgba(15, 23, 42, .06), 0 1px 2px rgba(15, 23, 42, .04)',
    boxShadowSecondary:
      '0 4px 16px rgba(15, 23, 42, .08)',
  },
  components: {
    Layout: {
      bodyBg: '#f1f5f9',
      siderBg: '#0f172a',
      headerBg: '#ffffff',
    },
    Button: {
      controlHeight: 40,
      paddingInline: 20,
      borderRadius: 10,
      borderRadiusLG: 12,
    },
    Card: {
      borderRadiusLG: 16,
      paddingLG: 24,
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: '#1e293b',
      itemBorderRadius: 10,
    },
    Breadcrumb: {
      lastItemColor: '#64748b',
      linkColor: '#94a3b8',
      linkHoverColor: '#2563eb',
    },
  },
}

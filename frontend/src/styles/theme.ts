import type { ThemeConfig } from 'antd'

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#3b82f6',
    colorSuccess: '#2563eb',
    colorWarning: '#c27a20',
    colorError: '#c6534d',
    colorInfo: '#3b82f6',
    colorText: '#172431',
    colorTextSecondary: '#687887',
    colorBorder: '#d9e3e8',
    colorBorderSecondary: '#e4ebef',
    colorBgLayout: '#eef3f6',
    colorBgContainer: '#ffffff',
    fontFamily:
      '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans SC", system-ui, sans-serif',
    borderRadius: 10,
    borderRadiusLG: 12,
    borderRadiusSM: 8,
    fontSize: 14,
    lineHeight: 1.6,
    boxShadow:
      '0 1px 3px rgba(25, 48, 60, .05)',
    boxShadowSecondary:
      '0 10px 28px rgba(25, 48, 60, .09)',
  },
  components: {
    Layout: {
      bodyBg: '#eef3f6',
      siderBg: '#f7fafb',
      headerBg: '#ffffff',
    },
    Button: {
      controlHeight: 40,
      paddingInline: 20,
      borderRadius: 10,
      borderRadiusLG: 12,
    },
    Card: {
      borderRadiusLG: 12,
      paddingLG: 20,
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#647482',
      itemHoverColor: '#2563eb',
      itemHoverBg: '#eff6ff',
      itemSelectedColor: '#1d4ed8',
      itemSelectedBg: '#dbeafe',
      itemBorderRadius: 8,
    },
    Breadcrumb: {
      lastItemColor: '#64748b',
      linkColor: '#94a3b8',
      linkHoverColor: '#2563eb',
    },
  },
}

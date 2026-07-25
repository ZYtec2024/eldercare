export type BrowserGeoFix = {
  lng: number
  lat: number
  accuracyMeters: number
  /** true = browser WGS-84 (backend should convert to GCJ-02); false = already GCJ-02 */
  fromGps: boolean
  source: 'amap' | 'browser'
}

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode?: string }
  }
}

let amapGeoLoader: Promise<any> | null = null

/** Prefer fixes at least this good; network/IP is usually far worse. */
const GOOD_ACCURACY_M = 120
const NETWORK_ONLY_WHEN_WORSE_THAN_M = 500

function pageOriginHint() {
  if (typeof window === 'undefined') return 'http://localhost:3000'
  return window.location.origin
}

function isLocalHostName(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

function insecureContextMessage() {
  const host = typeof window !== 'undefined' ? window.location.hostname : ''
  const origin = pageOriginHint()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return (
      `当前用局域网地址 ${origin} 打开，浏览器禁止定位（不是没点允许）。`
      + '演示请改用本机 http://localhost:3000，或把站点部署到 HTTPS 域名后再测手机'
    )
  }
  return (
    `当前页面不是安全上下文（${origin}），浏览器禁止定位。`
    + '请用 http://localhost:3000 或 HTTPS 域名打开'
  )
}

function edgeDeniedMessage(permission: PermissionState | 'unsupported') {
  const origin = pageOriginHint()
  return (
    `Edge 未授权本站定位（权限状态：${permission}，地址：${origin}）。`
    + '注意：Cursor 浏览器和 Edge 的权限是分开的，一边允许不等于另一边允许。'
    + `请打开 edge://settings/content/location ，把「${origin}」从「阻止」删掉并改为允许；`
    + 'Windows「设置 → 隐私和安全性 → 位置」里也要允许 Microsoft Edge。'
    + '改完后务必 Ctrl+F5。也可继续用默认地址'
  )
}

function windowsLocationHint() {
  return (
    '系统定位未开启。请到 Windows「设置 → 隐私和安全性 → 位置」开启「位置服务」'
    + '和「让桌面应用访问你的位置」，并允许 Microsoft Edge；也可继续使用默认地址'
  )
}

async function readGeolocationPermission(): Promise<PermissionState | 'unsupported'> {
  try {
    if (!navigator.permissions?.query) return 'unsupported'
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
    return status.state
  } catch {
    return 'unsupported'
  }
}

function toBrowserFix(position: GeolocationPosition): BrowserGeoFix {
  return {
    lng: position.coords.longitude,
    lat: position.coords.latitude,
    accuracyMeters: Math.max(1, Math.round(position.coords.accuracy || 9999)),
    fromGps: true,
    source: 'browser',
  }
}

function pickBetter(a: BrowserGeoFix | null, b: BrowserGeoFix | null): BrowserGeoFix | null {
  if (!a) return b
  if (!b) return a
  return a.accuracyMeters <= b.accuracyMeters ? a : b
}

function getCurrentBrowserLocation(
  timeoutMs: number,
  enableHighAccuracy: boolean,
): Promise<BrowserGeoFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('当前浏览器暂不支持定位'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(toBrowserFix(position)),
      (error) => reject(error),
      {
        enableHighAccuracy,
        timeout: timeoutMs,
        maximumAge: 0,
      },
    )
  })
}

/**
 * Take a short watch sample and keep the best accuracy reading.
 * Desktop Edge often improves from ~150m → ~80m within a few seconds.
 */
function watchBestBrowserLocation(timeoutMs: number): Promise<BrowserGeoFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('当前浏览器暂不支持定位'))
      return
    }
    let best: BrowserGeoFix | null = null
    let settled = false
    const finish = (value?: BrowserGeoFix, error?: GeolocationPositionError) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      try {
        navigator.geolocation.clearWatch(watchId)
      } catch {
        // ignore
      }
      if (value) {
        resolve(value)
        return
      }
      reject(error || new Error('定位暂时不可用'))
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix = toBrowserFix(position)
        best = pickBetter(best, fix)
        if (fix.accuracyMeters <= GOOD_ACCURACY_M) {
          finish(fix)
        }
      },
      (error) => {
        if (best) finish(best)
        else finish(undefined, error)
      },
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 0,
      },
    )
    const timer = window.setTimeout(() => {
      if (best) finish(best)
      else {
        finish(undefined, {
          code: 3,
          message: 'Timeout',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        } as GeolocationPositionError)
      }
    }, timeoutMs)
  })
}

function loadAmapForGeolocation(): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap)
  if (amapGeoLoader) return amapGeoLoader
  const key = import.meta.env.VITE_AMAP_KEY
  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE
  amapGeoLoader = new Promise((resolve, reject) => {
    if (!key || !securityJsCode) {
      reject(new Error('未配置高德地图 Key'))
      return
    }
    window._AMapSecurityConfig = { securityJsCode }
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&plugin=AMap.Geolocation`
    script.async = true
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('高德地图加载失败')))
    script.onerror = () => reject(new Error('无法连接高德地图服务'))
    document.head.appendChild(script)
  })
  return amapGeoLoader
}

type AmapLocateMode = 'precise' | 'network'

function captureAmapLocation(timeoutMs: number, mode: AmapLocateMode): Promise<BrowserGeoFix> {
  const precise = mode === 'precise'
  return loadAmapForGeolocation().then(
    (AMap) =>
      new Promise((resolve, reject) => {
        AMap.plugin('AMap.Geolocation', () => {
          const geo = new AMap.Geolocation({
            enableHighAccuracy: precise,
            timeout: timeoutMs,
            convert: true,
            showButton: false,
            showMarker: false,
            showCircle: false,
            panToLocation: false,
            zoomToAccuracy: false,
            // precise may still ask H5; network must not, or Edge-denied sites never get IP fallback
            GeoLocationFirst: precise,
            noIpLocate: precise ? 1 : 0,
            maximumAge: 0,
            needAddress: false,
          })
          geo.getCurrentPosition((status: string, result: any) => {
            const lng = Number(result?.position?.lng ?? result?.position?.[0])
            const lat = Number(result?.position?.lat ?? result?.position?.[1])
            if (status !== 'complete' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
              reject(new Error(String(result?.message || result?.info || '高德定位失败')))
              return
            }
            const accuracyMeters = Math.max(
              1,
              Math.round(Number(result?.accuracy) || (precise ? 80 : 5000)),
            )
            resolve({
              lng,
              lat,
              accuracyMeters,
              fromGps: false,
              source: 'amap',
            })
          })
        })
      }),
  )
}

function mapBrowserError(
  error: GeolocationPositionError | null | undefined,
  permission: PermissionState | 'unsupported',
) {
  if (typeof window !== 'undefined' && !window.isSecureContext && !isLocalHostName(window.location.hostname)) {
    return new Error(insecureContextMessage())
  }
  if (permission === 'denied' || error?.code === 1) {
    const msg = String(error?.message || '')
    if (msg.toLowerCase().includes('windows') || msg.includes('系统')) {
      return new Error(windowsLocationHint())
    }
    return new Error(edgeDeniedMessage(permission))
  }
  if (error?.code === 3) return new Error('定位超时，请到窗边重试或改用默认地址')
  return new Error('定位暂时不可用，请重试或改用默认地址')
}

/**
 * Accuracy-first strategy:
 * 1) Browser high-accuracy GPS (+ short watch)
 * 2) Precise AMap if tighter
 * 3) Network/IP last resort (also used when Edge site permission is denied)
 */
export async function captureBrowserLocation(options?: {
  timeoutMs?: number
}): Promise<BrowserGeoFix> {
  const timeoutMs = options?.timeoutMs ?? 15_000

  if (typeof window !== 'undefined' && !window.isSecureContext && !isLocalHostName(window.location.hostname)) {
    throw new Error(insecureContextMessage())
  }

  const permission = await readGeolocationPermission()
  let lastBrowserError: GeolocationPositionError | null = null
  const browserAllowed = permission !== 'denied'
  let best: BrowserGeoFix | null = null

  if (browserAllowed) {
    try {
      best = await watchBestBrowserLocation(Math.min(timeoutMs, 12_000))
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err) {
        lastBrowserError = err as GeolocationPositionError
      }
      try {
        best = await getCurrentBrowserLocation(timeoutMs, true)
      } catch (err2) {
        if (err2 && typeof err2 === 'object' && 'code' in err2) {
          lastBrowserError = err2 as GeolocationPositionError
        }
        try {
          best = await getCurrentBrowserLocation(Math.min(timeoutMs, 8_000), false)
        } catch (err3) {
          if (err3 && typeof err3 === 'object' && 'code' in err3) {
            lastBrowserError = err3 as GeolocationPositionError
          }
        }
      }
    }

    try {
      const amapPrecise = await captureAmapLocation(Math.min(timeoutMs, 10_000), 'precise')
      best = pickBetter(best, amapPrecise)
    } catch {
      // ignore
    }

    if (best && best.accuracyMeters <= NETWORK_ONLY_WHEN_WORSE_THAN_M) {
      return best
    }
  } else {
    // Edge previously clicked “禁止”: H5 GPS will never work; jump to IP/network locate.
    try {
      const network = await captureAmapLocation(Math.min(timeoutMs, 12_000), 'network')
      if (network) return network
    } catch {
      // fall through to clear Edge-specific guidance
    }
    throw new Error(edgeDeniedMessage(permission))
  }

  try {
    const network = await captureAmapLocation(Math.min(timeoutMs, 12_000), 'network')
    best = pickBetter(best, network)
    if (best) return best
  } catch (amapErr) {
    if (best) return best
    const amapMsg = amapErr instanceof Error ? amapErr.message : ''
    if (amapMsg.includes('INVALID_USER_DOMAIN') || amapMsg.includes('USERKEY') || amapMsg.includes('KEY')) {
      throw new Error(
        '高德 Key 域名未放行。演示用 localhost 时请在高德控制台把 JS Key 的域名白名单清空/不校验；'
        + '同时确认 Edge 对本站位置为允许',
      )
    }
    throw mapBrowserError(lastBrowserError, permission)
  }

  if (best) return best
  throw mapBrowserError(lastBrowserError, permission)
}

export function formatAccuracyHint(accuracyMeters: number | null | undefined, source?: BrowserGeoFix['source']) {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters)) return ''
  const via = source === 'amap' ? '高德' : source === 'browser' ? '浏览器' : ''
  const prefix = via ? `${via}定位，` : ''
  if (accuracyMeters <= 40) return `${prefix}约 ±${accuracyMeters} 米`
  if (accuracyMeters >= 500) return `${prefix}约 ±${accuracyMeters} 米（偏粗，请允许浏览器位置并到窗边重试）`
  return `${prefix}约 ±${accuracyMeters} 米`
}

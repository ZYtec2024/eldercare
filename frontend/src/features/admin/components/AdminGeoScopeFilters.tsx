import { useEffect, useMemo, useState } from 'react'
import { Cascader } from 'antd'

import { useSession } from '@/features/auth/useSession'
import { fetchAdminDispatchRegions, fetchManagedDispatchRegions } from '@/services/adapters/dispatch-adapter'

export type AdminGeoScope = {
  regionAdcode?: string
  provinceName?: string
  cityName?: string
}

type RegionOption = {
  adcode: string
  name: string
  province_name?: string
  city_name?: string
}

type CascaderOption = {
  value: string
  label: string
  children?: CascaderOption[]
}

type Props = {
  value: AdminGeoScope
  onChange: (next: AdminGeoScope) => void
  className?: string
}

const NATIONAL = '__national__'

/** Single cascader: 全国 → 省 → 市 → 区县. Pick any level to filter. */
export function AdminGeoScopeFilters({ value, onChange, className }: Props) {
  const { session } = useSession()
  const isRoot = Boolean(session?.isRoot)
  const [regions, setRegions] = useState<RegionOption[]>([])

  useEffect(() => {
    if (!session || session.role !== 'admin') return
    if (isRoot) {
      fetchManagedDispatchRegions(session.userId)
        .then((items) => {
          setRegions(items.map((item) => ({
            adcode: item.adcode,
            name: item.name,
            province_name: item.province_name,
            city_name: item.city_name,
          })))
        })
        .catch(() => setRegions([]))
      return
    }
    fetchAdminDispatchRegions(session.userId)
      .then((items) => {
        setRegions(items)
        if (items.length === 1 && !value.regionAdcode) {
          onChange({ regionAdcode: items[0].adcode })
        }
      })
      .catch(() => setRegions([]))
  }, [session?.userId, isRoot])

  const options = useMemo((): CascaderOption[] => {
    if (!isRoot) {
      return [
        { value: NATIONAL, label: '全部管辖区' },
        ...regions.map((region) => ({ value: region.adcode, label: region.name })),
      ]
    }

    const byProvince = new Map<string, Map<string, RegionOption[]>>()
    for (const region of regions) {
      const province = region.province_name || '未分区'
      const city = region.city_name || province
      if (!byProvince.has(province)) byProvince.set(province, new Map())
      const cities = byProvince.get(province)!
      if (!cities.has(city)) cities.set(city, [])
      cities.get(city)!.push(region)
    }

    const provinceNodes: CascaderOption[] = Array.from(byProvince.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
      .map(([province, cities]) => ({
        value: `p:${province}`,
        label: province,
        children: Array.from(cities.entries())
          .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
          .map(([city, districts]) => ({
            value: `c:${city}`,
            label: city,
            children: districts
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
              .map((district) => ({
                value: district.adcode,
                label: district.name,
              })),
          })),
      }))

    return [{ value: NATIONAL, label: '全国' }, ...provinceNodes]
  }, [regions, isRoot])

  const cascaderValue = useMemo(() => {
    if (!value.regionAdcode && !value.provinceName && !value.cityName) {
      return [NATIONAL]
    }
    if (!isRoot) {
      return value.regionAdcode ? [value.regionAdcode] : [NATIONAL]
    }
    if (value.regionAdcode) {
      const hit = regions.find((item) => item.adcode === value.regionAdcode)
      if (hit?.province_name && hit.city_name) {
        return [`p:${hit.province_name}`, `c:${hit.city_name}`, hit.adcode]
      }
      return [value.regionAdcode]
    }
    if (value.provinceName && value.cityName) {
      return [`p:${value.provinceName}`, `c:${value.cityName}`]
    }
    if (value.provinceName) {
      return [`p:${value.provinceName}`]
    }
    return [NATIONAL]
  }, [value, isRoot, regions])

  const handleChange = (path: (string | number)[] | undefined) => {
    const values = (path ?? []).map(String)
    if (!values.length || values[0] === NATIONAL) {
      onChange({})
      return
    }
    if (!isRoot) {
      onChange({ regionAdcode: values[0] })
      return
    }
    const province = values[0]?.startsWith('p:') ? values[0].slice(2) : undefined
    const city = values[1]?.startsWith('c:') ? values[1].slice(2) : undefined
    const district = values[2]
    if (district) {
      onChange({ provinceName: province, cityName: city, regionAdcode: district })
      return
    }
    if (city) {
      onChange({ provinceName: province, cityName: city })
      return
    }
    if (province) {
      onChange({ provinceName: province })
    }
  }

  if (!session || session.role !== 'admin') return null

  return (
    <Cascader
      className={className ?? 'min-w-56'}
      options={options}
      value={cascaderValue}
      onChange={handleChange}
      changeOnSelect
      allowClear={false}
      expandTrigger="hover"
      displayRender={(labels) => labels.join(' / ')}
      placeholder="全国 → 省 → 市 → 区"
    />
  )
}

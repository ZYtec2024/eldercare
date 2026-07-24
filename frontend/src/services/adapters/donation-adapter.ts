import { http, type ApiEnvelope } from '@/services/http'

export interface DonationRecord {
  donation_id: number
  donor_name: string
  contact?: string
  amount: number
  payment_method: 'wechat' | 'alipay'
  payment_status: string
  transaction_no: string
  message?: string
  created_at: string
}

export async function simulateDonation(payload: {
  donorName: string
  contact?: string
  amount: number
  paymentMethod: 'wechat' | 'alipay'
  message?: string
}) {
  const response = await http.post<ApiEnvelope<DonationRecord>>('/public/donations/simulate', {
    donor_name: payload.donorName,
    contact: payload.contact,
    amount: payload.amount,
    payment_method: payload.paymentMethod,
    message: payload.message,
  })
  return response.data
}

export async function fetchDonations(adminUserId: number, page = 1, pageSize = 20) {
  const response = await http.get<ApiEnvelope<{
    items: DonationRecord[]
    total: number
    total_amount: number
    page: number
    page_size: number
  }>>('/admin/donations', {
    params: { admin_user_id: adminUserId, page, limit: pageSize },
  })
  return response.data.data
}

import { lazy } from 'react'

export const HomePage = lazy(() => import('@/features/home/pages/HomePage'))
export const LoginPage = lazy(() => import('@/features/auth/pages/LoginPage'))
export const RegisterPage = lazy(() => import('@/features/auth/pages/RegisterPage'))
export const DonationPage = lazy(() => import('@/features/donation/pages/DonationPage'))
export const ForgotPasswordPage = lazy(() => import('@/features/auth/pages/ForgotPasswordPage'))
export const ProfilePage = lazy(() => import('@/features/profile/pages/ProfilePage'))
export const ConversationPage = lazy(() => import('@/features/conversation/pages/ConversationPage'))

export const FamilyDashboardPage = lazy(() => import('@/features/family/pages/FamilyDashboardPage'))
export const BindElderPage = lazy(() => import('@/features/family/pages/BindElderPage'))
export const ElderDetailPage = lazy(() => import('@/features/family/pages/ElderDetailPage'))
export const NewServiceRequestPage = lazy(() => import('@/features/family/pages/NewServiceRequestPage'))
export const FamilyOrdersPage = lazy(() => import('@/features/family/pages/FamilyOrdersPage'))
export const FamilyAlertsPage = lazy(() => import('@/features/family/pages/FamilyAlertsPage'))
export const FamilyLiveTrackingPage = lazy(() => import('@/features/family/pages/FamilyLiveTrackingPage'))

export const ElderDashboardPage = lazy(() => import('@/features/elder/pages/ElderDashboardPage'))
export const ElderCheckinPage = lazy(() => import('@/features/elder/pages/ElderCheckinPage'))
export const ElderServicesPage = lazy(() => import('@/features/elder/pages/ElderServicesPage'))
export const ElderSosPage = lazy(() => import('@/features/elder/pages/ElderSosPage'))
export const ElderDispatchPage = lazy(() => import('@/features/elder/pages/ElderDispatchPage'))

export const VolunteerTasksPage = lazy(() => import('@/features/volunteer/pages/VolunteerTasksPage'))
export const VolunteerTaskDetailPage = lazy(() => import('@/features/volunteer/pages/VolunteerTaskDetailPage'))
export const VolunteerProfilePage = lazy(() => import('@/features/volunteer/pages/VolunteerProfilePage'))
export const VolunteerLeaderboardPage = lazy(() => import('@/features/volunteer/pages/VolunteerLeaderboardPage'))
export const VolunteerDashboardPage = lazy(() => import('@/features/volunteer/pages/VolunteerDashboardPage'))
export const VolunteerDispatchPage = lazy(() => import('@/features/volunteer/pages/VolunteerDispatchPage'))

export const AdminDashboardPage = lazy(() => import('@/features/admin/pages/AdminDashboardPage'))
export const AdminHourReviewsPage = lazy(() => import('@/features/admin/pages/AdminHourReviewsPage'))
export const AdminUsersPage = lazy(() => import('@/features/admin/pages/AdminUsersPage'))
export const AdminDonationsPage = lazy(() => import('@/features/admin/pages/AdminDonationsPage'))
export const AdminAlertsPage = lazy(() => import('@/features/admin/pages/AdminAlertsPage'))
export const AdminHomePage = lazy(() => import('@/features/admin/pages/AdminHomePage'))
export const AdminDispatchBoardPage = lazy(() => import('@/features/admin/pages/AdminDispatchBoardPage'))
export const AdminRegionsPage = lazy(() => import('@/features/admin/pages/AdminRegionsPage'))

export const HealthKnowledgePage = lazy(() => import('@/features/home/pages/HealthKnowledgePage'))

export const PublicTaskHallPage = lazy(() => import('@/features/public/pages/PublicTaskHallPage'))

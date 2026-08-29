import { Suspense, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { CompanySlugProvider } from "@/contexts/CompanySlugContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import PublicPageSkeleton from "@/components/PublicPageSkeleton";
import CompanyFeatureRouteGate from "@/components/company/CompanyFeatureRouteGate";
import { supabase } from "@/integrations/supabase/client";
import { useCompanyPermissions } from "@/hooks/useCompanyPermissions";
import type { AppRole, CompanyPanelPermission } from "@/lib/companyPermissions";
import type { CompanyFeatureKey } from "@/lib/companyFeatures";
import { lazyWithReload } from "@/lib/lazyReload";

const Dashboard = lazyWithReload(() => import("@/pages/Dashboard"));
const DemandConversionReport = lazyWithReload(() => import("@/pages/DemandConversionReport"));
const AttendanceLossesReport = lazyWithReload(() => import("@/pages/AttendanceLossesReport"));
const OccupancyCapacityReport = lazyWithReload(() => import("@/pages/OccupancyCapacityReport"));
const CustomerRecurrenceReport = lazyWithReload(() => import("@/pages/CustomerRecurrenceReport"));
const Reservations = lazyWithReload(() => import("@/pages/Reservations"));
const TableMap = lazyWithReload(() => import("@/pages/TableMap"));
const CalendarView = lazyWithReload(() => import("@/pages/CalendarView"));
const Companies = lazyWithReload(() => import("@/pages/Companies"));
const SettingsPage = lazyWithReload(() => import("@/pages/Settings"));
const AdminNotifications = lazyWithReload(() => import("@/pages/AdminNotifications"));
const AuditLogs = lazyWithReload(() => import("@/pages/AuditLogs"));
const AdminIntegrations = lazyWithReload(() => import("@/pages/AdminIntegrations"));
const AdminFinance = lazyWithReload(() => import("@/pages/AdminFinance"));
const AdminCompanyBillingPreview = lazyWithReload(() => import("@/pages/AdminCompanyBillingPreview"));
const CompanySettings = lazyWithReload(() => import("@/pages/CompanySettings"));
const CompanyEvents = lazyWithReload(() => import("@/pages/CompanyEvents"));
const CompanyAutomations = lazyWithReload(() => import("@/pages/CompanyAutomations"));
const CompanyPrepayments = lazyWithReload(() => import("@/pages/CompanyPrepayments"));
const CompanyBilling = lazyWithReload(() => import("@/pages/CompanyBilling"));
const CompanyUsers = lazyWithReload(() => import("@/pages/CompanyUsers"));
const CompanyWaitlist = lazyWithReload(() => import("@/pages/CompanyWaitlist"));
const OperatorTodayReservations = lazyWithReload(() => import("@/pages/OperatorTodayReservations"));
const PublicWaitlistPage = lazyWithReload(() => import("@/pages/PublicWaitlistPage"));
const WaitlistTracking = lazyWithReload(() => import("@/pages/WaitlistTracking"));
const ReservationTracking = lazyWithReload(() => import("@/pages/ReservationTracking"));
const PublicReservationPayment = lazyWithReload(() => import("@/pages/PublicReservationPayment"));
const AffiliateCompanyPublicPage = lazyWithReload(() => import("@/pages/AffiliateCompanyPublicPage"));
const ReservationReview = lazyWithReload(() => import("@/pages/ReservationReview"));
const CompanyNpsReports = lazyWithReload(() => import("@/pages/CompanyNpsReports"));
const Profile = lazyWithReload(() => import("@/pages/Profile"));
const Leads = lazyWithReload(() => import("@/pages/Leads"));
const Affiliates = lazyWithReload(() => import("@/pages/Affiliates"));
const Users = lazyWithReload(() => import("@/pages/Users"));
const Login = lazyWithReload(() => import("@/pages/Login"));
const ResetPassword = lazyWithReload(() => import("@/pages/ResetPassword"));
const AccessDenied = lazyWithReload(() => import("@/pages/AccessDenied"));
const CompanyPublicPage = lazyWithReload(() => import("@/pages/CompanyPublicPage"));
const SystemHealth = lazyWithReload(() => import("@/pages/SystemHealth"));
const NotFound = lazyWithReload(() => import("@/pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Keep polling only while the tab is active so background tab switches
      // do not overwrite in-progress form state when the user returns.
      refetchIntervalInBackground: false,
    },
  },
});

function PanelPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-[320px] w-full rounded-lg" />
        <Skeleton className="h-[320px] w-full rounded-lg" />
      </div>
    </div>
  );
}

function AuthPageSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

function SuspenseRoute({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  return <Suspense fallback={fallback}>{children}</Suspense>;
}

function SuperadminRoute({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute allowedRoles={["superadmin"]}>
      <AppLayout>
        <SuspenseRoute fallback={<PanelPageSkeleton />}>{children}</SuspenseRoute>
      </AppLayout>
    </ProtectedRoute>
  );
}

function CompanyAdminRoute({
  allowedRoles,
  requiredCompanyPermission,
  requiredCompanyFeature,
  children,
}: {
  allowedRoles: AppRole[];
  requiredCompanyPermission?: CompanyPanelPermission;
  requiredCompanyFeature?: CompanyFeatureKey;
  children: ReactNode;
}) {
  const content = (
    <AppLayout>
      <SuspenseRoute fallback={<PanelPageSkeleton />}>{children}</SuspenseRoute>
    </AppLayout>
  );

  return (
    <ProtectedRoute allowedRoles={allowedRoles}>
      <CompanySlugProvider>
        <CompanyPermissionRouteGate requiredCompanyPermission={requiredCompanyPermission}>
          <CompanyFeatureRouteGate
            requiredCompanyFeature={requiredCompanyFeature}
            loadingFallback={<PanelPageSkeleton />}
          >
            {content}
          </CompanyFeatureRouteGate>
        </CompanyPermissionRouteGate>
      </CompanySlugProvider>
    </ProtectedRoute>
  );
}

function CompanyPermissionRouteGate({
  requiredCompanyPermission,
  children,
}: {
  requiredCompanyPermission?: CompanyPanelPermission;
  children: ReactNode;
}) {
  const location = useLocation();
  const { hasPermission, permissionsLoading } = useCompanyPermissions();
  const locationState = location.state as { fromLogin?: boolean } | null;

  if (!requiredCompanyPermission) return <>{children}</>;
  if (permissionsLoading) return <PanelPageSkeleton />;
  if (!hasPermission(requiredCompanyPermission)) {
    return <Navigate to={locationState?.fromLogin ? "/" : "/acesso-negado"} replace />;
  }

  return <>{children}</>;
}

function HomeRedirect() {
  const { profile, roles, loading } = useAuth();

  if (loading) return null;
  if (roles.includes("superadmin")) return <Navigate to="/dashboard" replace />;
  if (profile?.company_id) {
    return <CompanySlugRedirect companyId={profile.company_id} />;
  }
  return <Navigate to="/acesso-negado" replace />;
}

function CompanySlugRedirect({ companyId }: { companyId: string }) {
  const { data: company, isLoading } = useQuery({
    queryKey: ["company-slug-redirect", companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("companies" as any)
        .select("slug")
        .eq("id", companyId)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  if (isLoading) return null;
  if (!company) return <Navigate to="/acesso-negado" replace />;
  return <Navigate to={`/${company.slug}/admin`} replace />;
}

function CompanyAdminHome() {
  const { slug } = useParams<{ slug: string }>();
  const { hasPermission, permissionsLoading } = useCompanyPermissions();

  if (permissionsLoading) {
    return <PanelPageSkeleton />;
  }

  if (hasPermission("dashboard_view")) {
    return <Dashboard />;
  }

  if (slug && hasPermission("checkins_view")) {
    return <Navigate to={`/${slug}/admin/check-ins`} replace />;
  }

  if (slug && hasPermission("reservations_view")) {
    return <Navigate to={`/${slug}/admin/reservas`} replace />;
  }

  if (slug && hasPermission("calendar_view")) {
    return <Navigate to={`/${slug}/admin/calendario`} replace />;
  }

  if (slug && hasPermission("waitlist_view")) {
    return <Navigate to={`/${slug}/admin/fila`} replace />;
  }

  return <Navigate to="/acesso-negado" replace />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppErrorBoundary>
        <Toaster />
        <Sonner />
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <AuthProvider>
            <Routes>
              <Route
                path="/login"
                element={
                  <SuspenseRoute fallback={<AuthPageSkeleton />}>
                    <Login />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/redefinir-senha"
                element={
                  <SuspenseRoute fallback={<AuthPageSkeleton />}>
                    <ResetPassword />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/cadastro"
                element={<Navigate to="/login" replace />}
              />
              <Route
                path="/acesso-negado"
                element={
                  <SuspenseRoute fallback={<AuthPageSkeleton />}>
                    <AccessDenied />
                  </SuspenseRoute>
                }
              />

              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <HomeRedirect />
                  </ProtectedRoute>
                }
              />

              <Route
                path="/dashboard"
                element={
                  <SuperadminRoute>
                    <Dashboard />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/empresas"
                element={
                  <SuperadminRoute>
                    <Companies />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/empresas/:id"
                element={
                  <SuperadminRoute>
                    <Companies />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/usuarios"
                element={
                  <SuperadminRoute>
                    <Users />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/configuracoes"
                element={
                  <SuperadminRoute>
                    <SettingsPage />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/notificacoes"
                element={
                  <SuperadminRoute>
                    <AdminNotifications />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/logs"
                element={
                  <SuperadminRoute>
                    <AuditLogs />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/integracoes"
                element={
                  <SuperadminRoute>
                    <AdminIntegrations />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/financeiro"
                element={
                  <SuperadminRoute>
                    <AdminFinance />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/financeiro/empresa/:companyId"
                element={
                  <SuperadminRoute>
                    <AdminCompanyBillingPreview />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/perfil"
                element={
                  <SuperadminRoute>
                    <Profile />
                  </SuperadminRoute>
                }
              />
              <Route
                path="/saude"
                element={
                  <SuperadminRoute>
                    <SystemHealth />
                  </SuperadminRoute>
                }
              />

              <Route
                path="/:slug/f/:code"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <AffiliateCompanyPublicPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <CompanyPublicPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/fila"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <PublicWaitlistPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/fila/:code"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <WaitlistTracking />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/reserva/:code"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <ReservationTracking />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/avaliacao/:token"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <ReservationReview />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/pagamento/:paymentToken"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <PublicReservationPayment />
                  </SuspenseRoute>
                }
              />

              <Route
                path="/:slug/admin"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <CompanyAdminHome />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/relatorios/demanda-conversao"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="dashboard_view"
                    requiredCompanyFeature="advanced_reports"
                  >
                    <DemandConversionReport />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/relatorios/comparecimento-perdas"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="dashboard_view"
                    requiredCompanyFeature="advanced_reports"
                  >
                    <AttendanceLossesReport />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/relatorios/ocupacao-capacidade"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="dashboard_view"
                    requiredCompanyFeature="advanced_reports"
                  >
                    <OccupancyCapacityReport />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/relatorios/recorrencia"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="leads_view"
                    requiredCompanyFeature="advanced_reports"
                  >
                    <CustomerRecurrenceReport />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/check-ins"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="checkins_view"
                  >
                    <OperatorTodayReservations />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/reservas"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="reservations_view"
                  >
                    <Reservations />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/mesas"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="tables_view"
                  >
                    <TableMap />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/calendario"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="calendar_view"
                  >
                    <CalendarView />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/automacoes"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="automations_view"
                  >
                    <CompanyAutomations />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/pagamentos-antecipados"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="settings_view"
                    requiredCompanyFeature="reservation_prepayment"
                  >
                    <CompanyPrepayments />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/financeiro"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <CompanyBilling />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/eventos"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="events_view"
                  >
                    <CompanyEvents />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/configuracoes"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="settings_view"
                  >
                    <CompanySettings />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/fila"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="waitlist_view"
                  >
                    <CompanyWaitlist />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/usuarios"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="users_view"
                  >
                    <CompanyUsers />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/perfil"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <Profile />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/avaliacoes"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "superadmin"]}
                    requiredCompanyPermission="nps_view"
                    requiredCompanyFeature="nps_surveys"
                  >
                    <CompanyNpsReports />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/leads"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="leads_view"
                  >
                    <Leads />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/filiados"
                element={
                  <CompanyAdminRoute
                    allowedRoles={["admin", "operator", "superadmin"]}
                    requiredCompanyPermission="affiliates_view"
                  >
                    <Affiliates />
                  </CompanyAdminRoute>
                }
              />

              <Route
                path="*"
                element={
                  <SuspenseRoute fallback={<PublicPageSkeleton />}>
                    <NotFound />
                  </SuspenseRoute>
                }
              />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </AppErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

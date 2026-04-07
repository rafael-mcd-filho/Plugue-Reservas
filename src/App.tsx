import { lazy, Suspense, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { CompanySlugProvider } from "@/contexts/CompanySlugContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import BuildVersionBadge from "@/components/BuildVersionBadge";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import { supabase } from "@/integrations/supabase/client";

type AppRole = "superadmin" | "admin" | "operator";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Reservations = lazy(() => import("@/pages/Reservations"));
const TableMap = lazy(() => import("@/pages/TableMap"));
const CalendarView = lazy(() => import("@/pages/CalendarView"));
const Companies = lazy(() => import("@/pages/Companies"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const CompanySettings = lazy(() => import("@/pages/CompanySettings"));
const CompanyEvents = lazy(() => import("@/pages/CompanyEvents"));
const CompanyAutomations = lazy(() => import("@/pages/CompanyAutomations"));
const CompanyUsers = lazy(() => import("@/pages/CompanyUsers"));
const CompanyWaitlist = lazy(() => import("@/pages/CompanyWaitlist"));
const PublicWaitlistPage = lazy(() => import("@/pages/PublicWaitlistPage"));
const WaitlistTracking = lazy(() => import("@/pages/WaitlistTracking"));
const ReservationTracking = lazy(() => import("@/pages/ReservationTracking"));
const Leads = lazy(() => import("@/pages/Leads"));
const Users = lazy(() => import("@/pages/Users"));
const Login = lazy(() => import("@/pages/Login"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const Signup = lazy(() => import("@/pages/Signup"));
const AccessDenied = lazy(() => import("@/pages/AccessDenied"));
const CompanyPublicPage = lazy(() => import("@/pages/CompanyPublicPage"));
const SystemHealth = lazy(() => import("@/pages/SystemHealth"));
const NotFound = lazy(() => import("@/pages/NotFound"));
const DevToolbar = lazy(() => import("@/components/DevToolbar"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
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

function PublicPageSkeleton() {
  return (
    <div className="min-h-screen bg-secondary">
      <div className="h-16 bg-[#130D06]" />
      <div className="bg-[#130D06] px-4 pb-10 pt-8">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <Skeleton className="h-7 w-24 bg-white/10" />
            <Skeleton className="h-12 w-3/4 bg-white/10" />
            <Skeleton className="h-5 w-11/12 bg-white/10" />
            <Skeleton className="h-5 w-2/3 bg-white/10" />
            <div className="flex flex-wrap gap-2 pt-2">
              <Skeleton className="h-8 w-28 rounded-full bg-white/10" />
              <Skeleton className="h-8 w-24 rounded-full bg-white/10" />
              <Skeleton className="h-8 w-36 rounded-full bg-white/10" />
            </div>
          </div>
          <div className="space-y-3">
            <Skeleton className="h-14 w-full rounded-full bg-white/10" />
            <Skeleton className="h-14 w-full rounded-full bg-white/10" />
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <Skeleton className="h-36 w-full rounded-lg" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
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
  children,
}: {
  allowedRoles: AppRole[];
  children: ReactNode;
}) {
  const content = (
    <AppLayout>
      <SuspenseRoute fallback={<PanelPageSkeleton />}>{children}</SuspenseRoute>
    </AppLayout>
  );

  return (
    <ProtectedRoute allowedRoles={allowedRoles}>
      <CompanySlugProvider>{content}</CompanySlugProvider>
    </ProtectedRoute>
  );
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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppErrorBoundary>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <AuthProvider>
            {DevToolbar ? (
              <Suspense fallback={null}>
                <DevToolbar />
              </Suspense>
            ) : null}
            <BuildVersionBadge />
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
                element={
                  <SuspenseRoute fallback={<AuthPageSkeleton />}>
                    <Signup />
                  </SuspenseRoute>
                }
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
                path="/saude"
                element={
                  <SuperadminRoute>
                    <SystemHealth />
                  </SuperadminRoute>
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
                path="/:slug/admin"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <Dashboard />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/reservas"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <Reservations />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/mesas"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <TableMap />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/calendario"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <CalendarView />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/automacoes"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <CompanyAutomations />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/eventos"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <CompanyEvents />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/configuracoes"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <CompanySettings />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/fila"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "operator", "superadmin"]}>
                    <CompanyWaitlist />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/usuarios"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <CompanyUsers />
                  </CompanyAdminRoute>
                }
              />
              <Route
                path="/:slug/admin/leads"
                element={
                  <CompanyAdminRoute allowedRoles={["admin", "superadmin"]}>
                    <Leads />
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

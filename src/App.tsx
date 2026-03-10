import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ReservationProvider } from "@/contexts/ReservationContext";
import { CompanySlugProvider } from "@/contexts/CompanySlugContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Reservations from "@/pages/Reservations";
import TableMap from "@/pages/TableMap";
import CalendarView from "@/pages/CalendarView";
import Companies from "@/pages/Companies";
import CompanyProfile from "@/pages/CompanyProfile";
import SettingsPage from "@/pages/Settings";
import CompanySettings from "@/pages/CompanySettings";
import CompanyAutomations from "@/pages/CompanyAutomations";
import CompanyUsers from "@/pages/CompanyUsers";
import Leads from "@/pages/Leads";
import Users from "@/pages/Users";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import AccessDenied from "@/pages/AccessDenied";
import CompanyPublicPage from "@/pages/CompanyPublicPage";
import DevToolbar from "@/components/DevToolbar";
import NotFound from "./pages/NotFound";
import { supabase } from "@/integrations/supabase/client";

const queryClient = new QueryClient();

function HomeRedirect() {
  const { profile, roles, loading } = useAuth();
  if (loading) return null;
  if (roles.includes('superadmin')) return <Navigate to="/dashboard" replace />;
  if (profile?.company_id) {
    return <CompanySlugRedirect companyId={profile.company_id} />;
  }
  return <Navigate to="/acesso-negado" replace />;
}

function CompanySlugRedirect({ companyId }: { companyId: string }) {
  const { data: company, isLoading } = useQuery({
    queryKey: ['company-slug-redirect', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies' as any)
        .select('slug')
        .eq('id', companyId)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });
  if (isLoading) return null;
  if (!company) return <Navigate to="/acesso-negado" replace />;
  return <Navigate to={`/${company.slug}/admin`} replace />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <DevToolbar />
          <Routes>
            {/* Global auth */}
            <Route path="/login" element={<Login />} />
            <Route path="/cadastro" element={<Signup />} />
            <Route path="/acesso-negado" element={<AccessDenied />} />

            <Route path="/" element={
              <ProtectedRoute><HomeRedirect /></ProtectedRoute>
            } />

            {/* Superadmin routes */}
            <Route path="/dashboard" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <AppLayout><Dashboard /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/empresas" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <AppLayout><Companies /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/empresas/:id" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <AppLayout><CompanyProfile /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/usuarios" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <AppLayout><Users /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/configuracoes" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <AppLayout><SettingsPage /></AppLayout>
              </ProtectedRoute>
            } />

            {/* Public company page: /:slug */}
            <Route path="/:slug" element={<CompanyPublicPage />} />


            {/* Company admin routes: /:slug/admin/* */}
            <Route path="/:slug/admin" element={
              <ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>
                <CompanySlugProvider>
                  <ReservationProvider>
                    <AppLayout><Dashboard /></AppLayout>
                  </ReservationProvider>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/reservas" element={
              <ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>
                <CompanySlugProvider>
                  <ReservationProvider>
                    <AppLayout><Reservations /></AppLayout>
                  </ReservationProvider>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/mesas" element={
              <ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>
                <CompanySlugProvider>
                  <ReservationProvider>
                    <AppLayout><TableMap /></AppLayout>
                  </ReservationProvider>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/calendario" element={
              <ProtectedRoute allowedRoles={['admin', 'operator', 'superadmin']}>
                <CompanySlugProvider>
                  <ReservationProvider>
                    <AppLayout><CalendarView /></AppLayout>
                  </ReservationProvider>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/automacoes" element={
              <ProtectedRoute allowedRoles={['admin', 'superadmin']}>
                <CompanySlugProvider>
                  <AppLayout><CompanyAutomations /></AppLayout>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/configuracoes" element={
              <ProtectedRoute allowedRoles={['admin', 'superadmin']}>
                <CompanySlugProvider>
                  <AppLayout><CompanySettings /></AppLayout>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/usuarios" element={
              <ProtectedRoute allowedRoles={['admin', 'superadmin']}>
                <CompanySlugProvider>
                  <AppLayout><CompanyUsers /></AppLayout>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />
            <Route path="/:slug/admin/leads" element={
              <ProtectedRoute allowedRoles={['admin', 'superadmin']}>
                <CompanySlugProvider>
                  <AppLayout><Leads /></AppLayout>
                </CompanySlugProvider>
              </ProtectedRoute>
            } />

          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

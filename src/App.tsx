import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ReservationProvider } from "@/contexts/ReservationContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Reservations from "@/pages/Reservations";
import TableMap from "@/pages/TableMap";
import CalendarView from "@/pages/CalendarView";
import Companies from "@/pages/Companies";
import CompanyProfile from "@/pages/CompanyProfile";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import AccessDenied from "@/pages/AccessDenied";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function HomeRedirect() {
  const { roles, loading } = useAuth();
  if (loading) return null;
  if (roles.includes('superadmin')) return <Navigate to="/empresas" replace />;
  return (
    <ReservationProvider>
      <AppLayout><Dashboard /></AppLayout>
    </ReservationProvider>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/cadastro" element={<Signup />} />
            <Route path="/acesso-negado" element={<AccessDenied />} />

            <Route path="/" element={
              <ProtectedRoute><HomeRedirect /></ProtectedRoute>
            } />
            <Route path="/reservas" element={
              <ProtectedRoute allowedRoles={['admin', 'operator']}>
                <ReservationProvider><AppLayout><Reservations /></AppLayout></ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/mesas" element={
              <ProtectedRoute allowedRoles={['admin', 'operator']}>
                <ReservationProvider><AppLayout><TableMap /></AppLayout></ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/calendario" element={
              <ProtectedRoute allowedRoles={['admin', 'operator']}>
                <ReservationProvider><AppLayout><CalendarView /></AppLayout></ReservationProvider>
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

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

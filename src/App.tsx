import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ReservationProvider } from "@/contexts/ReservationContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Reservations from "@/pages/Reservations";
import TableMap from "@/pages/TableMap";
import CalendarView from "@/pages/CalendarView";
import Companies from "@/pages/Companies";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import AccessDenied from "@/pages/AccessDenied";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/cadastro" element={<Signup />} />
            <Route path="/acesso-negado" element={<AccessDenied />} />

            {/* Protected routes */}
            <Route path="/" element={
              <ProtectedRoute>
                <ReservationProvider>
                  <AppLayout><Dashboard /></AppLayout>
                </ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/reservas" element={
              <ProtectedRoute>
                <ReservationProvider>
                  <AppLayout><Reservations /></AppLayout>
                </ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/mesas" element={
              <ProtectedRoute>
                <ReservationProvider>
                  <AppLayout><TableMap /></AppLayout>
                </ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/calendario" element={
              <ProtectedRoute>
                <ReservationProvider>
                  <AppLayout><CalendarView /></AppLayout>
                </ReservationProvider>
              </ProtectedRoute>
            } />
            <Route path="/empresas" element={
              <ProtectedRoute allowedRoles={['superadmin']}>
                <ReservationProvider>
                  <AppLayout><Companies /></AppLayout>
                </ReservationProvider>
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

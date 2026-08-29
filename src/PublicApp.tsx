import { Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import PublicPageSkeleton from '@/components/PublicPageSkeleton';
import CompanyPublicPage from '@/pages/CompanyPublicPage';
import { lazyWithReload } from '@/lib/lazyReload';

const PublicWaitlistPage = lazyWithReload(() => import('@/pages/PublicWaitlistPage'));
const WaitlistTracking = lazyWithReload(() => import('@/pages/WaitlistTracking'));
const ReservationTracking = lazyWithReload(() => import('@/pages/ReservationTracking'));
const PublicReservationPayment = lazyWithReload(() => import('@/pages/PublicReservationPayment'));
const AffiliateCompanyPublicPage = lazyWithReload(() => import('@/pages/AffiliateCompanyPublicPage'));
const ReservationReview = lazyWithReload(() => import('@/pages/ReservationReview'));
const NotFound = lazyWithReload(() => import('@/pages/NotFound'));

const publicQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      staleTime: 30_000,
    },
  },
});

function SuspenseRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PublicPageSkeleton />}>{children}</Suspense>;
}

export default function PublicApp() {
  return (
    <QueryClientProvider client={publicQueryClient}>
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
            <Routes>
              <Route
                path="/:slug/f/:code"
                element={
                  <SuspenseRoute>
                    <AffiliateCompanyPublicPage />
                  </SuspenseRoute>
                }
              />
              <Route path="/:slug" element={<CompanyPublicPage />} />
              <Route
                path="/:slug/fila"
                element={
                  <SuspenseRoute>
                    <PublicWaitlistPage />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/fila/:code"
                element={
                  <SuspenseRoute>
                    <WaitlistTracking />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/reserva/:code"
                element={
                  <SuspenseRoute>
                    <ReservationTracking />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/:slug/avaliacao/:token"
                element={
                  <SuspenseRoute>
                    <ReservationReview />
                  </SuspenseRoute>
                }
              />
              <Route
                path="/pagamento/:paymentToken"
                element={
                  <SuspenseRoute>
                    <PublicReservationPayment />
                  </SuspenseRoute>
                }
              />
              <Route
                path="*"
                element={
                  <SuspenseRoute>
                    <NotFound />
                  </SuspenseRoute>
                }
              />
            </Routes>
          </BrowserRouter>
        </AppErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

import { Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import SystemFavicon from '@/components/SystemFavicon';
import PublicPageSkeleton from '@/components/PublicPageSkeleton';
import CompanyPublicPage from '@/pages/CompanyPublicPage';
import { lazyWithReload } from '@/lib/lazyReload';
import { isPublicApplicationPath } from '@/lib/publicRoutes';

const PublicWaitlistPage = lazyWithReload(() => import('@/pages/PublicWaitlistPage'));
const WaitlistTracking = lazyWithReload(() => import('@/pages/WaitlistTracking'));
const ReservationTracking = lazyWithReload(() => import('@/pages/ReservationTracking'));
const PublicReservationPayment = lazyWithReload(() => import('@/pages/PublicReservationPayment'));
const AffiliateCompanyPublicPage = lazyWithReload(() => import('@/pages/AffiliateCompanyPublicPage'));
const ReservationReview = lazyWithReload(() => import('@/pages/ReservationReview'));
const PlatformTerms = lazyWithReload(() => import('@/pages/PlatformTerms'));
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

function PublicTermsRouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const firstSegment = pathname.split('/').filter(Boolean)[0];
  // A wildcard alone loses route ranking to paths such as /:slug/fila.
  // Reserve the entire terms prefix before a company page can be mounted.
  if (firstSegment === 'termos-de-uso' && !isPublicApplicationPath(pathname)) {
    return <SuspenseRoute><NotFound /></SuspenseRoute>;
  }
  return <>{children}</>;
}

export default function PublicApp() {
  return (
    <QueryClientProvider client={publicQueryClient}>
      <SystemFavicon />
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
            <PublicTermsRouteBoundary>
            <Routes>
              <Route path="/termos-de-uso" element={<SuspenseRoute><PlatformTerms /></SuspenseRoute>} />
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
            </PublicTermsRouteBoundary>
          </BrowserRouter>
        </AppErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
  componentStack: string | null;
}

function shouldShowLoginAction(pathname: string) {
  if (!pathname) return true;

  const publicTrackingPatterns = [
    /^\/[^/]+\/fila(?:\/[^/]+)?\/?$/i,
    /^\/[^/]+\/reserva\/[^/]+\/?$/i,
  ];

  return !publicTrackingPatterns.some((pattern) => pattern.test(pathname));
}

export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Erro inesperado ao renderizar a aplicação.',
      componentStack: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('AppErrorBoundary caught an error', error, errorInfo);
    this.setState({
      componentStack: errorInfo.componentStack || null,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
    const showLoginAction = shouldShowLoginAction(pathname);

    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
        <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-destructive">
            Erro de renderização
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">A aplicação encontrou um erro</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            A tela branca foi substituída por esta captura para facilitar o diagnóstico.
          </p>
          <div className="mt-4 rounded-lg border bg-muted/40 p-4">
            <p className="text-sm font-medium text-foreground">Mensagem</p>
            <p className="mt-2 break-words font-mono text-sm text-muted-foreground">
              {this.state.errorMessage || 'Sem detalhes adicionais'}
            </p>
          </div>
          {this.state.componentStack && (
            <div className="mt-4 rounded-lg border bg-muted/40 p-4">
              <p className="text-sm font-medium text-foreground">Stack de componentes</p>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {this.state.componentStack}
              </pre>
            </div>
          )}
          <div className="mt-5 flex gap-3">
            <Button onClick={this.handleReload}>Recarregar</Button>
            {showLoginAction && (
              <Button variant="outline" onClick={() => window.location.assign('/login')}>
                Ir para login
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

/**
 * DEV ONLY — Barra de links rápidos para testar diferentes views.
 * Remover antes de ir para produção.
 */
export default function DevToolbar() {
  const { user, roles } = useAuth();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[9999] bg-foreground text-background text-xs flex items-center gap-3 px-4 py-2 overflow-x-auto">
      <span className="font-bold shrink-0">🛠 DEV:</span>

      {/* Public pages */}
      <span className="text-muted-foreground">Público:</span>
      <Link to="/bistro-do-chef" className="hover:underline text-primary">Bistrô (público)</Link>
      <Link to="/sushi-zen-house" className="hover:underline text-primary">Sushi (público)</Link>
      <Link to="/sabor-arte" className="hover:underline text-primary">Sabor&Arte (público)</Link>

      <span className="text-muted-foreground ml-2">Admin empresa:</span>
      <Link to="/bistro-do-chef/admin" className="hover:underline text-primary">Bistrô admin</Link>
      <Link to="/sushi-zen-house/admin" className="hover:underline text-primary">Sushi admin</Link>

      <span className="text-muted-foreground ml-2">Superadmin:</span>
      <Link to="/login" className="hover:underline text-primary">Login global</Link>
      <Link to="/dashboard" className="hover:underline text-primary">Dashboard</Link>
      <Link to="/empresas" className="hover:underline text-primary">Empresas</Link>

      {user && (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {user.email} [{roles.join(',')}]
        </span>
      )}
    </div>
  );
}

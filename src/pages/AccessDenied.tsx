import { Link } from 'react-router-dom';
import { ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function AccessDenied() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-none shadow-sm text-center">
        <CardContent className="pt-12 pb-8 space-y-4">
          <div className="flex justify-center">
            <div className="p-3 rounded-lg bg-destructive/10">
              <ShieldX className="h-8 w-8 text-destructive" />
            </div>
          </div>
          <h1 className="text-xl font-bold">
            Acesso Negado
          </h1>
          <p className="text-muted-foreground">
            Você não tem permissão para acessar esta página. Entre em contato com o administrador.
          </p>
          <Button asChild className="mt-4">
            <Link to="/">Voltar ao Início</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

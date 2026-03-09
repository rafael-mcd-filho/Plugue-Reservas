import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { UtensilsCrossed, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !email || !password) {
      toast.error('Preencha todos os campos');
      return;
    }
    if (password.length < 6) {
      toast.error('A senha deve ter pelo menos 6 caracteres');
      return;
    }
    setLoading(true);
    const { error } = await signUp(email, password, fullName);
    setLoading(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success('Conta criada! Verifique seu email para confirmar.');
      navigate('/login');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-none shadow-lg">
        <CardHeader className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="p-3 rounded-2xl bg-primary/10">
              <UtensilsCrossed className="h-8 w-8 text-primary" />
            </div>
          </div>
          <div>
            <CardTitle className="text-2xl" style={{ fontFamily: 'var(--font-display)' }}>
              Reserva<span className="text-primary">Fácil</span>
            </CardTitle>
            <CardDescription className="mt-2">Crie sua conta para acessar o sistema</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="fullName">Nome completo</Label>
              <Input
                id="fullName"
                type="text"
                placeholder="Seu nome completo"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                autoComplete="name"
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div>
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                placeholder="Mínimo 6 caracteres"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Criar Conta
            </Button>
          </form>
          <p className="text-sm text-center text-muted-foreground mt-6">
            Já tem conta?{' '}
            <Link to="/login" className="text-primary hover:underline font-medium">
              Entrar
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

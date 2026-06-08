import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2, MapPin, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import { removePublicCompanyIcons, syncPublicCompanyIcons } from '@/lib/publicCompanyIcons';
import { isValidCompanySlug } from '@/lib/validation';

interface PublicReviewData {
  company_id: string;
  company_name: string;
  company_logo_url: string | null;
  status: 'pending' | 'submitted' | 'expired';
  ask_ambiance: boolean;
  ask_food: boolean;
  ask_return: boolean;
  intro_message: string | null;
}

type ReviewStep = 'ambiance' | 'food' | 'return' | 'recommend' | 'comment' | 'done';

function getNpsCategory(score: number): 'promoter' | 'passive' | 'detractor' {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

function getCommentPrompt(score: number): { title: string; placeholder: string } {
  const category = getNpsCategory(score);
  if (category === 'promoter') {
    return {
      title: 'Que alegria! Quer deixar um elogio ou contar o que mais te marcou?',
      placeholder: 'Conte o que você mais gostou...',
    };
  }
  if (category === 'passive') {
    return {
      title: 'Faltou pouco pra nota 10! O que deixaria sua experiência ainda melhor?',
      placeholder: 'Nos conte o que poderia ser diferente...',
    };
  }
  return {
    title: 'Poxa, sentimos muito que não tenha sido como esperava. O que podemos melhorar?',
    placeholder: 'Nos conte o que aconteceu ou o que poderíamos ter feito diferente...',
  };
}

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hovered, setHovered] = useState(0);

  return (
    <div className="flex justify-center gap-3" role="group" aria-label="Avaliação em estrelas">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`${star} estrela${star > 1 ? 's' : ''}`}
          onClick={() => onChange(star)}
          onMouseEnter={() => setHovered(star)}
          onMouseLeave={() => setHovered(0)}
          className="transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
        >
          <Star
            className={`h-10 w-10 transition-colors ${
              star <= (hovered || value)
                ? 'fill-amber-400 text-amber-400'
                : 'text-muted-foreground/30'
            }`}
          />
        </button>
      ))}
    </div>
  );
}

function ScoreSelector({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-between gap-1">
        {Array.from({ length: 11 }, (_, i) => i).map((score) => (
          <button
            key={score}
            type="button"
            aria-label={`Nota ${score}`}
            onClick={() => onChange(score)}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold transition-all hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              value === score
                ? score >= 9
                  ? 'bg-success text-success-foreground shadow-sm'
                  : score >= 7
                    ? 'bg-warning text-warning-foreground shadow-sm'
                    : 'bg-destructive text-destructive-foreground shadow-sm'
                : 'border border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
            }`}
          >
            {score}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Jamais</span>
        <span>Com certeza</span>
      </div>
    </div>
  );
}

export default function ReservationReview() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const slugIsValid = isValidCompanySlug(slug);

  const [step, setStep] = useState<ReviewStep>('ambiance');
  const [ambianceRating, setAmbianceRating] = useState(0);
  const [foodRating, setFoodRating] = useState(0);
  const [returnScore, setReturnScore] = useState<number | null>(null);
  const [recommendScore, setRecommendScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const { data: review, isLoading, error } = useQuery({
    queryKey: ['public-review', token],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_public_review_by_token', {
        _token: token!,
        _slug: slug!,
      });
      if (error) throw error;
      const rows = data as PublicReviewData[];
      return rows.length > 0 ? rows[0] : null;
    },
    enabled: slugIsValid && !!token,
    retry: false,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase as any).rpc('submit_public_review', {
        _token: token!,
        _ambiance_rating: review?.ask_ambiance ? ambianceRating || null : null,
        _food_rating: review?.ask_food ? foodRating || null : null,
        _return_score: review?.ask_return ? returnScore : null,
        _recommend_score: recommendScore,
        _comment: comment.trim() || null,
        _visitor_id: getVisitorId(),
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.result === 'already_answered') {
        throw new Error('already_answered');
      }
      return row;
    },
    onSuccess: () => {
      setStep('done');
    },
    onError: (err: any) => {
      if (err.message === 'already_answered') {
        setStep('done');
        return;
      }
      toast.error('Não foi possível enviar a avaliação. Tente novamente.');
    },
  });

  useEffect(() => {
    syncPublicCompanyIcons(review?.company_logo_url ?? null);
    return () => removePublicCompanyIcons();
  }, [review?.company_logo_url]);

  useEffect(() => {
    if (!review || review.status !== 'pending') return;
    if (review.ask_ambiance) { setStep('ambiance'); return; }
    if (review.ask_food) { setStep('food'); return; }
    if (review.ask_return) { setStep('return'); return; }
    setStep('recommend');
  }, [review]);

  function handleNext() {
    if (step === 'ambiance') {
      if (review?.ask_food) { setStep('food'); return; }
      if (review?.ask_return) { setStep('return'); return; }
      setStep('recommend');
      return;
    }
    if (step === 'food') {
      if (review?.ask_return) { setStep('return'); return; }
      setStep('recommend');
      return;
    }
    if (step === 'return') {
      setStep('recommend');
      return;
    }
    if (step === 'recommend') {
      setStep('comment');
      return;
    }
    if (step === 'comment') {
      submitMutation.mutate();
    }
  }

  function canAdvance(): boolean {
    if (step === 'ambiance') return ambianceRating > 0;
    if (step === 'food') return foodRating > 0;
    if (step === 'return') return returnScore !== null;
    if (step === 'recommend') return recommendScore !== null;
    return true;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!slugIsValid || error || !review) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md border border-border shadow-sm">
          <CardContent className="space-y-4 py-10 text-center">
            <MapPin className="mx-auto h-12 w-12 text-muted-foreground" />
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">Link indisponível</h1>
              <p className="text-sm text-muted-foreground">
                Este link de avaliação não foi encontrado.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (review.status === 'expired') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-md border border-border shadow-sm">
          <CardContent className="space-y-4 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Star className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight">Link expirado</h1>
              <p className="text-sm text-muted-foreground">
                Este link de avaliação expirou. Obrigado pela sua visita!
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (review.status === 'submitted' || step === 'done') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            {review.company_logo_url && (
              <img src={review.company_logo_url} alt={review.company_name} className="mx-auto h-12 w-12 rounded-md object-cover" />
            )}
            <h1 className="text-xl font-bold">{review.company_name}</h1>
          </div>
          <Card className="border border-border shadow-sm">
            <CardContent className="space-y-4 py-10 text-center">
              <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
              <div className="space-y-1">
                <h2 className="text-lg font-bold">Avaliação enviada!</h2>
                <p className="text-sm text-muted-foreground">
                  Obrigado pelo seu retorno. Ele é muito importante para continuarmos melhorando.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const commentPrompt = recommendScore !== null ? getCommentPrompt(recommendScore) : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          {review.company_logo_url && (
            <img src={review.company_logo_url} alt={review.company_name} className="mx-auto h-12 w-12 rounded-md object-cover" />
          )}
          <h1 className="text-xl font-bold">{review.company_name}</h1>
          <p className="text-sm text-muted-foreground">
            {review.intro_message ?? 'Conta pra gente como foi! Leva menos de 1 minuto e é anônimo.'}
          </p>
        </div>

        <Card className="border border-border shadow-sm">
          <CardContent className="space-y-6 p-6">
            {step === 'ambiance' && (
              <div className="space-y-6 text-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Ambiente</p>
                  <h2 className="text-lg font-semibold">Como foi o nosso ambiente?</h2>
                </div>
                <StarRating value={ambianceRating} onChange={setAmbianceRating} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Não gostei</span>
                  <span>Amei</span>
                </div>
              </div>
            )}

            {step === 'food' && (
              <div className="space-y-6 text-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Comida</p>
                  <h2 className="text-lg font-semibold">E a comida, o que achou?</h2>
                </div>
                <StarRating value={foodRating} onChange={setFoodRating} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Não gostei</span>
                  <span>Amei</span>
                </div>
              </div>
            )}

            {step === 'return' && (
              <div className="space-y-6 text-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Fidelidade</p>
                  <h2 className="text-lg font-semibold">Qual a chance de você voltar?</h2>
                </div>
                <ScoreSelector value={returnScore} onChange={setReturnScore} />
              </div>
            )}

            {step === 'recommend' && (
              <div className="space-y-6 text-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">NPS</p>
                  <h2 className="text-lg font-semibold">E de indicar a gente pra um amigo?</h2>
                </div>
                <ScoreSelector value={recommendScore} onChange={setRecommendScore} />
              </div>
            )}

            {step === 'comment' && commentPrompt && (
              <div className="space-y-4">
                <div className="space-y-1 text-center">
                  <h2 className="text-base font-semibold leading-snug">{commentPrompt.title}</h2>
                  <p className="text-xs text-muted-foreground">Sua avaliação é anônima.</p>
                </div>
                <Textarea
                  placeholder={commentPrompt.placeholder}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={4}
                  maxLength={1000}
                  className="resize-none"
                />
                <p className="text-right text-xs text-muted-foreground">{comment.length}/1000</p>
              </div>
            )}

            <Button
              className="w-full"
              onClick={handleNext}
              disabled={!canAdvance() || submitMutation.isPending}
            >
              {submitMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {step === 'comment' ? 'Enviar avaliação' : 'Continuar'}
            </Button>

            {step === 'comment' && (
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => submitMutation.mutate()}
                disabled={submitMutation.isPending}
              >
                Pular e enviar
              </Button>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Avaliação anônima · Seus dados pessoais não são compartilhados
        </p>
      </div>
    </div>
  );
}

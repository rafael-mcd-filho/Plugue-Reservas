import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ExternalLink, Heart, Loader2, MapPin, Sparkles, Star } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { getVisitorId } from '@/hooks/useFunnelTracking';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { useFaviconOverride } from '@/lib/publicCompanyIcons';
import { isValidCompanySlug } from '@/lib/validation';

interface PublicReviewData {
  company_id: string;
  company_name: string;
  company_logo_url: string | null;
  status: 'pending' | 'submitted' | 'expired';
  ask_ambiance: boolean;
  ask_food: boolean;
  ask_service?: boolean;
  ask_return: boolean;
  intro_message: string | null;
  google_review_url: string | null;
}

type RatingStep = 'food' | 'service' | 'ambiance';
type ReviewStep = 'intro' | RatingStep | 'recommend' | 'comment' | 'thanks' | 'google';

interface StepConfig {
  id: RatingStep;
  label: string;
  title: string;
  value: number;
}

function getCommentPrompt(score: number, companyName: string) {
  if (score >= 9) {
    return {
      title: 'Ficamos felizes em saber disso ❤',
      text: `O que você mais gostou da sua experiência na ${companyName}?`,
      placeholder: 'Conte para a gente o que tornou sua experiência especial...',
    };
  }

  return {
    title: 'Queremos melhorar sua experiência 🙏',
    text: 'Conta pra gente o que podemos fazer melhor na sua próxima visita.',
    placeholder: 'Escreva aqui sua sugestão, crítica ou comentário...',
  };
}

function getSafeExternalUrl(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function StarRating({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [hovered, setHovered] = useState(0);
  const activeValue = hovered || value;

  return (
    <div className="flex justify-center gap-2 sm:gap-3" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((star) => {
        const selected = star <= activeValue;

        return (
          <button
            key={star}
            type="button"
            aria-label={`${star} estrela${star > 1 ? 's' : ''}`}
            aria-pressed={value === star}
            onClick={() => onChange(star)}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            className={cn(
              'rounded-xl p-1.5 transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
              selected ? 'scale-105 bg-primary/10 shadow-[0_10px_24px_rgba(42,88,164,0.16)]' : 'hover:scale-105 hover:bg-muted',
            )}
          >
            <Star
              className={cn(
                'h-9 w-9 transition-all duration-200 sm:h-10 sm:w-10',
                selected ? 'fill-primary text-primary drop-shadow-sm' : 'text-muted-foreground/30',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function ScoreSelector({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-11 gap-1.5">
        {Array.from({ length: 11 }, (_, i) => i).map((score) => {
          const selected = value === score;

          return (
            <button
              key={score}
              type="button"
              aria-label={`Nota ${score}`}
              aria-pressed={selected}
              onClick={() => onChange(score)}
              className={cn(
                'flex aspect-square min-w-0 items-center justify-center rounded-lg text-xs font-bold transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:text-sm',
                selected
                  ? 'scale-105 bg-primary text-primary-foreground shadow-[0_10px_22px_rgba(42,88,164,0.22)] ring-2 ring-primary/20'
                  : 'border border-border bg-white text-muted-foreground hover:-translate-y-0.5 hover:border-primary/40 hover:text-foreground hover:shadow-sm',
              )}
            >
              {score}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-xs font-medium text-muted-foreground">
        <span>Não indicaria</span>
        <span>Indicaria com certeza</span>
      </div>
    </div>
  );
}

function PrivacyNotice() {
  return (
    <p className="px-4 text-center text-[11px] font-medium leading-5 text-muted-foreground">
      Avaliação anônima • Seus dados pessoais não são compartilhados
    </p>
  );
}

export default function ReservationReview() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const slugIsValid = isValidCompanySlug(slug);

  const [step, setStep] = useState<ReviewStep>('intro');
  const [ambianceRating, setAmbianceRating] = useState(0);
  const [foodRating, setFoodRating] = useState(0);
  const [serviceRating, setServiceRating] = useState(0);
  const [recommendScore, setRecommendScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const advanceTimerRef = useRef<number | null>(null);

  const { data: review, isLoading, error } = useQuery({
    queryKey: ['public-review', slug, token],
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

  const ratingSteps = useMemo<StepConfig[]>(() => {
    if (!review) return [];

    const steps: StepConfig[] = [];

    if (review.ask_food) {
      steps.push({
        id: 'food',
        label: 'COMIDA',
        title: 'Como foi a comida?',
        value: foodRating,
      });
    }

    if (review.ask_service !== false) {
      steps.push({
        id: 'service',
        label: 'ATENDIMENTO',
        title: 'Como foi o atendimento?',
        value: serviceRating,
      });
    }

    if (review.ask_ambiance) {
      steps.push({
        id: 'ambiance',
        label: 'AMBIENTE',
        title: 'Como foi o ambiente?',
        value: ambianceRating,
      });
    }

    return steps;
  }, [ambianceRating, foodRating, review, serviceRating]);

  const googleReviewUrl = getSafeExternalUrl(review?.google_review_url);
  const shouldOfferGoogleReview = recommendScore !== null && recommendScore >= 9 && !!googleReviewUrl;

  const questionSteps = useMemo<ReviewStep[]>(() => [...ratingSteps.map((item) => item.id), 'recommend'], [ratingSteps]);
  const questionIndex = questionSteps.indexOf(step);
  const showSurveyHeader = step !== 'intro' && step !== 'thanks' && step !== 'google';
  const progressTotal = questionSteps.length;
  const progressValue = questionIndex >= 0 ? Math.round(((questionIndex + 1) / progressTotal) * 100) : 100;
  const progressLabel = questionIndex >= 0 ? `Pergunta ${questionIndex + 1} de ${progressTotal}` : 'Comentário opcional';
  const currentRatingStep = ratingSteps.find((item) => item.id === step);
  const commentPrompt = recommendScore !== null && review ? getCommentPrompt(recommendScore, review.company_name) : null;

  const submitMutation = useMutation({
    mutationFn: async (commentOverride?: string) => {
      const nextComment = commentOverride ?? comment;
      const { data, error } = await (supabase as any).rpc('submit_public_review', {
        _token: token!,
        _ambiance_rating: review?.ask_ambiance ? ambianceRating || null : null,
        _food_rating: review?.ask_food ? foodRating || null : null,
        _service_rating: review?.ask_service !== false ? serviceRating || null : null,
        _return_score: null,
        _recommend_score: recommendScore,
        _comment: nextComment.trim() || null,
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
      setStep('thanks');
    },
    onError: (err: any) => {
      if (err.message === 'already_answered') {
        setStep('thanks');
        return;
      }
      toast.error('Não foi possível enviar a avaliação. Tente novamente.');
    },
  });

  useFaviconOverride(
    isLoading ? undefined : review?.company_logo_url ?? null,
    slug ? `company:${slug}` : undefined,
  );

  useEffect(() => {
    if (!review) return;
    setStep(review.status === 'pending' ? 'intro' : 'thanks');
  }, [review]);

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
    };
  }, []);

  function clearPendingAdvance() {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }

  function getNextStepAfter(currentStep: ReviewStep): ReviewStep {
    if (currentStep === 'intro') {
      return ratingSteps[0]?.id ?? 'recommend';
    }

    const ratingIndex = ratingSteps.findIndex((item) => item.id === currentStep);
    if (ratingIndex >= 0) {
      return ratingSteps[ratingIndex + 1]?.id ?? 'recommend';
    }

    if (currentStep === 'recommend') {
      return 'comment';
    }

    return currentStep;
  }

  function advanceFrom(currentStep: ReviewStep) {
    clearPendingAdvance();
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      setStep(getNextStepAfter(currentStep));
    }, 180);
  }

  function handleRatingSelect(stepId: RatingStep, value: number) {
    if (stepId === 'food') setFoodRating(value);
    if (stepId === 'service') setServiceRating(value);
    if (stepId === 'ambiance') setAmbianceRating(value);
    advanceFrom(stepId);
  }

  function handleRecommendSelect(value: number) {
    setRecommendScore(value);
    advanceFrom('recommend');
  }

  function goToNextStep() {
    clearPendingAdvance();

    if (step === 'intro') {
      setStep(ratingSteps[0]?.id ?? 'recommend');
      return;
    }

    if (step === 'comment') {
      submitMutation.mutate(comment);
      return;
    }

    if (step === 'thanks') {
      if (shouldOfferGoogleReview) {
        setStep('google');
        return;
      }
      window.close();
      return;
    }

    if (step === 'google') {
      if (googleReviewUrl) {
        window.open(googleReviewUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    setStep(getNextStepAfter(step));
  }

  function goBack() {
    clearPendingAdvance();

    if (submitMutation.isPending || step === 'intro' || step === 'thanks' || step === 'google') return;

    if (step === 'comment') {
      setStep('recommend');
      return;
    }

    if (step === 'recommend') {
      setStep(ratingSteps[ratingSteps.length - 1]?.id ?? 'intro');
      return;
    }

    const ratingIndex = ratingSteps.findIndex((item) => item.id === step);
    setStep(ratingIndex <= 0 ? 'intro' : ratingSteps[ratingIndex - 1].id);
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f7f4]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!slugIsValid || error || !review) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f7f4] p-6">
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
      <div className="flex min-h-screen items-center justify-center bg-[#f8f7f4] p-6">
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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f8f7f4] px-4 py-5 sm:p-6">
      <div className="w-full max-w-md space-y-4">
        {showSurveyHeader && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={goBack}
                disabled={submitMutation.isPending}
                className="h-9 gap-1.5 px-2 text-muted-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Voltar
              </Button>

              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm">
                {progressLabel}
              </span>
            </div>
            <Progress value={progressValue} className="h-2 bg-white" />
          </div>
        )}

        <Card className="overflow-hidden border border-border bg-white shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
          <CardContent className="min-h-[430px] p-0">
            <div key={step} className="flex min-h-[430px] flex-col justify-between p-6 animate-in fade-in-0 slide-in-from-right-2 zoom-in-95 duration-300">
              {step === 'intro' && (
                <div className="flex flex-1 flex-col justify-center space-y-7 text-center">
                  <div className="space-y-3">
                    {review.company_logo_url ? (
                      <img src={review.company_logo_url} alt={review.company_name} className="mx-auto h-14 w-14 rounded-lg object-cover shadow-sm" />
                    ) : (
                      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Heart className="h-7 w-7" />
                      </div>
                    )}
                    <p className="text-sm font-semibold text-muted-foreground">{review.company_name}</p>
                  </div>

                  <div className="space-y-3">
                    <h1 className="text-2xl font-bold leading-tight tracking-tight text-foreground">
                      Sua opinião é importante ❤
                    </h1>
                    <p className="mx-auto max-w-sm whitespace-pre-line text-sm leading-6 text-muted-foreground">
                      Queremos proporcionar experiências cada vez melhores para você.{'\n\n'}
                      Nossa pesquisa leva menos de 1 minuto e sua avaliação é totalmente anônima.
                    </p>
                  </div>

                  <Button type="button" size="lg" className="w-full" onClick={goToNextStep}>
                    Começar avaliação
                  </Button>
                </div>
              )}

              {currentRatingStep && (
                <div className="flex flex-1 flex-col justify-center space-y-7 text-center">
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">{currentRatingStep.label}</p>
                    <h2 className="text-2xl font-bold tracking-tight text-foreground">{currentRatingStep.title}</h2>
                  </div>

                  <div className="space-y-3">
                    <StarRating
                      value={currentRatingStep.value}
                      onChange={(value) => handleRatingSelect(currentRatingStep.id, value)}
                      label={`Avaliação de ${currentRatingStep.label.toLowerCase()}`}
                    />
                    <div className="flex justify-between px-1 text-xs font-medium text-muted-foreground">
                      <span>Não gostei</span>
                      <span>Amei</span>
                    </div>
                  </div>
                </div>
              )}

              {step === 'recommend' && (
                <div className="flex flex-1 flex-col justify-center space-y-7 text-center">
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">RECOMENDAÇÃO</p>
                    <h2 className="text-2xl font-bold leading-tight tracking-tight text-foreground">
                      De 0 a 10, qual a chance de você indicar a {review.company_name} para um amigo?
                    </h2>
                  </div>

                  <ScoreSelector value={recommendScore} onChange={handleRecommendSelect} />
                </div>
              )}

              {step === 'comment' && commentPrompt && (
                <div className="flex flex-1 flex-col justify-center space-y-5">
                  <div className="space-y-2 text-center">
                    <h2 className="text-2xl font-bold leading-tight tracking-tight text-foreground">{commentPrompt.title}</h2>
                    <p className="text-sm leading-6 text-muted-foreground">{commentPrompt.text}</p>
                  </div>

                  <div className="space-y-2">
                    <Textarea
                      placeholder={commentPrompt.placeholder}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      rows={5}
                      maxLength={1000}
                      className="resize-none rounded-xl border-border bg-[#fbfaf8]"
                    />
                    <p className="text-right text-xs text-muted-foreground">{comment.length}/1000</p>
                  </div>

                  <div className="space-y-2">
                    <Button type="button" size="lg" className="w-full" onClick={() => submitMutation.mutate(comment)} disabled={submitMutation.isPending}>
                      {submitMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Enviar avaliação
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full text-muted-foreground"
                      onClick={() => submitMutation.mutate('')}
                      disabled={submitMutation.isPending}
                    >
                      Pular e enviar
                    </Button>
                  </div>
                </div>
              )}

              {step === 'thanks' && (
                <div className="flex flex-1 flex-col justify-center space-y-7 text-center">
                  <CheckCircle2 className="mx-auto h-14 w-14 text-success" />
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight text-foreground">Obrigado pela sua avaliação ❤</h2>
                    <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">
                      Sua opinião nos ajuda a melhorar cada detalhe da experiência que oferecemos.
                    </p>
                  </div>
                  <Button type="button" size="lg" className="w-full" onClick={goToNextStep}>
                    {shouldOfferGoogleReview ? 'Continuar' : 'Finalizar'}
                  </Button>
                </div>
              )}

              {step === 'google' && (
                <div className="flex flex-1 flex-col justify-center space-y-7 text-center">
                  <Sparkles className="mx-auto h-14 w-14 text-primary" />
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight text-foreground">Sua opinião pode ajudar outras pessoas ⭐</h2>
                    <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">
                      Ficamos felizes em saber que você teve uma ótima experiência. Que tal compartilhar sua avaliação no Google?
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Button type="button" size="lg" className="w-full gap-2" onClick={goToNextStep}>
                      <ExternalLink className="h-4 w-4" />
                      ⭐ Avaliar no Google
                    </Button>
                    <Button type="button" variant="ghost" className="w-full text-muted-foreground" onClick={() => window.close()}>
                      Agora não
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <PrivacyNotice />
      </div>
    </div>
  );
}

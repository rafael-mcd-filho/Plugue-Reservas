/**
 * FunnelDebugPanel — painel de debug flutuante para o funil de conversão.
 *
 * Como ativar:
 *   Adicione ?funnel_debug=1 na URL da página pública, ex:
 *   http://localhost:5173/r/meu-restaurante?funnel_debug=1
 *
 * O painel só é montado quando o parâmetro estiver presente.
 * Em produção sem o parâmetro, o componente retorna null sem custo algum.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { FunnelDebugEvent, FunnelDebugEventType } from '@/hooks/useFunnelTracking';
import { STEP_LABELS } from '@/hooks/useFunnelTracking';

const MAX_EVENTS = 50;

const TYPE_CONFIG: Record<FunnelDebugEventType, { label: string; color: string; dot: string }> = {
  queued: { label: 'Na fila', color: 'text-info', dot: 'bg-info' },
  sent: { label: 'Enviado', color: 'text-success', dot: 'bg-success' },
  failed: { label: 'Falhou', color: 'text-destructive', dot: 'bg-destructive' },
  retry: { label: 'Tentando de novo', color: 'text-warning', dot: 'bg-warning' },
  discarded: { label: 'Descartado', color: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

interface LogEntry extends FunnelDebugEvent {
  id: number;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function FunnelDebugPanel() {
  const [visible, setVisible] = useState(true);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [active, setActive] = useState(false);
  const counterRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Verifica se o parâmetro de debug está na URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('funnel_debug') === '1') {
      setActive(true);
    }
  }, []);

  // Escuta os eventos emitidos pelo useFunnelTracking
  useEffect(() => {
    if (!active) return;

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FunnelDebugEvent>).detail;
      setEvents((prev) => {
        const next = [...prev, { ...detail, id: ++counterRef.current }];
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    window.addEventListener('funnel:debug', handler);
    return () => window.removeEventListener('funnel:debug', handler);
  }, [active]);

  // Auto-scroll para o último evento
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  if (!active) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-[9999] flex w-80 flex-col rounded-lg border border-border bg-card/95 shadow-md backdrop-blur-sm transition-[height,opacity] duration-200',
        !visible && 'h-10 overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-lg border-b border-border bg-foreground px-3 py-2 text-background">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
          <span className="text-xs font-semibold text-white">Funil Debug</span>
          {events.length > 0 && (
            <span className="rounded-full bg-background/15 px-1.5 py-0.5 text-xs font-medium text-background/85">
              {events.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEvents([])}
            className="rounded px-1.5 py-0.5 text-xs text-background/70 transition-colors hover:bg-background/10 hover:text-background"
            title="Limpar log"
          >
            Limpar
          </button>
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="rounded p-1 text-background/70 transition-colors hover:bg-background/10 hover:text-background"
            title={visible ? 'Minimizar' : 'Expandir'}
          >
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor">
              {visible
                ? <path d="M2 7h8v1H2z" />
                : <path d="M6 2L2 7h8L6 2z" />}
            </svg>
          </button>
        </div>
      </div>

      {/* Event log */}
      {visible && (
        <div className="flex max-h-72 flex-col overflow-y-auto p-2">
          {events.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Aguardando eventos do funil...
              <br />
              <span className="text-xs text-muted-foreground/80">Acesse a página pública e avance nas etapas</span>
            </p>
          ) : (
            <div className="space-y-1">
              {events.map((ev) => {
                const cfg = TYPE_CONFIG[ev.type];
                return (
                  <div
                    key={ev.id}
                    className={cn(
                      'flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs',
                      ev.type === 'sent' && 'bg-success-soft',
                      ev.type === 'queued' && 'bg-info-soft',
                      ev.type === 'retry' && 'bg-warning-soft',
                      ev.type === 'failed' && 'bg-destructive-soft',
                      ev.type === 'discarded' && 'bg-muted',
                    )}
                  >
                    <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', cfg.dot)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-foreground">
                          {STEP_LABELS[ev.step] ?? ev.step}
                        </span>
                        <span className={cn('shrink-0 font-medium', cfg.color)}>{cfg.label}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{ev.date}</span>
                        <span className="text-muted-foreground">{formatTime(ev.timestamp)}</span>
                      </div>
                      {ev.retryCount !== undefined && ev.type === 'retry' && (
                        <span className="text-warning">
                          Tentativa {ev.retryCount}/{5}
                        </span>
                      )}
                      {ev.errorMessage && (
                        <p className="truncate text-destructive" title={ev.errorMessage}>
                          {ev.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      {visible && (
        <div className="rounded-b-lg border-t border-border bg-muted/50 px-3 py-1.5">
          <p className="text-xs text-muted-foreground">
            Ativo via <code className="rounded bg-muted px-0.5 text-muted-foreground">?funnel_debug=1</code>
          </p>
        </div>
      )}
    </div>
  );
}
